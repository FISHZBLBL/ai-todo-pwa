import { beforeEach, describe, expect, it, vi } from 'vitest'
const getTask = vi.fn(), markReminderSent = vi.fn(), sendPushPayload = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, markReminderSent } }))
vi.mock('../server/push', () => ({ sendPushPayload }))
vi.mock('@netlify/async-workloads', () => ({ asyncWorkloadFn: (value: unknown) => value, ErrorDoNotRetry: class ErrorDoNotRetry extends Error {}, ErrorRetryAfterDelay: class ErrorRetryAfterDelay extends Error {} }))
const reminder = (eventId = 'event-1', sentAt: string | null = null) => ({ id: 'r1', at: new Date(Date.now() - 1000).toISOString(), eventId, sentAt, source: 'explicit' as const })
const task = (value = reminder(), extra = {}) => ({ id: 'todo-1', title: '喝水', reminders: [value], completed: false, deletedAt: null, ...extra })
const event = (eventId = 'event-1') => ({ eventName: 'todo.reminder', eventData: { todoId: 'todo-1', reminderId: 'r1' }, eventId, attempt: 0, request: new Request('https://test'), step: { run: vi.fn(async (_: string, fn: () => unknown) => fn()) } })
describe('多提醒 workload', () => {
  beforeEach(() => { getTask.mockReset(); markReminderSent.mockReset(); sendPushPayload.mockReset(); markReminderSent.mockResolvedValue(true); sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 }) })
  it('只发送 eventId 与 reminderId 同时匹配的 reminder，并独立标记 sentAt', async () => { getTask.mockResolvedValue(task()); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).toHaveBeenCalledOnce(); expect(markReminderSent).toHaveBeenCalledWith('todo-1', 'r1', 'event-1') })
  it('stale、完成和删除事件不发送', async () => { const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); getTask.mockResolvedValue(task(reminder('other'))); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { completed: true })); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { deletedAt: '2026-01-01T00:00:00Z' })); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
  it('已发送 reminder 重试不会重复推送', async () => { getTask.mockResolvedValue(task(reminder('event-1', new Date().toISOString()))); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
})
