import webpush from 'web-push'
import { config } from './config.js'
import { cloudStore } from './storage.js'
import { getWebPushConfig, type WebPushConfigReason } from './pushConfig.js'

const webPushConfig = getWebPushConfig()
if (webPushConfig.configured) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, webPushConfig.publicKey!, Buffer.from(config.VAPID_PRIVATE_KEY!.trim(), 'base64url').toString('base64url'))
}

const webPushConfigErrors: Record<WebPushConfigReason, string> = {
  missing_public_key: 'VAPID 未配置：缺少公钥',
  missing_private_key: 'VAPID 未配置：缺少私钥',
  invalid_keys: 'VAPID 配置无效：请检查公私钥格式',
  key_mismatch: 'VAPID 公私钥不匹配：请使用同一组密钥'
}

const PUSH_CONCURRENCY = 4
const PUSH_SOCKET_TIMEOUT_MS = 10_000

export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface DailyDigest { date: string; title: string; body: string; taskCount: number }
export interface DailyDigestTask { id: string; title?: string; dueDate?: string | null; dateRange?: { start: string; end: string } | null; completed?: boolean; deletedAt?: string | null }
export interface DailyDigestData { tasks: DailyDigestTask[]; settings?: { timezone?: string } | null }

function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function notificationUrl(path: string, appUrl?: string) {
  // Current notifications target the app homepage, optionally with a todo
  // query. Resolve that path inside the subscribed app directory, preserving
  // deployments such as /repo/ without accepting arbitrary redirect targets.
  if (!/^\/(?:\?|$)/.test(path)) throw new Error('通知链接必须指向应用首页')
  if (!appUrl) return path
  const base = new URL(appUrl)
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('应用地址无效')
  base.search = ''; base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(path.slice(1), base).href
}

export async function sendPushPayload(payload: PushPayload) {
  const runtimeConfig = getWebPushConfig()
  if (!runtimeConfig.configured) throw new Error(webPushConfigErrors[runtimeConfig.reason ?? 'invalid_keys'])
  const data = await cloudStore.read()
  let sent = 0
  let failed = 0
  let nextSubscription = 0
  const expiredEndpoints: string[] = []
  async function sendNext() {
    while (nextSubscription < data.subscriptions.length) {
      const subscription = data.subscriptions[nextSubscription++]!
      if (!subscription.keys?.auth || !subscription.keys.p256dh) { failed += 1; continue }
      try {
        const url = notificationUrl(payload.url, subscription.appUrl)
        await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify({ ...payload, url }), { timeout: PUSH_SOCKET_TIMEOUT_MS })
        sent += 1
      } catch (error: any) {
        failed += 1
        console.error('[web-push]', subscription.endpoint, error?.statusCode ?? '', error instanceof Error ? error.message : String(error))
        if (error?.statusCode === 404 || error?.statusCode === 410) expiredEndpoints.push(subscription.endpoint)
      }
    }
  }
  // A slow endpoint should not block every device or create unbounded requests.
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, data.subscriptions.length) }, sendNext))
  // Storage writes stay serial even when network sends run concurrently.
  for (const endpoint of expiredEndpoints) await cloudStore.removeSubscription(endpoint)
  return { sent, failed, subscriptions: data.subscriptions.length }
}

export function buildDailyDigest(data: DailyDigestData, now = new Date()): DailyDigest | null {
  const timezone = data.settings?.timezone ?? config.APP_TIMEZONE
  const date = localDate(now, timezone)
  const overdue = data.tasks.filter(task => !task.completed && !task.deletedAt && Boolean((task.dueDate && task.dueDate < date) || (task.dateRange?.end && task.dateRange.end < date)))
  const today = data.tasks.filter(task => !task.completed && !task.deletedAt && (task.dueDate === date || (task.dateRange?.start && task.dateRange.start <= date && task.dateRange.end >= date)))
  const tasks = [...overdue, ...today.filter(task => !overdue.some(overdueTask => overdueTask.id === task.id))]
  if (!tasks.length) return null
  const sections = [
    overdue.length ? ['逾期：', ...overdue.map(task => `• ${task.title ?? '未命名任务'}`)] : [],
    today.length ? ['今天：', ...today.map(task => `• ${task.title ?? '未命名任务'}`)] : []
  ].filter(section => section.length)
  return { date, title: overdue.length ? `今天有 ${today.length} 项任务，${overdue.length} 项逾期` : `今天有 ${today.length} 项任务`, body: sections.flat().join('\n'), taskCount: tasks.length }
}

export async function sendDailySummary(now = new Date(), sender: (payload: PushPayload) => ReturnType<typeof sendPushPayload> = sendPushPayload) {
  await cloudStore.purgeExpiredTombstones(now)
  const digest = buildDailyDigest(await cloudStore.read(), now)
  if (!digest) return { date: localDate(now, config.APP_TIMEZONE), sent: 0, skipped: 'empty' as const }
  const { date } = digest
  if (!(await cloudStore.claimDailySummary(date))) return { date, sent: 0, skipped: 'duplicate' as const }
  try {
    const result = await sender({ title: digest.title, body: digest.body, url: '/', tag: `summary-${date}` })
    if (!result.sent) await cloudStore.releaseDailySummary(date)
    return { date, ...result, taskCount: digest.taskCount }
  } catch (error) {
    await cloudStore.releaseDailySummary(date)
    throw error
  }
}
