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
import { reconcileReminderTransitions } from './reminders/scheduler.js'
import { ensureDailySummarySchedule } from './reminders/dailySummaryScheduler.js'
import { rateLimitKey } from './rate-limit.js'

export const app = express()
app.set('trust proxy', 1); app.use(helmet()); app.use(cors({ origin: config.CORS_ORIGIN.split(',').map(v => v.trim()) })); app.use(express.json({ limit: '256kb' }))
// The Netlify Lambda adapter can omit request.ip. Using Draft-8 headers then
// crashes inside express-rate-limit before our route handlers are called.
const rateLimitOptions = { keyGenerator: rateLimitKey, standardHeaders: false, legacyHeaders: false }
const normalLimit = rateLimit({ windowMs: 60_000, limit: 120, ...rateLimitOptions })
const aiLimit = rateLimit({ windowMs: 60_000, limit: 30, ...rateLimitOptions })
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, ...rateLimitOptions })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const timestamp = z.string().datetime({ offset: true })
const reminderMode = z.enum(['auto', 'explicit', 'off'])
const reminderRecurrence = z.object({ unit: z.enum(['day', 'week']), interval: z.number().int().min(1).max(365), end: z.enum(['never', 'count', 'date']), count: z.number().int().min(1).max(365).nullable(), until: isoDate.nullable(), occurrence: z.number().int().min(1), timezone: z.string().min(1).max(100), countdown: z.boolean() })
const reminderItem = z.object({ id: z.string().min(1), at: timestamp, eventId: z.string().nullable().default(null), sentAt: timestamp.nullable().default(null), source: z.enum(['auto', 'explicit']), recurrence: reminderRecurrence.nullable().optional() })
function reminderAtFromStartTime(dueDate: unknown, startTime: unknown) {
  if (typeof dueDate !== 'string' || typeof startTime !== 'string') return null
  const value = new Date(`${dueDate}T${startTime}:00`)
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}
function inferReminderMode(value: Record<string, unknown>, dueDate: unknown, startTime: unknown) {
  if (value.reminderEnabled !== true || typeof value.reminderAt !== 'string') return 'off' as const
  const expected = reminderAtFromStartTime(dueDate, startTime)
  const reminderTime = Date.parse(value.reminderAt)
  return expected && Number.isFinite(reminderTime) && reminderTime === Date.parse(expected) ? 'auto' as const : 'explicit' as const
}
const taskValue = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value
  const { date: legacyDate, time: legacyTime, ...rest } = value as Record<string, unknown>
  const dueDate = rest.dueDate ?? legacyDate ?? null
  const startTime = rest.startTime ?? legacyTime ?? null
  const legacyReminders = rest.reminderEnabled === true && typeof rest.reminderAt === 'string' ? [{ id: 'legacy', at: rest.reminderAt, eventId: typeof rest.reminderEventId === 'string' ? rest.reminderEventId : null, sentAt: typeof rest.reminderSentAt === 'string' ? rest.reminderSentAt : null, source: rest.reminderMode === 'auto' ? 'auto' : 'explicit' }] : []
  const { reminderEnabled: _enabled, reminderAt: _at, reminderEventId: _event, reminderSentAt: _sent, ...clean } = rest
  return { ...clean, dueDate, startTime, reminderMode: rest.reminderMode ?? inferReminderMode(rest, dueDate, startTime), reminders: Array.isArray(rest.reminders) ? rest.reminders : legacyReminders }
}, z.object({
  id: z.string().uuid(), title: z.string().min(1).max(240), note: z.string().nullable().optional(), url: z.string().url().nullable().optional(),
  dueDate: isoDate.nullable().optional(), dateRange: z.object({ start: isoDate, end: isoDate }).nullable().optional(), startTime: clockTime.nullable().optional(), endTime: clockTime.nullable().optional(),
  reminderMode, reminders: z.array(reminderItem).default([]),
  pinned: z.boolean(), completed: z.boolean(), completedAt: timestamp.nullable().optional(), createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp.nullable().optional(),
  recurrence: z.null().optional(), source: z.enum(['manual', 'ai'])
}))
const draftValue = z.object({ id: z.string().uuid(), content: z.string().max(10_000), createdAt: timestamp, updatedAt: timestamp, aiParseStatus: z.enum(['idle', 'parsing', 'failed', 'parsed']), lastError: z.string().nullable().optional(), deletedAt: timestamp.nullable().optional() })
const profileValue = z.object({ id: z.string().uuid(), title: z.string().min(1).max(240).nullable(), content: z.string().min(1).max(50_000), createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp.nullable().optional() })
const settingsValue = z.object({ id: z.literal('settings'), dailySummaryTime: clockTime, timezone: z.string().min(1).max(100), schemaVersion: z.number().int().positive(), updatedAt: timestamp, lastSyncAt: timestamp.nullable().optional(), notificationPermission: z.enum(['default', 'denied', 'granted', 'unsupported']).optional() })
const syncChange = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('task'), value: taskValue }),
  z.object({ entity: z.literal('draft'), value: draftValue }),
  z.object({ entity: z.literal('profile'), value: profileValue }),
  z.object({ entity: z.literal('settings'), value: settingsValue })
])
app.use('/api', normalLimit)
app.post('/api/auth/login', authLimit, async (req, res) => { const password = z.string().min(1).max(200).safeParse(req.body?.password); if (!password.success) return res.status(400).json({ error: '请输入密码' }); const token = await login(password.data); if (!token) return res.status(401).json({ error: '密码错误' }); res.json({ token }) })
app.get('/api/health', requireAuth, async (_req, res) => { const secret = await cloudStore.getDeepseekSecret(); res.json({ ok: true, ai: { provider: config.AI_PROVIDER, model: config.AI_MODEL, configured: Boolean(secret || config.AI_API_KEY) } }) })
app.get('/api/ai-settings/deepseek', requireAuth, async (_req, res) => { const secret = await cloudStore.getDeepseekSecret(); res.json({ deepseek: secret ? { configured: true, maskedKey: maskedDeepseekKey(secret), updatedAt: secret.updatedAt } : { configured: Boolean(config.AI_API_KEY), maskedKey: config.AI_API_KEY ? '服务器环境变量' : null, updatedAt: null } }) })
app.put('/api/ai-settings/deepseek', requireAuth, aiLimit, async (req, res) => { try { const apiKey = validateDeepseekApiKey(req.body?.apiKey); await verifyDeepseekApiKey(apiKey); const existing = await cloudStore.getDeepseekSecret(); const secret = encryptDeepseekApiKey(apiKey, existing?.createdAt); await cloudStore.saveDeepseekSecret(secret); res.json({ deepseek: { configured: true, maskedKey: maskedDeepseekKey(secret), updatedAt: secret.updatedAt } }) } catch (error) { res.status(Number((error as any)?.status) || 400).json({ error: error instanceof Error ? error.message : '保存 DeepSeek API Key 失败' }) } })
app.delete('/api/ai-settings/deepseek', requireAuth, async (_req, res) => { await cloudStore.deleteDeepseekSecret(); res.json({ deepseek: { configured: Boolean(config.AI_API_KEY), maskedKey: config.AI_API_KEY ? '服务器环境变量' : null, updatedAt: null } }) })
app.post('/api/ai/parse', requireAuth, aiLimit, async (req, res) => { const input = z.object({ content: z.string().min(1).max(10_000), currentLocalDateTime: z.string(), timezone: z.string().min(1), locale: z.string().min(1), dailySummaryTime: clockTime.default('08:00') }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: '输入格式无效' }); try { res.json(await parseWithRetry(input.data)) } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI 解析失败' }) } })
app.post('/api/sync', requireAuth, async (req, res) => {
  const input = z.object({ changes: z.array(syncChange).max(1000) }).safeParse(req.body)
  if (!input.success) return res.status(400).json({ error: '同步数据无效' })
  try {
    const merged = await cloudStore.merge(input.data.changes)
    await reconcileReminderTransitions(merged.reminderTransitions)
    await ensureDailySummarySchedule()
    const { reminderTransitions: _internal, ...response } = merged
    res.json(response)
  } catch (error) { res.status(503).json({ error: error instanceof Error ? error.message : '提醒调度失败' }) }
})
app.post('/api/push/subscribe', requireAuth, async (req, res) => { const input = z.object({ endpoint: z.string().url(), keys: z.object({ auth: z.string(), p256dh: z.string() }), appUrl: z.string().url() }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: 'Push Subscription 无效' }); await cloudStore.addSubscription(input.data); res.status(200).json({ ok: true }) })
app.get('/api/push/subscription', requireAuth, async (req, res) => { const endpoint = z.string().url().safeParse(req.query.endpoint); if (!endpoint.success) return res.status(400).json({ error: 'Subscription endpoint 无效' }); res.json({ registered: await cloudStore.hasSubscription(endpoint.data) }) })
app.delete('/api/push/subscribe', requireAuth, async (req, res) => { const endpoint = z.string().url().safeParse(req.body?.endpoint); if (!endpoint.success) return res.status(400).json({ error: 'Subscription endpoint 无效' }); await cloudStore.removeSubscription(endpoint.data); res.status(200).json({ ok: true }) })
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
if (!process.env.SCF_RUNTIME && !process.env.NETLIFY && process.env.NETLIFY_DEV !== 'true') app.listen(config.PORT, () => console.log(`AI Todo API listening on :${config.PORT}`))
