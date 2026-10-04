import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import serverless from 'serverless-http'

const mocks = vi.hoisted(() => ({ merge: vi.fn(), available: vi.fn(), reconcile: vi.fn(), daily: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: { merge: mocks.merge } }))
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
  it('acknowledges a committed merge when scheduling needs maintenance retry', async () => {
    mocks.available.mockReturnValue(true); mocks.reconcile.mockRejectedValueOnce(new Error('scheduler unavailable'))
    const result = await sync([])
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ reminderSchedulingPending: true })
  })
  it('rejects impossible dates without modifying cloud data', async () => {
    expect((await sync([{ entity: 'task', value: { ...task, dueDate: '2026-02-30' } }])).statusCode).toBe(400)
    expect(mocks.merge).not.toHaveBeenCalled()
  })
})
