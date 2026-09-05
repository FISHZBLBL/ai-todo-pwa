import { beforeEach, describe, expect, it, vi } from 'vitest'
const getTask = vi.fn(), markReminderSent = vi.fn(), advanceReminderOccurrence = vi.fn(), sendPushPayload = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, markReminderSent, advanceReminderOccurrence } }))
vi.mock('../server/push', () => ({ sendPushPayload }))
vi.mock('@netlify/async-workloads', () => ({ asyncWorkloadFn: (value: unknown) => value, ErrorDoNotRetry: class ErrorDoNotRetry extends Error {}, ErrorRetryAfterDelay: class ErrorRetryAfterDelay extends Error {} }))
const reminder = (eventId = 'event-1', sentAt: string | null = null) => ({ id: 'r1', at: new Date(Date.now() - 1000).toISOString(), eventId, sentAt, source: 'explicit' as const })
const task = (value = reminder(), extra = {}) => ({ id: 'todo-1', title: '喝水', reminders: [value], completed: false, deletedAt: null, ...extra })
const event = (eventId = 'event-1') => ({ eventName: 'todo.reminder', eventData: { todoId: 'todo-1', reminderId: 'r1' }, eventId, attempt: 0, request: new Request('https://test'), step: { run: vi.fn(async (_: string, fn: () => unknown) => fn()) } })
describe('多提醒 workload', () => {
  beforeEach(() => { getTask.mockReset(); markReminderSent.mockReset(); advanceReminderOccurrence.mockReset(); sendPushPayload.mockReset(); markReminderSent.mockResolvedValue(true); advanceReminderOccurrence.mockResolvedValue(true); sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 }) })
  it('只发送 eventId 与 reminderId 同时匹配的 reminder，并独立标记 sentAt', async () => { getTask.mockResolvedValue(task()); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).toHaveBeenCalledOnce(); expect(markReminderSent).toHaveBeenCalledWith('todo-1', 'r1', 'event-1') })
  it('stale、完成和删除事件不发送', async () => { const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); getTask.mockResolvedValue(task(reminder('other'))); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { completed: true })); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { deletedAt: '2026-01-01T00:00:00Z' })); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
  it('已发送 reminder 重试不会重复推送', async () => { getTask.mockResolvedValue(task(reminder('event-1', new Date().toISOString()))); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
  it('重复提醒发送后只安排下一次并原子推进', async () => {
    const value = { ...reminder(), recurrence: { unit: 'week', interval: 1, end: 'count', count: 12, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: true } }
    getTask.mockResolvedValue(task(value))
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'event-2' })) }
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never, sender)
    expect(sendPushPayload).toHaveBeenCalledWith(expect.objectContaining({ body: '还剩 11 周到期' }))
    expect(sender.send).toHaveBeenCalledWith('todo.reminder', expect.objectContaining({ data: { todoId: 'todo-1', reminderId: 'r1' } }))
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', expect.objectContaining({ recurrence: expect.objectContaining({ occurrence: 2 }) }), 'event-2')
  })
  it('有限重复的最后一次不再创建事件并自动结束生命周期', async () => {
    const value = { ...reminder(), recurrence: { unit: 'week', interval: 1, end: 'count', count: 12, until: null, occurrence: 12, timezone: 'Asia/Shanghai', countdown: true } }
    getTask.mockResolvedValue(task(value))
    const sender = { send: vi.fn() }
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never, sender)
    expect(sender.send).not.toHaveBeenCalled()
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', null, null)
  })
})
