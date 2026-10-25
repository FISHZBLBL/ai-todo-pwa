import { beforeEach, describe, expect, it, vi } from 'vitest'
const getTask = vi.fn(), markReminderSent = vi.fn(), advanceReminderOccurrence = vi.fn(), bindUnregisteredReminder = vi.fn(), sendPushPayload = vi.fn(), rootSend = vi.fn(), cancelReminderEvents = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, markReminderSent, advanceReminderOccurrence, bindUnregisteredReminder } }))
vi.mock('../server/push', () => ({ sendPushPayload }))
vi.mock('../server/reminders/rootEventSender', () => ({ createRootEventSender: () => ({ send: rootSend }) }))
vi.mock('../server/reminders/scheduler', () => ({ TODO_REMINDER_EVENT: 'todo.reminder', cancelReminderEvents }))
const reminder = (eventId = 'event-1', sentAt: string | null = null) => ({ id: 'r1', at: new Date(Date.now() - 1000).toISOString(), eventId, sentAt, source: 'explicit' as const })
const task = (value = reminder(), extra = {}) => ({ id: 'todo-1', title: '喝水', reminders: [value], completed: false, deletedAt: null, ...extra })
const event = (eventId = 'event-1') => ({ eventName: 'todo.reminder', eventData: { todoId: 'todo-1', reminderId: 'r1' }, eventId, attempt: 0, request: new Request('https://test'), step: { run: vi.fn(async (_: string, fn: () => unknown) => fn()) } })
describe('多提醒 workload', () => {
  beforeEach(() => { getTask.mockReset(); markReminderSent.mockReset(); advanceReminderOccurrence.mockReset(); bindUnregisteredReminder.mockReset(); sendPushPayload.mockReset(); rootSend.mockReset(); cancelReminderEvents.mockReset(); markReminderSent.mockResolvedValue(true); advanceReminderOccurrence.mockResolvedValue(true); sendPushPayload.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 }); rootSend.mockResolvedValue({ sendStatus: 'succeeded', eventId: 'next-root' }); cancelReminderEvents.mockResolvedValue(undefined) })
  it('只发送 eventId 与 reminderId 同时匹配的 reminder，并独立标记 sentAt', async () => { getTask.mockResolvedValue(task()); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).toHaveBeenCalledOnce(); expect(markReminderSent).toHaveBeenCalledWith('todo-1', 'r1', 'event-1') })
  it('stale、完成和删除事件不发送', async () => { const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); getTask.mockResolvedValue(task(reminder('other'))); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { completed: true })); await handleTodoReminder(event() as never); getTask.mockResolvedValue(task(reminder(), { deletedAt: '2026-01-01T00:00:00Z' })); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
  it('已发送 reminder 重试不会重复推送', async () => { getTask.mockResolvedValue(task(reminder('event-1', new Date().toISOString()))); const { handleTodoReminder } = await import('../netlify/functions/todo-reminder'); await handleTodoReminder(event() as never); expect(sendPushPayload).not.toHaveBeenCalled() })
  it('新事件在 reminder 绑定前到达时重试，不会静默丢弃', async () => {
    getTask.mockResolvedValue(task({ ...reminder(), eventId: null } as never))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toThrow()
    expect(sendPushPayload).not.toHaveBeenCalled()
    getTask.mockResolvedValue(task())
    await handleTodoReminder(event() as never)
    expect(sendPushPayload).toHaveBeenCalledOnce()
  })
  it('重复提醒发送后直接绑定下一次事件，无需等待全量维护', async () => {
    const value = { ...reminder(), recurrence: { unit: 'week', interval: 1, end: 'count', count: 12, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: true } }
    getTask.mockResolvedValue(task(value))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(sendPushPayload).toHaveBeenCalledWith(expect.objectContaining({ body: '还剩 11 周到期' }))
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', expect.objectContaining({ recurrence: expect.objectContaining({ occurrence: 2 }) }), 'next-root')
    expect(rootSend).toHaveBeenCalledWith('todo.reminder', { data: { todoId: 'todo-1', reminderId: 'r1', expectedAt: expect.any(String), previousEventId: 'event-1' }, delayUntil: expect.any(Number) })
  })
  it('有限重复的最后一次不再创建事件并自动结束生命周期', async () => {
    const value = { ...reminder(), recurrence: { unit: 'week', interval: 1, end: 'count', count: 12, until: null, occurrence: 12, timezone: 'Asia/Shanghai', countdown: true } }
    getTask.mockResolvedValue(task(value))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', null, null)
    expect(rootSend).not.toHaveBeenCalled()
  })
  it('Push 暂时失败不会缓存失败结果，成功后的状态保存重试不重复推送', async () => {
    getTask.mockResolvedValue(task())
    sendPushPayload.mockResolvedValueOnce({ sent: 0, failed: 1, subscriptions: 1 }).mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    markReminderSent.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(true)
    const cached = new Map<string, unknown>()
    const workloadEvent = event()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cached.has(key)) return cached.get(key)
      const result = await callback()
      cached.set(key, result)
      return result
    })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(workloadEvent as never)).rejects.toThrow()
    await expect(handleTodoReminder(workloadEvent as never)).rejects.toThrow('storage unavailable')
    await handleTodoReminder(workloadEvent as never)
    expect(sendPushPayload).toHaveBeenCalledTimes(2)
    expect(markReminderSent).toHaveBeenCalledTimes(2)
  })
  it('总次数剩最后一次时直接安排最后一条提醒', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 2, end: 'count', count: 3, until: null, occurrence: 2, timezone: 'Asia/Shanghai', countdown: true } }
    getTask.mockResolvedValue(task(value))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', expect.objectContaining({ recurrence: expect.objectContaining({ occurrence: 3 }) }), 'next-root')
    expect(sendPushPayload).toHaveBeenCalledWith(expect.objectContaining({ body: '还剩 2 天到期' }))
  })
  it('升级前已缓存的失败 Push 结果会重新发送，保留新的成功缓存', async () => {
    getTask.mockResolvedValue(task())
    markReminderSent.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(true)
    const cached = new Map<string, unknown>([['send-push:event-1', { stale: false, sent: 0, failed: 1, subscriptions: 1 }]])
    const workloadEvent = event()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cached.has(key)) return cached.get(key)
      const result = await callback()
      cached.set(key, result)
      return result
    })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(workloadEvent as never)).rejects.toThrow('storage unavailable')
    await handleTodoReminder(workloadEvent as never)
    expect(sendPushPayload).toHaveBeenCalledOnce()
    expect(markReminderSent).toHaveBeenCalledTimes(2)
  })
  it('下一次事件安排失败时保留当前绑定，等待单个事件重试', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    rootSend.mockResolvedValue({ sendStatus: 'failed', eventId: 'failed' })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toThrow('创建后续提醒事件失败')
    expect(advanceReminderOccurrence).not.toHaveBeenCalled()
    expect(sendPushPayload).toHaveBeenCalledOnce()
    expect(rootSend).toHaveBeenCalledOnce()
  })
  it('较远的后续提醒也交由到点事件安排，不留待全量维护扫描', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 500, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', expect.objectContaining({ recurrence: expect.objectContaining({ interval: 500, occurrence: 2 }) }), 'next-root')
    expect(sendPushPayload).toHaveBeenCalledOnce()
  })
  it('后续安排失败后重试只创建下一次事件，不重复推送成功的本次提醒', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    rootSend.mockRejectedValueOnce(new Error('schedule unavailable')).mockResolvedValue({ sendStatus: 'succeeded', eventId: 'next-root' })
    const cached = new Map<string, unknown>()
    const workloadEvent = event()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cached.has(key)) return cached.get(key)
      const result = await callback()
      cached.set(key, result)
      return result
    })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(workloadEvent as never)).rejects.toThrow('schedule unavailable')
    expect(advanceReminderOccurrence).not.toHaveBeenCalled()
    await handleTodoReminder(workloadEvent as never)
    expect(sendPushPayload).toHaveBeenCalledOnce()
    expect(rootSend).toHaveBeenCalledTimes(2)
    expect(advanceReminderOccurrence).toHaveBeenCalledOnce()
  })
  it('下一次事件成功后保存失败，重试复用事件 ID 和推送缓存', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    advanceReminderOccurrence.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(true)
    const cached = new Map<string, unknown>()
    const workloadEvent = event()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cached.has(key)) return cached.get(key)
      const result = await callback()
      cached.set(key, result)
      return result
    })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(workloadEvent as never)).rejects.toThrow('storage unavailable')
    await handleTodoReminder(workloadEvent as never)
    expect(sendPushPayload).toHaveBeenCalledOnce()
    expect(rootSend).toHaveBeenCalledOnce()
    expect(advanceReminderOccurrence).toHaveBeenCalledTimes(2)
  })
  it('并发修改导致推进失败时取消孤儿事件', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    advanceReminderOccurrence.mockResolvedValue(false)
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(cancelReminderEvents).toHaveBeenCalledWith(['next-root'])
  })
  it('同一缓存事件已由并发尝试绑定时不会取消正在使用的下一次提醒', async () => {
    const value = { ...reminder(), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValueOnce(task(value)).mockResolvedValueOnce(task(value)).mockResolvedValueOnce(task(value)).mockResolvedValue(task({ ...value, eventId: 'next-root' }))
    advanceReminderOccurrence.mockResolvedValue(false)
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(event() as never)
    expect(cancelReminderEvents).not.toHaveBeenCalled()
  })

  it('CF 已持久但 API 在绑定前退出，到点仅为完全相同版本的事项自登记', async () => {
    const current = { ...task({ ...reminder(), eventId: null } as never), updatedAt: '2026-10-25T00:00:00.000Z' }
    getTask.mockImplementation(async () => structuredClone(current))
    bindUnregisteredReminder.mockImplementation(async (_todoId, _reminderId, _at, eventId) => { current.reminders[0].eventId = eventId; return true })
    const recovering = event()
    Object.assign(recovering.eventData, { expectedAt: current.reminders[0].at, expectedUpdatedAt: current.updatedAt })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(recovering as never)
    expect(bindUnregisteredReminder).toHaveBeenCalledWith('todo-1', 'r1', current.reminders[0].at, 'event-1', current.updatedAt)
    expect(sendPushPayload).toHaveBeenCalledOnce()
    expect(markReminderSent).toHaveBeenCalledWith('todo-1', 'r1', 'event-1')
  })

  it('旧版本或旧时间的未绑定事件不会重新登记并发送修改过的事项', async () => {
    const current = { ...task({ ...reminder(), eventId: null } as never), updatedAt: '2026-10-25T00:02:00.000Z' }
    getTask.mockResolvedValue(current)
    const recovering = event()
    Object.assign(recovering.eventData, { expectedAt: current.reminders[0].at, expectedUpdatedAt: '2026-10-25T00:00:00.000Z' })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(recovering as never)
    Object.assign(recovering.eventData, { expectedAt: '2026-10-24T00:00:00.000Z', expectedUpdatedAt: current.updatedAt })
    await handleTodoReminder(recovering as never)
    expect(bindUnregisteredReminder).not.toHaveBeenCalled()
    expect(sendPushPayload).not.toHaveBeenCalled()
  })

  it('自登记 CAS 期间发生更新时重读后丢弃旧事件', async () => {
    const current = { ...task({ ...reminder(), eventId: null } as never), updatedAt: '2026-10-25T00:00:00.000Z' }
    getTask.mockImplementation(async () => structuredClone(current))
    bindUnregisteredReminder.mockImplementation(async () => { current.updatedAt = '2026-10-25T00:02:00.000Z'; return false })
    const recovering = event()
    Object.assign(recovering.eventData, { expectedAt: current.reminders[0].at, expectedUpdatedAt: current.updatedAt })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await handleTodoReminder(recovering as never)
    expect(bindUnregisteredReminder).toHaveBeenCalledOnce()
    expect(sendPushPayload).not.toHaveBeenCalled()
    expect(markReminderSent).not.toHaveBeenCalled()
  })

  it('后续重复事件等待父事件推进，不能重新绑定仍属于父事件的事项', async () => {
    const value = { ...reminder('parent-event'), recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
    getTask.mockResolvedValue(task(value))
    const child = event('child-event')
    Object.assign(child.eventData, { expectedAt: new Date(Date.now() + 86_400_000).toISOString(), previousEventId: 'parent-event' })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(child as never)).rejects.toMatchObject({ message: '提醒事件等待登记', retryDelayMs: 60_000 })
    expect(bindUnregisteredReminder).not.toHaveBeenCalled()
    expect(sendPushPayload).not.toHaveBeenCalled()
    expect(advanceReminderOccurrence).not.toHaveBeenCalled()
  })

  it('恢复长期逾期的重复事项时，后续过期事件至少间隔一分钟', async () => {
    const now = Date.parse('2026-10-25T10:00:00.000Z')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const value = { ...reminder(), at: '2026-09-25T10:00:00.000Z', recurrence: { unit: 'day', interval: 1, end: 'never', count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false } }
      getTask.mockResolvedValue(task(value))
      const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
      await handleTodoReminder(event() as never)
      expect(rootSend).toHaveBeenCalledWith('todo.reminder', { data: { todoId: 'todo-1', reminderId: 'r1', expectedAt: '2026-09-26T10:00:00.000Z', previousEventId: 'event-1' }, delayUntil: now + 60_000 })
      expect(sendPushPayload).toHaveBeenCalledOnce()
      expect(advanceReminderOccurrence).toHaveBeenCalledWith('todo-1', 'r1', 'event-1', expect.objectContaining({ at: '2026-09-26T10:00:00.000Z' }), 'next-root')
    } finally { clock.mockRestore() }
  })
})
