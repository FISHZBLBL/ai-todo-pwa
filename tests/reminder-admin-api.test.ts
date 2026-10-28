// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import serverless from 'serverless-http'
import { CosOperationError } from '../server/cos'

const mocks = vi.hoisted(() => ({ read: vi.fn(), bootstrap: vi.fn(), push: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: { read: mocks.read } }))
vi.mock('../server/reminders/bootstrap', () => ({ bootstrapReminderSchedules: mocks.bootstrap }))
vi.mock('../server/pushConfig', () => ({ getWebPushConfig: mocks.push }))
const secret = 'synthetic-reminder-admin-secret-1234567890'
let handler: ReturnType<typeof serverless>
async function request(path: string, method = 'GET', authenticated = true) {
  return await handler({ httpMethod: method, path, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${secret}` } : {}) }, requestContext: {}, body: method === 'POST' ? '{}' : undefined, isBase64Encoded: false }, {}) as { statusCode: number; body: string }
}
describe('private reminder preflight and migration diagnostics', () => {
  beforeAll(async () => {
    vi.stubEnv('NETLIFY', '1'); vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.test'); vi.stubEnv('REMINDER_SCHEDULER_SECRET', secret)
    mocks.push.mockReturnValue({ configured: false, publicKey: null, reason: 'missing_public_key' })
    handler = serverless((await import('../server/index')).app)
  })
  afterAll(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue({ tasks: [{ id: 'private-task', title: 'private title', reminders: [{ at: '2026-10-29T00:00:00Z', eventId: 'legacy-event', sentAt: null }, { at: '2026-10-29T01:00:00Z', eventId: null, sentAt: null }] }], subscriptions: [{ endpoint: 'https://private.example.test/push' }] })
    mocks.bootstrap.mockResolvedValue({ migrated: 1 }); mocks.push.mockReturnValue({ configured: true, publicKey: 'public-value', reason: null })
  })
  it('requires authentication before reading data or migrating', async () => {
    expect((await request('/api/reminders/preflight', 'GET', false)).statusCode).toBe(401)
    expect((await request('/api/reminders/bootstrap', 'POST', false)).statusCode).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.bootstrap).not.toHaveBeenCalled()
  })
  it('returns runtime configuration and counts without private task or subscription content', async () => {
    const result = await request('/api/reminders/preflight')
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ schedulingAvailable: true, webPush: { configured: true, reason: null }, tasks: 1, subscriptions: 1, pendingReminders: 2, unregisteredReminders: 1, legacyReminders: 1, invalidEventIds: 0 })
    expect(result.body).not.toContain('private'); expect(mocks.bootstrap).not.toHaveBeenCalled()
  })
  it('reports a failed COS operation without exposing response bodies or credentials', async () => {
    mocks.bootstrap.mockRejectedValueOnce(new CosOperationError('bucket-versioning', 403, 'AccessDenied'))
    const result = await request('/api/reminders/bootstrap', 'POST')
    expect(result.statusCode).toBe(503)
    expect(JSON.parse(result.body).diagnostics).toEqual({ code: 'cos_request_failed', operation: 'bucket-versioning', upstreamStatus: 403, serviceCode: 'AccessDenied' })
    mocks.bootstrap.mockRejectedValueOnce(new Error('private secret error detail'))
    expect(JSON.parse((await request('/api/reminders/bootstrap', 'POST')).body).diagnostics).toEqual({ code: 'reminder_operation_failed' })
  })
  it.each([
    ['COS 状态文件已被锁定，已停止写入', 'cos_state_locked'],
    ['COS 安全写入需要从未开启版本控制的存储桶', 'cos_unsafe_versioning']
  ])('keeps the safety failure visible without bypassing it: %s', async (message, code) => {
    mocks.bootstrap.mockRejectedValueOnce(new Error(message))
    expect(JSON.parse((await request('/api/reminders/bootstrap', 'POST')).body).diagnostics).toEqual({ code })
  })
})
