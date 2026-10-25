import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.fn(), getTask = vi.fn(), advanceReminderOccurrence = vi.fn()
const getDailySummaryScheduleState = vi.fn(), setDailySummaryScheduleIfCurrent = vi.fn()
const sendPushPayload = vi.fn(), sendDailySummary = vi.fn(), rootSend = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { read, getTask, advanceReminderOccurrence, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent } }))
vi.mock('../server/push', () => ({ sendPushPayload, sendDailySummary }))
vi.mock('../server/reminders/rootEventSender', () => ({ createRootEventSender: () => ({ send: rootSend }) }))

describe('到点事件直接续排，不依赖周期维护', () => {
  beforeEach(() => {
    vi.useRealTimers()
    for (const fn of [read, getTask, advanceReminderOccurrence, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent, sendPushPayload, sendDailySummary, rootSend]) fn.mockReset()
    sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    rootSend.mockImplementation(async () => ({ sendStatus: 'succeeded', eventId: `cf:next-${rootSend.mock.calls.length}` }))
    read.mockResolvedValue({ tasks: [{ id: 'active', completed: false, dueDate: '2099-01-01' }], subscriptions: [{}] })
  })
  afterEach(() => vi.restoreAllMocks())

  it('无限重复跨越 30 次均直接绑定下一次事件，没有扫描全部任务', async () => {
    const task = { id: 'todo-1', title: '喝水', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: new Date(Date.now() - 1_000).toISOString(), eventId: 'cf:initial', sentAt: null, recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }] }
    getTask.mockImplementation(async () => structuredClone(task))
    advanceReminderOccurrence.mockImplementation(async (_todoId, _reminderId, eventId, next, nextEventId) => { if (task.reminders[0].eventId !== eventId) return false; Object.assign(task.reminders[0], next, { eventId: nextEventId }); return true })
    const clock = vi.spyOn(Date, 'now')
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    for (let index = 0; index < 30; index += 1) {
      const eventId = task.reminders[0].eventId
      clock.mockReturnValue(Date.parse(task.reminders[0].at))
      await handleTodoReminder({ eventName: 'todo.reminder', eventData: { todoId: task.id, reminderId: 'r1' }, eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(task.reminders[0].eventId).not.toBe(eventId)
    }
    expect(task.reminders[0].recurrence.occurrence).toBe(31)
    expect(read).not.toHaveBeenCalled()
    expect(rootSend).toHaveBeenCalledTimes(30)
    expect(rootSend.mock.calls.every(([name]) => name === 'todo.reminder')).toBe(true)
    expect(sendPushPayload).toHaveBeenCalledTimes(30)
  })

  it('每日汇总连续 30 天从当前事件直接安排下一天', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    let schedule = { eventId: 'cf:initial-daily', scheduledFor: '2026-10-04T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockImplementation(async () => ({ settings, schedule, eligible: true }))
    setDailySummaryScheduleIfCurrent.mockImplementation(async next => { schedule = next; return true })
    const clock = vi.spyOn(Date, 'now')
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    for (let index = 0; index < 30; index += 1) {
      const current = schedule
      clock.mockReturnValue(Date.parse(current.scheduledFor))
      await handleDailySummary({ eventName: 'daily.summary', eventData: { scheduledFor: current.scheduledFor }, eventId: current.eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(schedule.eventId).not.toBe(current.eventId)
      expect(Date.parse(schedule.scheduledFor)).toBeGreaterThan(Date.parse(current.scheduledFor))
    }
    expect(rootSend).toHaveBeenCalledTimes(30)
    expect(rootSend.mock.calls.every(([name]) => name === 'daily.summary')).toBe(true)
    expect(sendDailySummary).toHaveBeenCalledTimes(30)
  })

  it('每日续排遇到并发更新时只取消未绑定事件，保留最新指针', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const current = { eventId: 'cf:current-daily', scheduledFor: '2026-10-04T00:00:00.000Z', ...settings }
    const latest = { eventId: 'cf:latest-daily', scheduledFor: '2026-10-05T00:00:00.000Z', ...settings }
    let schedule = current
    getDailySummaryScheduleState.mockImplementation(async () => ({ settings, schedule, eligible: true }))
    setDailySummaryScheduleIfCurrent.mockResolvedValue(false)
    rootSend.mockImplementation(async (name: string) => { if (name === 'daily.summary') schedule = latest; return { sendStatus: 'succeeded', eventId: 'cf:orphan' } })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.scheduledFor))
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary({ eventName: 'daily.summary', eventData: { scheduledFor: current.scheduledFor }, eventId: current.eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
    expect(rootSend).toHaveBeenCalledWith('awl:delete-events', { data: { eventIds: ['cf:orphan'] } })
    expect(schedule).toBe(latest)
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledOnce()
  })
})
