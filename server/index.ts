import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { config } from './config.js'
import { login, requireAuth } from './auth.js'
import { parseWithRetry } from './ai/provider.js'
import { cloudStore } from './storage.js'
import { sendDueNotifications } from './push.js'

export const app = express()
app.set('trust proxy', 1); app.use(helmet()); app.use(cors({ origin: config.CORS_ORIGIN.split(',').map(v => v.trim()) })); app.use(express.json({ limit: '256kb' }))
const normalLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false })
const aiLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false })
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false })
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const timestamp = z.string().datetime({ offset: true })
const taskValue = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(240), note: z.string().nullable().optional(), url: z.string().url().nullable().optional(),
  date: isoDate.nullable().optional(), dateRange: z.object({ start: isoDate, end: isoDate }).nullable().optional(), time: clockTime.nullable().optional(), endTime: clockTime.nullable().optional(),
  pinned: z.boolean(), completed: z.boolean(), completedAt: timestamp.nullable().optional(), createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp.nullable().optional(),
  recurrence: z.null().optional(), source: z.enum(['manual', 'ai'])
})
const draftValue = z.object({ id: z.string().uuid(), content: z.string().max(10_000), createdAt: timestamp, updatedAt: timestamp, aiParseStatus: z.enum(['idle', 'parsing', 'failed', 'parsed']), lastError: z.string().nullable().optional(), deletedAt: timestamp.nullable().optional() })
const settingsValue = z.object({ id: z.literal('settings'), dailySummaryTime: clockTime, timezone: z.string().min(1).max(100), schemaVersion: z.number().int().positive(), updatedAt: timestamp, lastSyncAt: timestamp.nullable().optional(), notificationPermission: z.enum(['default', 'denied', 'granted', 'unsupported']).optional() })
const syncChange = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('task'), value: taskValue }),
  z.object({ entity: z.literal('draft'), value: draftValue }),
  z.object({ entity: z.literal('settings'), value: settingsValue })
])
app.use('/api', normalLimit)
app.post('/api/auth/login', authLimit, async (req, res) => { const password = z.string().min(1).max(200).safeParse(req.body?.password); if (!password.success) return res.status(400).json({ error: '请输入密码' }); const token = await login(password.data); if (!token) return res.status(401).json({ error: '密码错误' }); res.json({ token }) })
app.get('/api/health', requireAuth, (_req, res) => res.json({ ok: true, ai: { provider: config.AI_PROVIDER, model: config.AI_MODEL, configured: Boolean(config.AI_API_KEY) } }))
app.post('/api/ai/parse', requireAuth, aiLimit, async (req, res) => { const input = z.object({ content: z.string().min(1).max(10_000), currentLocalDateTime: z.string(), timezone: z.string().min(1), locale: z.string().min(1) }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: '输入格式无效' }); try { res.json(await parseWithRetry(input.data)) } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'AI 解析失败' }) } })
app.post('/api/sync', requireAuth, async (req, res) => { const input = z.object({ changes: z.array(syncChange).max(1000) }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: '同步数据无效' }); res.json(await cloudStore.merge(input.data.changes)) })
app.post('/api/push/subscribe', requireAuth, async (req, res) => { const input = z.object({ endpoint: z.string().url(), keys: z.object({ auth: z.string(), p256dh: z.string() }), appUrl: z.string().url() }).safeParse(req.body); if (!input.success) return res.status(400).json({ error: 'Push Subscription 无效' }); await cloudStore.addSubscription(input.data); res.status(204).end() })
app.post('/api/push/run-due', async (req, res) => { if (!config.CRON_SECRET || req.headers.authorization !== `Bearer ${config.CRON_SECRET}`) return res.status(401).json({ error: '未授权' }); try { res.json(await sendDueNotifications(req.body?.now ? new Date(req.body.now) : new Date())) } catch (error) { res.status(500).json({ error: (error as Error).message }) } })
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
if (!process.env.SCF_RUNTIME) app.listen(config.PORT, () => console.log(`AI Todo API listening on :${config.PORT}`))
