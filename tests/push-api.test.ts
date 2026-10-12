import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import serverless from 'serverless-http'
import jwt from 'jsonwebtoken'

const mocks = vi.hoisted(() => ({ pushConfig: vi.fn(), available: vi.fn(), addSubscription: vi.fn(), reconcile: vi.fn(), daily: vi.fn() }))
vi.mock('../server/pushConfig', () => ({ getWebPushConfig: mocks.pushConfig }))
vi.mock('../server/storage', () => ({ cloudStore: { addSubscription: mocks.addSubscription } }))
vi.mock('../server/reminders/scheduler', () => ({ isReminderSchedulingAvailable: mocks.available, reconcileReminderTransitions: mocks.reconcile }))
vi.mock('../server/reminders/dailySummaryScheduler', () => ({ ensureDailySummarySchedule: mocks.daily }))

let handler: ReturnType<typeof serverless>
let token: string
async function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
  return await handler({ httpMethod: method, path, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, requestContext: {}, body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false }, {}) as { statusCode: number; body: string; headers: Record<string, string> }
}
describe('runtime Push configuration API', () => {
  beforeAll(async () => {
    vi.stubEnv('NETLIFY', '1')
    mocks.pushConfig.mockReturnValue({ configured: false, publicKey: null, reason: 'missing_public_key' })
    handler = serverless((await import('../server/index')).app)
    const { config } = await import('../server/config')
    token = jwt.sign({ sub: 'single-user' }, config.JWT_SECRET, { issuer: 'ai-todo', expiresIn: '1m' })
  })
  afterAll(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pushConfig.mockReturnValue({ configured: true, publicKey: 'test-public-key', reason: null })
    mocks.available.mockReturnValue(true)
    mocks.addSubscription.mockResolvedValue({ reminderTransitions: [{ todoId: 'pending-task', oldEventIds: ['stopped-event'] }], firstSubscription: true })
    mocks.reconcile.mockResolvedValue(undefined); mocks.daily.mockResolvedValue(undefined)
  })
  it('returns the runtime public key and scheduler status without any private key', async () => {
    const result = await request('/api/push/config')
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ configured: true, publicKey: 'test-public-key', reason: null, schedulingAvailable: true })
    expect(JSON.parse(result.body)).not.toHaveProperty('privateKey')
    expect(result.headers['cache-control']).toContain('no-store')
  })
  it('requires a valid login before exposing deployment status', async () => {
    expect((await request('/api/push/config', 'GET', undefined, false)).statusCode).toBe(401)
  })
  it('returns a concrete configuration reason instead of a frontend build-time guess', async () => {
    mocks.pushConfig.mockReturnValue({ configured: false, publicKey: null, reason: 'key_mismatch' })
    expect(JSON.parse((await request('/api/push/config')).body)).toMatchObject({ configured: false, publicKey: null, reason: 'key_mismatch' })
  })
  it('a first subscription restores pending reminders with overdue scheduling enabled', async () => {
    const result = await request('/api/push/subscribe', 'POST', { endpoint: 'https://push.example.com/subscription', keys: { auth: 'test-auth', p256dh: 'test-public' }, appUrl: 'https://app.example.com/' })
    expect(result.statusCode).toBe(200)
    expect(mocks.reconcile).toHaveBeenCalledWith([{ todoId: 'pending-task', oldEventIds: ['stopped-event'] }], undefined, { includeOverdue: true })
    expect(mocks.daily).toHaveBeenCalled()
  })
})
