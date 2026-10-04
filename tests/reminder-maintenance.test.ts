import { beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.fn(), getTask = vi.fn(), setReminderEvent = vi.fn(), advanceReminderOccurrence = vi.fn()
const getDailySummaryScheduleState = vi.fn(), setDailySummaryScheduleIfCurrent = vi.fn()
const sendPushPayload = vi.fn(), sendDailySummary = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { read, getTask, setReminderEvent, advanceReminderOccurrence, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent } }))
vi.mock('../server/push', () => ({ sendPushPayload, sendDailySummary }))
vi.mock('@netlify/async-workloads', () => ({
  AsyncWorkloadsClient: class { constructor() { throw new Error('workloads must not create chained clients') } },
  asyncWorkloadFn: (value: unknown) => value,
  ErrorDoNotRetry: class extends Error {},
  ErrorRetryAfterDelay: class extends Error { constructor(options: { message: string }) { super(options.message) } }
}))

describe('独立提醒定时维护', () => {
  beforeEach(() => {
    vi.useRealTimers()
    for (const fn of [read, getTask, setReminderEvent, advanceReminderOccurrence, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent, sendPushPayload, sendDailySummary]) fn.mockReset()
    sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'existing-summary', scheduledFor: '2099-01-01T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
  })

  it('无限重复跨越 20 次仍由独立维护创建根事件', async () => {
    const task = { id: 'todo-1', title: '喝水', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: new Date(Date.now() - 1_000).toISOString(), eventId: null as string | null, sentAt: null, recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }] }
    read.mockImplementation(async () => ({ tasks: [task] }))
    getTask.mockImplementation(async () => structuredClone(task))
    setReminderEvent.mockImplementation(async (_todoId, _reminderId, at, eventId) => { if (task.reminders[0].at !== at || task.reminders[0].eventId) return false; task.reminders[0].eventId = eventId; return true })
    advanceReminderOccurrence.mockImplementation(async (_todoId, _reminderId, eventId, next, nextEventId) => { if (task.reminders[0].eventId !== eventId) return false; Object.assign(task.reminders[0], next, { eventId: nextEventId }); return true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: `root-${sender.send.mock.calls.length}` })) }
    const clock = vi.spyOn(Date, 'now')
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    for (let index = 0; index < 30; index += 1) {
      await maintainReminderSchedules(sender, new Date(task.reminders[0].at))
      const eventId = task.reminders[0].eventId!
      clock.mockReturnValue(Date.parse(task.reminders[0].at))
      await handleTodoReminder({ eventName: 'todo.reminder', eventData: { todoId: task.id, reminderId: 'r1' }, eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(task.reminders[0].eventId).toBeNull()
    }
    clock.mockRestore()
    expect(task.reminders[0].recurrence.occurrence).toBe(31)
    expect(sender.send).toHaveBeenCalledTimes(30)
    expect(sendPushPayload).toHaveBeenCalledTimes(30)
  })

  it('每日汇总跨越 20 天，完成后由根调度继续生成事件', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    let schedule: { eventId: string; scheduledFor: string; dailySummaryTime: string; timezone: string } | null = null
    read.mockResolvedValue({ tasks: [] })
    getDailySummaryScheduleState.mockImplementation(async () => ({ settings, schedule }))
    setDailySummaryScheduleIfCurrent.mockImplementation(async next => { schedule = next; return true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: `daily-root-${sender.send.mock.calls.length}` })) }
    const clock = vi.spyOn(Date, 'now')
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    let now = new Date('2026-10-03T23:00:00.000Z')
    for (let index = 0; index < 30; index += 1) {
      await maintainReminderSchedules(sender, now)
      const current = schedule!
      clock.mockReturnValue(Date.parse(current.scheduledFor))
      await handleDailySummary({ eventName: 'daily.summary', eventData: { scheduledFor: current.scheduledFor }, eventId: current.eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(schedule).toBeNull()
      now = new Date(Date.parse(current.scheduledFor) + 5 * 60_000)
    }
    clock.mockRestore()
    expect(sender.send).toHaveBeenCalledTimes(30)
    expect(sendDailySummary).toHaveBeenCalledTimes(30)
  })

  it('调度失败时留下未绑定提醒，下一次维护会重试', async () => {
    const task = { id: 'todo-1', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: '2026-10-04T00:00:00.000Z', eventId: null, sentAt: null, recurrence: {} }] }
    read.mockResolvedValue({ tasks: [task] })
    getTask.mockResolvedValue(task)
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn().mockResolvedValueOnce({ sendStatus: 'failed', eventId: 'failed' }).mockResolvedValue({ sendStatus: 'succeeded', eventId: 'recovered' }) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await expect(maintainReminderSchedules(sender, new Date('2026-10-04T00:05:00.000Z'))).rejects.toThrow('部分提醒调度失败')
    expect(setReminderEvent).not.toHaveBeenCalled()
    await maintainReminderSchedules(sender, new Date('2026-10-04T00:10:00.000Z'))
    expect(setReminderEvent).toHaveBeenCalledWith('todo-1', 'r1', task.reminders[0].at, 'recovered')
  })
  it('一次性未来提醒在同步调度失败后也能由维护任务恢复', async () => {
    const task = { id: 'todo-1', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: '2026-10-04T01:00:00.000Z', eventId: null, sentAt: null }] }
    read.mockResolvedValue({ tasks: [task] })
    getTask.mockResolvedValue(task)
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'recovered' })) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(sender, new Date('2026-10-04T00:05:00.000Z'))
    expect(setReminderEvent).toHaveBeenCalledWith('todo-1', 'r1', task.reminders[0].at, 'recovered')
  })
})
