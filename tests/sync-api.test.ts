import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import serverless from 'serverless-http'

const mocks = vi.hoisted(() => ({ merge: vi.fn(), read: vi.fn(), available: vi.fn(), reconcile: vi.fn(), daily: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: { merge: mocks.merge, read: mocks.read } }))
vi.mock('../server/auth', () => ({ login: vi.fn(), requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }))
vi.mock('../server/reminders/scheduler', () => ({ isReminderSchedulingAvailable: mocks.available, reconcileReminderTransitions: mocks.reconcile }))
vi.mock('../server/reminders/dailySummaryScheduler', () => ({ ensureDailySummarySchedule: mocks.daily }))

let handler: ReturnType<typeof serverless>
const task = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '保留排序', dueDate: null, startTime: null, reminderMode: 'off', reminders: [], pinned: false, sortOrder: 7, completed: false, source: 'manual', createdAt: '2026-10-01T08:00:00+08:00', updatedAt: '2026-10-02T08:00:00+08:00' }
async function sync(changes: unknown[]) {
  return await handler({ httpMethod: 'POST', path: '/api/sync', headers: { 'content-type': 'application/json' }, requestContext: {}, body: JSON.stringify({ changes }), isBase64Encoded: false }, {}) as { statusCode: number; body: string }
}
describe('sync HTTP contract', () => {
  beforeAll(async () => {
    vi.stubEnv('NETLIFY', '1')
    handler = serverless((await import('../server/index')).app)
  })
  afterAll(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.available.mockReturnValue(false)
    mocks.merge.mockResolvedValue({ tasks: [task], drafts: [], profiles: [], settings: null, deletions: [], reminderTransitions: [] })
    mocks.read.mockResolvedValue({ tasks: [task], drafts: [], profiles: [], settings: null, deletionVersions: [], subscriptions: [{ endpoint: 'https://push.example.test/private' }], deepseekSecret: { ciphertext: 'private' }, dailySummarySchedule: null })
    mocks.reconcile.mockResolvedValue(undefined); mocks.daily.mockResolvedValue(undefined)
  })
  it('preserves sortOrder and normalizes timestamps before merge', async () => {
    expect((await sync([{ entity: 'task', value: task }])).statusCode).toBe(200)
    expect(mocks.merge.mock.calls[0][0][0].value).toMatchObject({ sortOrder: 7, updatedAt: '2026-10-02T00:00:00.000Z' })
  })
  it('allows durable data sync outside the Netlify workload runtime', async () => {
    const result = await sync([])
    expect(result.statusCode).toBe(200)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.daily).not.toHaveBeenCalled()
  })
  it('reads an empty sync without cloud writes or reminder scheduling', async () => {
    mocks.available.mockReturnValue(true)
    const result = await sync([])
    expect(result.statusCode).toBe(200)
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.daily).not.toHaveBeenCalled()
    expect(JSON.parse(result.body)).toEqual({ tasks: [task], drafts: [], profiles: [], settings: null, deletions: [], reminderSchedulingPending: false })
  })
  it('schedules reminders after a committed task change', async () => {
    mocks.available.mockReturnValue(true)
    const transitions = [{ todoId: task.id, oldEventIds: [] }]
    mocks.merge.mockResolvedValueOnce({ tasks: [task], drafts: [], profiles: [], settings: null, deletions: [], reminderTransitions: transitions })
    expect((await sync([{ entity: 'task', value: task }])).statusCode).toBe(200)
    expect(mocks.merge).toHaveBeenCalledOnce()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.reconcile).toHaveBeenCalledWith(transitions)
    expect(mocks.daily).toHaveBeenCalledOnce()
  })
  it('reschedules the daily summary after settings change without scanning tasks', async () => {
    mocks.available.mockReturnValue(true)
    const settings = { id: 'settings', dailySummaryTime: '09:00', timezone: 'Asia/Shanghai', schemaVersion: 1, updatedAt: task.updatedAt }
    expect((await sync([{ entity: 'settings', value: settings }])).statusCode).toBe(200)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.daily).toHaveBeenCalledOnce()
  })
  it.each([
    ['draft', { id: task.id, content: '草稿内容', aiParseStatus: 'idle', createdAt: task.createdAt, updatedAt: task.updatedAt }],
    ['profile', { id: task.id, title: '资料', content: '资料内容', createdAt: task.createdAt, updatedAt: task.updatedAt }]
  ])('syncs %s changes without reminder scheduling', async (entity, value) => {
    mocks.available.mockReturnValue(true)
    expect((await sync([{ entity, value }])).statusCode).toBe(200)
    expect(mocks.merge).toHaveBeenCalledOnce()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.daily).not.toHaveBeenCalled()
  })
  it('acknowledges a committed merge when scheduling needs maintenance retry', async () => {
    mocks.available.mockReturnValue(true); mocks.reconcile.mockRejectedValueOnce(new Error('scheduler unavailable'))
    mocks.merge.mockResolvedValueOnce({ tasks: [task], drafts: [], profiles: [], settings: null, deletions: [], reminderTransitions: [{ todoId: task.id, oldEventIds: [] }] })
    const result = await sync([{ entity: 'task', value: task }])
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ reminderSchedulingPending: true })
  })
  it('rejects impossible dates without modifying cloud data', async () => {
    expect((await sync([{ entity: 'task', value: { ...task, dueDate: '2026-02-30' } }])).statusCode).toBe(400)
    expect(mocks.merge).not.toHaveBeenCalled()
  })
})
