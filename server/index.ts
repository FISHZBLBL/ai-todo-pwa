import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { config } from './config.js'
import { login, requireAuth } from './auth.js'
import { parseWithRetry, verifyDeepseekApiKey } from './ai/provider.js'
import { cloudStore } from './storage.js'
import { encryptDeepseekApiKey, maskedDeepseekKey, validateDeepseekApiKey } from './secrets.js'
import { isReminderSchedulingAvailable, reconcileReminderTransitions } from './reminders/scheduler.js'
import { ensureDailySummarySchedule } from './reminders/dailySummaryScheduler.js'
import { rateLimitKey } from './rate-limit.js'
import { clockTimeSchema, syncChangeSchema } from '../shared/syncSchema.js'
import { MAX_SYNC_CHANGES } from '../shared/limits.js'
import { getWebPushConfig } from './pushConfig.js'
import { alarmRequest } from './reminders/alarmClient.js'
import { bootstrapReminderSchedules } from './reminders/bootstrap.js'
import { deliverReminder, isSchedulerRequest } from './reminders/callback.js'

export const app = express()
app.set('trust proxy', false); app.use(helmet()); app.use(cors({ origin: config.CORS_ORIGIN.split(',').map(v => v.trim()) })); app.use(express.json({ limit: '256kb' }))
// The scheduler has its own narrow authentication; it never uses a user's JWT.
app.post('/api/reminders/deliver', deliverReminder)
// The Netlify Lambda adapter can omit request.ip. Using Draft-8 headers then
// crashes inside express-rate-limit before our route handlers are called.
const rateLimitOptions = { keyGenerator: rateLimitKey, standardHeaders: false, legacyHeaders: false }
const normalLimit = rateLimit({ windowMs: 60_000, limit: 120, ...rateLimitOptions })
const aiLimit = rateLimit({ windowMs: 60_000, limit: 30, ...rateLimitOptions })
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, ...rateLimitOptions })
const clockTime = clockTimeSchema
app.use('/api', normalLimit)
app.post('/api/reminders/bootstrap', (req, res, next) => isSchedulerRequest(req) ? next() : requireAuth(req, res, next), async (_req, res) => {
  try { res.json(await bootstrapReminderSchedules()) }
  catch { res.status(503).json({ error: '提醒迁移尚未完成，可安全重试' }) }
})
app.get('/api/reminders/status', requireAuth, async (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store')
  if (!isReminderSchedulingAvailable()) return res.json({ configured: false })
  try { res.json({ configured: true, ...await alarmRequest<Record<string, unknown>>('/status') }) }
  catch { res.status(503).json({ configured: true, error: '提醒定时服务暂不可用' }) }
})
app.post('/api/auth/login', authLimit, async (req, res) => { const password = z.string().min(1).max(200).safeParse(req.body?.password); if (!password.success) return res.status(400).json({ error: '请输入密码' }); const token = await login(password.data); if (!token) return res.status(401).json({ error: '密码错误' }); res.json({ token }) })
app.get('/api/health', requireAuth, async (_req, res) => { const secret = await cloudStore.getDeepseekSecret(); res.json({ ok: true, ai: { provider: config.AI_PROVIDER, model: config.AI_MODEL, configured: Boolean(secret || config.AI_API_KEY) } }) })
app.get('/api/ai-settings/deepseek', requireAuth, async (_req, res) => { const secret = await cloudStore.getDeepseekSecret(); res.json({ deepseek: secret ? { configured: true, maskedKey: maskedDeepseekKey(secret), updatedAt: secret.updatedAt } : { configured: Boolean(config.AI_API_KEY), maskedKey: config.AI_API_KEY ? '服务器环境变量' : null, updatedAt: null } }) })
app.put('/api/ai-settings/deepseek', requireAuth, aiLimit, async (req, res) => { try { const apiKey = validateDeepseekApiKey(req.body?.apiKey); await verifyDeepseekApiKey(apiKey); const existing = await cloudStore.getDeepseekSecret(); const secret = encryptDeepseekApiKey(apiKey, existing?.createdAt); await cloudStore.saveDeepseekSecret(secret); res.json({ deepseek: { configured: true, maskedKey: maskedDeepseekKey(secret), updatedAt: secret.updatedAt } }) } catch (error) { res.status(Number((error as any)?.status) || 400).json({ error: error instanceof Error ? error.message : '保存 DeepSeek API Key 失败' }) } })
app.delete('/api/ai-settings/deepseek', requireAuth, async (_req, res) => { await cloudStore.deleteDeepseekSecret(); res.json({ deepseek: { configured: Boolean(config.AI_API_KEY), maskedKey: config.AI_API_KEY ? '服务器环境变量' : null, updatedAt: null } }) })
app.post('/api/ai/parse', requireAuth, aiLimit, async (req, res) => { const input = z.object({ content: z.string().min(1).max(10_000), currentLocalDateTime: z.string(), timezone: z.string().min(1), locale: z.string().min(1), dailySummaryTime: clockTime.default('08:00') }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: '输入格式无效' }); try { res.json(await parseWithRetry(input.data)) } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI 解析失败' }) } })
app.post('/api/sync', requireAuth, async (req, res) => {
  const input = z.object({ changes: z.array(syncChangeSchema).max(MAX_SYNC_CHANGES) }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '同步数据无效' })
  try {
    let merged: Awaited<ReturnType<typeof cloudStore.merge>>
    if (input.data.changes.length) merged = await cloudStore.merge(input.data.changes)
    else {
      // Polling clients only need a snapshot. Avoid taking a write lock and
      // rewriting the entire cloud object when there is nothing to merge.
      const data = await cloudStore.read()
      merged = { tasks: data.tasks, drafts: data.drafts, profiles: data.profiles, settings: data.settings, deletions: data.deletionVersions, reminderTransitions: [] }
    }
    const schedulesChanged = input.data.changes.some(change => change.entity === 'task' || change.entity === 'settings')
    const schedulingAvailable = isReminderSchedulingAvailable()
    let reminderSchedulingPending = schedulesChanged && !schedulingAvailable
    if (schedulesChanged && schedulingAvailable) {
      try {
        if (merged.reminderTransitions.length) await reconcileReminderTransitions(merged.reminderTransitions, undefined, { includeOverdue: true })
        await ensureDailySummarySchedule()
      } catch {
        // The data merge succeeded. Clients keep this batch queued until the
        // event-driven scheduler durably acknowledges the reminders as well.
        reminderSchedulingPending = true
      }
    }
    const { reminderTransitions: _internal, ...response } = merged
    res.json({ ...response, reminderSchedulingPending })
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : '云端同步失败' }) }
})
app.get('/api/push/config', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.json({ ...getWebPushConfig(), schedulingAvailable: isReminderSchedulingAvailable() })
})
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const input = z.object({ endpoint: z.string().url(), keys: z.object({ auth: z.string(), p256dh: z.string() }), appUrl: z.string().url() }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: 'Push Subscription 无效' })
  const saved = await cloudStore.addSubscription(input.data)
  let reminderSchedulingPending = !isReminderSchedulingAvailable()
  if (isReminderSchedulingAvailable()) {
    try {
      await reconcileReminderTransitions(saved?.reminderTransitions ?? [], undefined, { includeOverdue: true })
      if (saved?.firstSubscription) await ensureDailySummarySchedule(undefined, new Date(), { recoverOverdueAfterMs: 0 })
      else await ensureDailySummarySchedule()
      // Subscription actions also resume any unbound future reminders and
      // adopt old pointers; no background state scanner is needed.
      await bootstrapReminderSchedules()
    } catch { reminderSchedulingPending = true }
  }
  res.status(200).json({ ok: true, reminderSchedulingPending })
})
app.get('/api/push/subscription', requireAuth, async (req, res) => { const endpoint = z.string().url().safeParse(req.query.endpoint); if (!endpoint.success) return res.status(400).json({ error: 'Subscription endpoint 无效' }); res.json({ registered: await cloudStore.hasSubscription(endpoint.data) }) })
app.delete('/api/push/subscribe', requireAuth, async (req, res) => {
  const endpoint = z.string().url().safeParse(req.body?.endpoint)
  if (!endpoint.success) return res.status(400).json({ error: 'Subscription endpoint 无效' })
  await cloudStore.removeSubscription(endpoint.data)
  let reminderSchedulingPending = false
  if (isReminderSchedulingAvailable()) {
    try { await bootstrapReminderSchedules() } catch { reminderSchedulingPending = true }
  }
  res.status(200).json({ ok: true, reminderSchedulingPending })
})
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
if (!process.env.SCF_RUNTIME && !process.env.NETLIFY && process.env.NETLIFY_DEV !== 'true') app.listen(config.PORT, () => console.log(`AI Todo API listening on :${config.PORT}`))
