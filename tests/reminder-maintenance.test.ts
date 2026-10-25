import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.fn(), getTask = vi.fn(), setReminderEvent = vi.fn(), advanceReminderOccurrence = vi.fn()
const clearReminderEventIfCurrent = vi.fn()
const getDailySummaryScheduleState = vi.fn(), setDailySummaryScheduleIfCurrent = vi.fn()
const sendPushPayload = vi.fn(), sendDailySummary = vi.fn()
const routerFetch = vi.fn()
const managementSend = vi.fn(), createSdkClient = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { read, getTask, setReminderEvent, advanceReminderOccurrence, clearReminderEventIfCurrent, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent } }))
vi.mock('../server/push', () => ({ sendPushPayload, sendDailySummary }))
vi.mock('@netlify/async-workloads', () => ({
  AsyncWorkloadsClient: class { constructor() { createSdkClient() } send = managementSend },
  asyncWorkloadFn: (value: unknown) => value,
  ErrorDoNotRetry: class extends Error {},
  ErrorRetryAfterDelay: class extends Error { constructor(options: { message: string }) { super(options.message) } }
}))

describe('独立提醒定时维护', () => {
  beforeEach(() => {
    vi.useRealTimers()
    for (const fn of [read, getTask, setReminderEvent, advanceReminderOccurrence, clearReminderEventIfCurrent, getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent, sendPushPayload, sendDailySummary]) fn.mockReset()
    sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    routerFetch.mockReset().mockImplementation(async () => new Response('ack'))
    managementSend.mockReset().mockResolvedValue({ sendStatus: 'succeeded', eventId: 'cancel' })
    createSdkClient.mockReset()
    vi.stubGlobal('fetch', routerFetch)
    vi.stubGlobal('Netlify', { context: { url: 'https://reminders.example.test/.netlify/functions/todo-reminder' }, env: { get: (name: string) => name === 'AWL_API_KEY' ? 'synthetic-reminder-key' : undefined } })
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'existing-summary', scheduledFor: '2099-01-01T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('无限重复跨越 30 次无需再次维护扫描，事件均为独立根事件', async () => {
    const task = { id: 'todo-1', title: '喝水', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: new Date(Date.now() - 1_000).toISOString(), eventId: null as string | null, sentAt: null, recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }] }
    read.mockImplementation(async () => ({ tasks: [task] }))
    getTask.mockImplementation(async () => structuredClone(task))
    setReminderEvent.mockImplementation(async (_todoId, _reminderId, at, eventId) => { if (task.reminders[0].at !== at || task.reminders[0].eventId) return false; task.reminders[0].eventId = eventId; return true })
    advanceReminderOccurrence.mockImplementation(async (_todoId, _reminderId, eventId, next, nextEventId) => { if (task.reminders[0].eventId !== eventId) return false; Object.assign(task.reminders[0], next, { eventId: nextEventId }); return true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: `root-${sender.send.mock.calls.length}` })) }
    const clock = vi.spyOn(Date, 'now')
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await maintainReminderSchedules(sender, new Date(task.reminders[0].at))
    for (let index = 0; index < 30; index += 1) {
      const eventId = task.reminders[0].eventId!
      clock.mockReturnValue(Date.parse(task.reminders[0].at))
      await handleTodoReminder({ eventName: 'todo.reminder', eventData: { todoId: task.id, reminderId: 'r1' }, eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(task.reminders[0].eventId).toEqual(expect.any(String))
      expect(task.reminders[0].eventId).not.toBe(eventId)
    }
    clock.mockRestore()
    expect(task.reminders[0].recurrence.occurrence).toBe(31)
    expect(sender.send).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(routerFetch).toHaveBeenCalledTimes(30)
    const payloads = routerFetch.mock.calls.map(([, options]) => JSON.parse(options.body))
    expect(payloads.every(payload => !('eventChain' in payload))).toBe(true)
    expect(new Set(payloads.map(payload => payload.eventId)).size).toBe(30)
    expect(createSdkClient).not.toHaveBeenCalled()
    expect(sendPushPayload).toHaveBeenCalledTimes(30)
  })

  it('每日汇总连续 30 天无需再次维护扫描', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    let schedule: { eventId: string; scheduledFor: string; dailySummaryTime: string; timezone: string } | null = null
    read.mockResolvedValue({ tasks: [] })
    getDailySummaryScheduleState.mockImplementation(async () => ({ settings, schedule }))
    setDailySummaryScheduleIfCurrent.mockImplementation(async next => { schedule = next; return true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: `daily-root-${sender.send.mock.calls.length}` })) }
    const clock = vi.spyOn(Date, 'now')
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await maintainReminderSchedules(sender, new Date('2026-10-03T23:00:00.000Z'))
    for (let index = 0; index < 30; index += 1) {
      const current = schedule!
      clock.mockReturnValue(Date.parse(current.scheduledFor))
      await handleDailySummary({ eventName: 'daily.summary', eventData: { scheduledFor: current.scheduledFor }, eventId: current.eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
      expect(schedule!.eventId).not.toBe(current.eventId)
      expect(Date.parse(schedule!.scheduledFor)).toBeGreaterThan(Date.parse(current.scheduledFor))
    }
    clock.mockRestore()
    expect(sender.send).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(routerFetch).toHaveBeenCalledTimes(30)
    expect(routerFetch.mock.calls.every(([, options]) => !('eventChain' in JSON.parse(options.body)))).toBe(true)
    expect(createSdkClient).not.toHaveBeenCalled()
    expect(sendDailySummary).toHaveBeenCalledTimes(30)
  })

  it('每日续排遇到并发更新时通过 SDK 只取消未绑定根事件，保留最新指针', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const current = { eventId: 'current-daily', scheduledFor: '2026-10-04T00:00:00.000Z', ...settings }
    const latest = { eventId: 'latest-daily', scheduledFor: '2026-10-05T00:00:00.000Z', ...settings }
    let schedule = current
    getDailySummaryScheduleState.mockImplementation(async () => ({ settings, schedule }))
    setDailySummaryScheduleIfCurrent.mockResolvedValue(false)
    routerFetch.mockImplementation(async () => { schedule = latest; return new Response('ack') })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.scheduledFor))
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary({ eventName: 'daily.summary', eventData: { scheduledFor: current.scheduledFor }, eventId: current.eventId, step: { run: async (_key: string, callback: () => unknown) => callback() } } as never)
    const orphanId = JSON.parse(routerFetch.mock.calls[0][1].body).eventId
    expect(managementSend).toHaveBeenCalledOnce()
    expect(managementSend).toHaveBeenCalledWith('awl:delete-events', { data: { eventIds: [orphanId] } })
    expect(schedule).toBe(latest)
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledOnce()
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
  it('首次订阅后的旧版单条提醒调度失败，后续维护仍可补排', async () => {
    const task = { id: 'legacy-todo', completed: false, deletedAt: null, reminderEnabled: true, reminderAt: '2026-10-12T00:00:00.000Z', reminderEventId: null, reminderSentAt: null }
    read.mockResolvedValue({ tasks: [task], subscriptions: [{ endpoint: 'https://push.example.test/synthetic' }] })
    getTask.mockResolvedValue(task)
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn().mockResolvedValueOnce({ sendStatus: 'failed', eventId: 'failed' }).mockResolvedValue({ sendStatus: 'succeeded', eventId: 'recovered' }) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await expect(maintainReminderSchedules(sender, new Date('2026-10-12T00:05:00.000Z'))).rejects.toThrow('部分提醒调度失败')
    await maintainReminderSchedules(sender, new Date('2026-10-12T00:10:00.000Z'))
    expect(setReminderEvent).toHaveBeenCalledWith(task.id, task.reminderAt, 'recovered')
  })

  it('超过一小时仍未发送的多个已绑定提醒通过 CAS 解绑后，一次读取任务并批量补排', async () => {
    const now = new Date('2026-10-12T02:00:00.000Z')
    const task = { id: 'todo-1', completed: false, deletedAt: null, reminders: [
      { id: 'r1', at: '2026-10-12T00:00:00.000Z', eventId: 'lost-1' as string | null, sentAt: null },
      { id: 'r2', at: '2026-10-12T01:00:00.000Z', eventId: 'lost-2' as string | null, sentAt: null }
    ] }
    read.mockResolvedValue({ tasks: [structuredClone(task)], subscriptions: [{}] })
    getTask.mockImplementation(async () => structuredClone(task))
    clearReminderEventIfCurrent.mockImplementation(async (_todoId, reminderId, eventId) => {
      const reminder = task.reminders.find(item => item.id === reminderId)
      if (reminder?.eventId !== eventId) return false
      reminder.eventId = null
      return true
    })
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: `recovered-${setReminderEvent.mock.calls.length}` })) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(sender, now)
    expect(clearReminderEventIfCurrent.mock.calls).toEqual([['todo-1', 'r1', 'lost-1'], ['todo-1', 'r2', 'lost-2']])
    expect(getTask).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenNthCalledWith(1, 'awl:delete-events', { data: { eventIds: ['lost-1', 'lost-2'] } })
    expect(sender.send).toHaveBeenNthCalledWith(2, 'todo.reminder', { data: { todoId: task.id, reminderId: 'r1' }, delayUntil: now.getTime() + 60_000 })
    expect(sender.send).toHaveBeenNthCalledWith(3, 'todo.reminder', { data: { todoId: task.id, reminderId: 'r2' }, delayUntil: now.getTime() + 60_000 })
    expect(setReminderEvent).toHaveBeenCalledTimes(2)
  })

  it('旧版单条提醒的过期绑定同样通过 CAS 解绑并恢复', async () => {
    const task = { id: 'legacy-todo', completed: false, deletedAt: null, reminderEnabled: true, reminderAt: '2026-10-12T00:00:00.000Z', reminderEventId: 'lost-legacy' as string | null, reminderSentAt: null }
    read.mockResolvedValue({ tasks: [structuredClone(task)], subscriptions: [{}] })
    getTask.mockImplementation(async () => structuredClone(task))
    clearReminderEventIfCurrent.mockImplementation(async () => { task.reminderEventId = null; return true })
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'recovered-legacy' })) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(sender, new Date('2026-10-12T02:00:00.000Z'))
    expect(clearReminderEventIfCurrent).toHaveBeenCalledWith(task.id, 'legacy', 'lost-legacy')
    expect(sender.send).toHaveBeenNthCalledWith(1, 'awl:delete-events', { data: { eventIds: ['lost-legacy'] } })
    expect(setReminderEvent).toHaveBeenCalledWith(task.id, task.reminderAt, 'recovered-legacy')
  })

  it.each(['native', 'legacy'])('保留 %s 已发送、未来、重试窗口内、完成或删除的绑定', async kind => {
    const now = new Date('2026-10-12T02:00:00.000Z')
    const scenarios = [
      { at: '2026-10-12T00:00:00.000Z', sentAt: '2026-10-12T00:00:05.000Z', completed: false, deletedAt: null },
      { at: '2026-10-13T00:00:00.000Z', sentAt: null, completed: false, deletedAt: null },
      { at: '2026-10-12T01:00:01.000Z', sentAt: null, completed: false, deletedAt: null },
      { at: '2026-10-12T00:00:00.000Z', sentAt: null, completed: true, deletedAt: null },
      { at: '2026-10-12T00:00:00.000Z', sentAt: null, completed: false, deletedAt: '2026-10-12T01:30:00.000Z' }
    ]
    const tasks = scenarios.map((scenario, index) => ({
      id: `todo-${index}`, completed: scenario.completed, deletedAt: scenario.deletedAt,
      ...(kind === 'native'
        ? { reminders: [{ id: 'r1', at: scenario.at, eventId: `keep-${index}`, sentAt: scenario.sentAt }] }
        : { reminderEnabled: true, reminderAt: scenario.at, reminderEventId: `keep-${index}`, reminderSentAt: scenario.sentAt })
    }))
    read.mockResolvedValue({ tasks, subscriptions: [{}] })
    const sender = { send: vi.fn() }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(sender, now)
    expect(clearReminderEventIfCurrent).not.toHaveBeenCalled()
    expect(getTask).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it.each(['native', 'legacy'])('%s 绑定 CAS 失败时不取消或覆盖并发更新', async kind => {
    const task = { id: 'todo-race', completed: false, deletedAt: null,
      ...(kind === 'native'
        ? { reminders: [{ id: 'r1', at: '2026-10-12T00:00:00.000Z', eventId: 'stale', sentAt: null }] }
        : { reminderEnabled: true, reminderAt: '2026-10-12T00:00:00.000Z', reminderEventId: 'stale', reminderSentAt: null }) }
    read.mockResolvedValue({ tasks: [task], subscriptions: [{}] })
    clearReminderEventIfCurrent.mockResolvedValue(false)
    const sender = { send: vi.fn() }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await maintainReminderSchedules(sender, new Date('2026-10-12T02:00:00.000Z'))
    expect(clearReminderEventIfCurrent).toHaveBeenCalledOnce()
    expect(getTask).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('清理过期绑定后取消旧事件失败仍保留未绑定状态供下次维护恢复', async () => {
    const task = { id: 'todo-1', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: '2026-10-12T00:00:00.000Z', eventId: 'lost' as string | null, sentAt: null }] }
    read.mockImplementation(async () => ({ tasks: [structuredClone(task)], subscriptions: [{}] }))
    getTask.mockImplementation(async () => structuredClone(task))
    clearReminderEventIfCurrent.mockImplementation(async () => { task.reminders[0].eventId = null; return true })
    setReminderEvent.mockResolvedValue(true)
    const sender = { send: vi.fn().mockResolvedValueOnce({ sendStatus: 'failed', eventId: 'cancel-failed' }).mockResolvedValue({ sendStatus: 'succeeded', eventId: 'recovered' }) }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await expect(maintainReminderSchedules(sender, new Date('2026-10-12T02:00:00.000Z'))).rejects.toThrow('部分提醒调度失败')
    expect(task.reminders[0].eventId).toBeNull()
    expect(setReminderEvent).not.toHaveBeenCalled()
    await maintainReminderSchedules(sender, new Date('2026-10-12T03:00:00.000Z'))
    expect(clearReminderEventIfCurrent).toHaveBeenCalledOnce()
    expect(setReminderEvent).toHaveBeenCalledWith(task.id, 'r1', task.reminders[0].at, 'recovered')
  })

  it('没有订阅时保留过期绑定，不创建恢复工作', async () => {
    read.mockResolvedValue({ tasks: [{ id: 'todo-1', completed: false, reminders: [{ id: 'r1', at: '2026-10-12T00:00:00.000Z', eventId: 'lost', sentAt: null }] }], subscriptions: [] })
    const sender = { send: vi.fn() }
    const { maintainReminderSchedules } = await import('../server/reminders/maintenance')
    await expect(maintainReminderSchedules(sender, new Date('2026-10-12T02:00:00.000Z'))).resolves.toEqual({ skipped: 'no-subscriptions' })
    expect(clearReminderEventIfCurrent).not.toHaveBeenCalled()
    expect(getTask).not.toHaveBeenCalled()
    expect(getDailySummaryScheduleState).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })
})
