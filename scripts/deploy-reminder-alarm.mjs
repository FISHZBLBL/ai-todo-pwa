#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const workerDirectory = join(root, 'cloudflare', 'reminder-alarm')
const wrangler = join(workerDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const configFile = join(root, '.env.reminders.local')
const workerName = 'ai-todo-reminder-alarm'
const callbackUrl = 'https://ai-todo-pwa.netlify.app/api/reminders/deliver'
const bootstrapUrl = 'https://ai-todo-pwa.netlify.app/api/reminders/bootstrap'
const commands = new Set(['prepare', 'deploy', 'check', 'bootstrap'])

function usage() {
  console.log('用法: node scripts/deploy-reminder-alarm.mjs prepare|deploy|check|bootstrap [--dry-run]')
  console.log('deploy 可加 --worker-url https://ai-todo-reminder-alarm.<账户子域>.workers.dev')
  console.log('--dry-run 仅验证参数并显示步骤，不读取密钥、写文件、运行 Wrangler 或访问网络。')
}

function workerUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Worker URL 格式无效') }
  if (url.protocol !== 'https:' || !new RegExp(`^${workerName}\\.[a-z0-9-]+\\.workers\\.dev$`).test(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error('Worker URL 必须是本项目的 HTTPS workers.dev 根地址')
  return url.origin
}

function argumentsFor(values) {
  if (!values.length || (values.length === 1 && ['--help', '-h'].includes(values[0]))) return { help: true }
  const [command, ...flags] = values
  if (!commands.has(command)) throw new Error('未知命令，请使用 prepare、deploy、check 或 bootstrap')
  let dryRun = false, url
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--dry-run' && !dryRun) dryRun = true
    else if (flags[index] === '--worker-url' && command === 'deploy' && url === undefined && flags[index + 1]) url = workerUrl(flags[++index])
    else throw new Error('未知、重复或不完整的参数')
  }
  return { command, dryRun, url }
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd ?? root, shell: false, windowsHide: true,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const parts = []
    let bytes = 0, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 300_000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) child.kill()
      else parts.push(chunk)
    })
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动所需命令，请检查 Node、Git 和项目依赖')) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0 || timedOut || bytes > 2 * 1024 * 1024) return reject(new Error(options.failure ?? '命令执行失败'))
      resolve(Buffer.concat(parts).toString('utf8'))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

async function readConfiguration(optional = false) {
  let text
  try {
    const info = await lstat(configFile)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('提醒配置必须是普通文件')
    text = await readFile(configFile, 'utf8')
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    if (error.code === 'ENOENT') throw new Error('请先运行 prepare，生成本地提醒配置')
    throw error
  }
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = /^(REMINDER_SCHEDULER_SECRET|REMINDER_SCHEDULER_URL)=(.*)$/.exec(line)
    if (!match || Object.hasOwn(values, match[1])) throw new Error('提醒配置包含未知或重复字段，请保留专用的两项配置')
    values[match[1]] = match[2].trim()
  }
  const secret = values.REMINDER_SCHEDULER_SECRET
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32 || Buffer.from(secret, 'base64url').toString('base64url') !== secret) throw new Error('已有提醒密钥格式无效；为避免意外轮换，脚本已停止')
  return { secret, url: values.REMINDER_SCHEDULER_URL ? workerUrl(values.REMINDER_SCHEDULER_URL) : undefined }
}

async function saveConfiguration(configuration, create = false) {
  await run('git', ['check-ignore', '--quiet', '--', '.env.reminders.local'], { failure: '.env.reminders.local 尚未被 Git 忽略，已停止保存密钥' })
  const text = `# 仅用于提醒定时服务；请勿提交或复制到聊天中。\nREMINDER_SCHEDULER_SECRET=${configuration.secret}\nREMINDER_SCHEDULER_URL=${configuration.url ?? ''}\n`
  await writeFile(configFile, text, { mode: 0o600, flag: create ? 'wx' : 'w' })
}

async function jsonRequest(url, { secret, method = 'GET' } = {}) {
  let response
  try {
    response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 120_000 : 20_000),
      headers: secret ? { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } : {},
      ...(method === 'POST' ? { body: '{}' } : {}) })
  } catch { throw new Error('服务连接失败或发生重定向，请检查部署地址和网络') }
  if (!response.ok) {
    await response.body?.cancel()
    if (url === bootstrapUrl && response.status === 503) throw new Error('Netlify 仍不可用（503）；请先恢复额度并发布新版后再执行 bootstrap')
    throw new Error(`服务检查失败（HTTP ${response.status}）；请检查部署和两端提醒密钥配置`)
  }
  try { return await response.json() } catch { throw new Error('服务没有返回预期的 JSON 响应') }
}

async function check(configuration) {
  if (!configuration.url) throw new Error('尚未保存 Worker URL，请先运行 deploy')
  const health = await jsonRequest(`${configuration.url}/health`)
  if (health.ready !== true) throw new Error('Worker 尚未就绪，请确认提醒密钥已设置')
  const status = await jsonRequest(`${configuration.url}/status`, { secret: configuration.secret })
  for (const key of ['active', 'dead', 'completed', 'cancelled']) if (!Number.isSafeInteger(status[key]) || status[key] < 0) throw new Error('定时服务状态格式异常')
  console.log(`Worker 健康与认证检查通过：active=${status.active}, dead=${status.dead}, completed=${status.completed}, cancelled=${status.cancelled}`)
}

async function main() {
  const args = argumentsFor(process.argv.slice(2))
  if (args.help) return usage()
  if (args.dryRun) {
    const plans = {
      prepare: '验证 Git 忽略规则；生成或复用 32 字节随机提醒密钥，保存到 .env.reminders.local。',
      deploy: '验证现有 Cloudflare 登录；Wrangler deploy；从成功输出提取 workers.dev URL；secret put 通过 stdin 设置密钥；检查 Worker。',
      check: '读取专用提醒配置；GET Worker /health 与经过认证的 /status。',
      bootstrap: '检查 Worker；显式 POST https://ai-todo-pwa.netlify.app/api/reminders/bootstrap，迁移已有提醒。'
    }
    console.log(`[dry-run] ${plans[args.command]}`)
    if (args.url) console.log(`Worker URL: ${args.url}`)
    return
  }
  if (args.command === 'prepare') {
    const existing = await readConfiguration(true)
    if (existing) console.log('已复用现有提醒密钥，没有轮换。')
    else { await saveConfiguration({ secret: randomBytes(32).toString('base64url') }, true); console.log('已生成 .env.reminders.local；密钥未显示。') }
    return
  }
  const configuration = await readConfiguration()
  if (args.command === 'deploy') {
    try { await access(wrangler) } catch { throw new Error('未安装本项目 Wrangler，请先 npm --prefix cloudflare/reminder-alarm install') }
    const baseArgs = ['--config', join(workerDirectory, 'wrangler.jsonc')]
    await run(process.execPath, [wrangler, 'whoami', '--json'], { cwd: workerDirectory, failure: 'Cloudflare 未登录或认证失败，请先手动运行 Wrangler login' })
    console.log('正在部署提醒 Worker…')
    const output = await run(process.execPath, [wrangler, 'deploy', ...baseArgs, '--name', workerName, '--var', `REMINDER_CALLBACK_URL:${callbackUrl}`], { cwd: workerDirectory, failure: 'Wrangler deploy 失败；请检查 Cloudflare 登录、账户权限及 Worker 配置' })
    // Wrangler deploy has no --json flag. Only accept this Worker's production URL.
    const matched = output.match(/https:\/\/ai-todo-reminder-alarm\.[a-z0-9-]+\.workers\.dev\b/g)
    const detectedUrl = matched?.length ? workerUrl(matched.at(-1)) : undefined
    if (args.url && detectedUrl && args.url !== detectedUrl) throw new Error('部署输出 URL 与 --worker-url 不一致，未设置密钥')
    const url = args.url ?? detectedUrl
    if (!url) throw new Error('部署成功但未识别 workers.dev 地址，请用 --worker-url 明确指定并重新运行 deploy')
    await saveConfiguration({ ...configuration, url })
    await run(process.execPath, [wrangler, 'secret', 'put', 'REMINDER_SCHEDULER_SECRET', ...baseArgs, '--name', workerName], { cwd: workerDirectory, input: `${configuration.secret}\n`, failure: 'Worker 已部署，但提醒密钥设置失败；配置已保留，可重新运行 deploy' })
    console.log(`Worker 已部署：${url}`)
    await check({ ...configuration, url })
    console.log('请将本地文件中的 URL 和同一密钥配置到 Netlify Functions 环境，并发布新版；完成后运行 bootstrap。')
    return
  }
  await check(configuration)
  if (args.command === 'bootstrap') {
    const result = await jsonRequest(bootstrapUrl, { method: 'POST', secret: configuration.secret })
    if (!Number.isSafeInteger(result.migrated) || result.migrated < 0) throw new Error('迁移接口返回内容异常，未能确认迁移结果')
    console.log(`已有提醒迁移完成：migrated=${result.migrated}${result.skipped === 'no-subscriptions' ? '，暂无推送订阅' : ''}。`)
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : '提醒部署辅助失败'); process.exitCode = 1 })
