import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import serverless from 'serverless-http'

const mocks = vi.hoisted(() => ({ merge: vi.fn(), read: vi.fn(), getTask: vi.fn(), setReminderEvent: vi.fn(), getDailySummaryScheduleState: vi.fn(), send: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: mocks }))
vi.mock('../server/auth', () => ({ login: vi.fn(), requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }))
vi.mock('@netlify/async-workloads', () => ({ AsyncWorkloadsClient: class { send = mocks.send } }))

describe('同步确认后的过期一次性提醒补排', () => {
  beforeAll(() => {
    vi.stubEnv('NETLIFY', '1')
    vi.stubGlobal('Netlify', { context: { url: 'https://example.netlify.app/api/sync', ip: '127.0.0.1' } })
  })
  afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('08:00 同步调度失败仍确认，08:03 到期的提醒在08:05维护时补排并绑定', async () => {
    const task = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '吃药', dueDate: null, startTime: null, reminderMode: 'explicit', reminders: [{ id: 'r1', at: '2026-10-04T00:03:00.000Z', eventId: null as string | null, sentAt: null, source: 'explicit' }], pinned: false, completed: false, source: 'manual', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' }
    mocks.merge.mockResolvedValue({ tasks: [task], drafts: [], profiles: [], settings: null, deletions: [], reminderTransitions: [{ todoId: task.id, oldEventIds: [] }] })
    mocks.read.mockResolvedValue({ tasks: [task] })
    mocks.getTask.mockImplementation(async () => structuredClone(task))
    mocks.setReminderEvent.mockImplementation(async (_todoId, _reminderId, _at, eventId) => { task.reminders[0].eventId = eventId; return true })
    mocks.getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'summary', scheduledFor: '2026-10-05T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    mocks.send.mockResolvedValueOnce({ sendStatus: 'failed', eventId: 'failed' }).mockResolvedValue({ sendStatus: 'succeeded', eventId: 'recovered' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T00:00:00.000Z'))
    const handler = serverless((await import('../server/index')).app)
    const result = await handler({ httpMethod: 'POST', path: '/api/sync', headers: { 'content-type': 'application/json' }, requestContext: {}, body: JSON.stringify({ changes: [{ entity: 'task', value: task }] }), isBase64Encoded: false }, {}) as { statusCode: number; body: string }
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ reminderSchedulingPending: true })
    expect(task.reminders[0].eventId).toBeNull()
    clock.mockReturnValue(Date.parse('2026-10-04T00:05:00.000Z'))
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(undefined, new Date(Date.now()))
    expect(mocks.send).toHaveBeenNthCalledWith(2, 'todo.reminder', { data: { todoId: task.id, reminderId: 'r1' }, delayUntil: Date.parse('2026-10-04T00:06:00.000Z') })
    expect(mocks.setReminderEvent).toHaveBeenCalledWith(task.id, 'r1', '2026-10-04T00:03:00.000Z', 'recovered')
    expect(task.reminders[0].eventId).toBe('recovered')
    clock.mockRestore()
  })
})
