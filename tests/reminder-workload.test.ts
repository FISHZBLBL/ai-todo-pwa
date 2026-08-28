import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTask = vi.fn()
const markReminderSent = vi.fn()
const sendPushPayload = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, markReminderSent } }))
vi.mock('../server/push', () => ({ sendPushPayload }))

function event(eventId = 'event-1') {
  return {
    eventName: 'todo.reminder', eventData: { todoId: 'todo-1' }, eventId, attempt: 0, request: new Request('https://example.test'),
    sendEvent: vi.fn(), step: { run: vi.fn(async (_id: string, callback: () => unknown) => callback()), sleep: vi.fn() }
  } as any
}

describe('Todo reminder workload', () => {
  beforeEach(() => { getTask.mockReset(); markReminderSent.mockReset(); sendPushPayload.mockReset() })

  it('旧 eventId 到达时不发送', async () => {
    getTask.mockResolvedValue({ id: 'todo-1', title: '喝水', reminderEnabled: true, reminderAt: new Date(Date.now() - 1_000).toISOString(), reminderEventId: 'event-new', reminderSentAt: null, completed: false, deletedAt: null })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event('event-old'))
    expect(sendPushPayload).not.toHaveBeenCalled()
  })

  it('发送前重新读取任务，成功后记录 reminderSentAt', async () => {
    const task = { id: 'todo-1', title: '喝水', reminderEnabled: true, reminderAt: new Date(Date.now() - 1_000).toISOString(), reminderEventId: 'event-1', reminderSentAt: null, completed: false, deletedAt: null }
    getTask.mockResolvedValue(task)
    sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    markReminderSent.mockResolvedValue(true)
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    const workloadEvent = event()
    await handleTodoReminder(workloadEvent)
    expect(getTask).toHaveBeenCalledTimes(2)
    expect(sendPushPayload).toHaveBeenCalledWith(expect.objectContaining({ url: '/?todo=todo-1', tag: 'todo-todo-1-event-1' }))
    expect(markReminderSent).toHaveBeenCalledWith('todo-1', 'event-1')
  })

  it('已经发送过的事件重试时保持幂等', async () => {
    getTask.mockResolvedValue({ id: 'todo-1', reminderEnabled: true, reminderAt: new Date(Date.now() - 1_000).toISOString(), reminderEventId: 'event-1', reminderSentAt: new Date().toISOString(), completed: false, deletedAt: null })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event())
    expect(sendPushPayload).not.toHaveBeenCalled()
  })
})
