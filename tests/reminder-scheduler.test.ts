import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTask = vi.fn()
const setReminderEvent = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, setReminderEvent } }))

describe('单项提醒事件调度', () => {
  beforeEach(() => { getTask.mockReset(); setReminderEvent.mockReset() })

  it('只发送 todoId，并把 reminderAt 作为 delayUntil', async () => {
    const reminderAt = '2026-08-28T10:00:00.000Z'
    getTask.mockResolvedValue({ id: 'todo-1', reminderEnabled: true, reminderAt, reminderEventId: null, reminderSentAt: null, completed: false, deletedAt: null })
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'event-1' })) }
    const { reconcileReminder } = await import('../server/reminders/scheduler')
    await expect(reconcileReminder({ todoId: 'todo-1', oldEventIds: [] }, sender, Date.parse('2026-08-28T09:00:00.000Z'))).resolves.toEqual({ eventId: 'event-1' })
    expect(sender.send).toHaveBeenCalledWith('todo.reminder', { data: { todoId: 'todo-1' }, delayUntil: Date.parse(reminderAt) })
    expect(setReminderEvent).toHaveBeenCalledWith('todo-1', reminderAt, 'event-1')
  })

  it('修改提醒时先取消旧 eventId 再创建新事件', async () => {
    getTask.mockResolvedValue({ id: 'todo-1', reminderEnabled: true, reminderAt: '2026-08-28T11:00:00.000Z', reminderEventId: null, reminderSentAt: null, completed: false, deletedAt: null })
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel-command' : 'event-2' })) }
    const { reconcileReminder } = await import('../server/reminders/scheduler')
    await reconcileReminder({ todoId: 'todo-1', oldEventIds: ['event-1'] }, sender, Date.parse('2026-08-28T09:00:00.000Z'))
    expect(sender.send.mock.calls[0]).toEqual(['awl:delete-events', { data: { eventIds: ['event-1'] } }])
    expect(sender.send.mock.calls[1][0]).toBe('todo.reminder')
  })

  it('完成或删除的任务只取消旧事件，不创建新事件', async () => {
    getTask.mockResolvedValue({ id: 'todo-1', reminderEnabled: true, reminderAt: '2026-08-28T11:00:00.000Z', completed: true, deletedAt: null })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'cancel-command' })) }
    const { reconcileReminder } = await import('../server/reminders/scheduler')
    await expect(reconcileReminder({ todoId: 'todo-1', oldEventIds: ['event-1'] }, sender, Date.parse('2026-08-28T09:00:00.000Z'))).resolves.toEqual({ skipped: 'disabled' })
    expect(sender.send).toHaveBeenCalledOnce()
  })
})
