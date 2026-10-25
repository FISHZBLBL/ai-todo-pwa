import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDailySummaryScheduleState = vi.fn()
const setDailySummaryScheduleIfCurrent = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getDailySummaryScheduleState, setDailySummaryScheduleIfCurrent } }))

describe('每日汇总动态调度', () => {
  beforeEach(() => { getDailySummaryScheduleState.mockReset(); setDailySummaryScheduleIfCurrent.mockReset(); setDailySummaryScheduleIfCurrent.mockResolvedValue(true) })

  it('Asia/Shanghai 的 08:00 正确换算为 UTC 时间戳', async () => {
    const { nextDailySummaryAt } = await import('../server/reminders/dailySummaryScheduler')
    expect(new Date(nextDailySummaryAt({ dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, new Date('2026-08-26T23:00:00.000Z'))).toISOString()).toBe('2026-08-27T00:00:00.000Z')
  })

  it('修改时间时取消旧 event 并创建新的 delayed event', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '09:30', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'old-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel' : 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    const result = await ensureDailySummarySchedule(sender, new Date('2026-08-26T23:00:00.000Z'))
    expect(sender.send.mock.calls[0]).toEqual(['daily.summary', { data: expect.objectContaining({ scheduledFor: '2026-08-27T01:30:00.000Z' }), delayUntil: Date.parse('2026-08-27T01:30:00.000Z') }])
    expect(sender.send.mock.calls[1]).toEqual(['awl:delete-events', { data: { eventIds: ['old-event'] } }])
    expect(result.schedule).toMatchObject({ eventId: 'new-event', dailySummaryTime: '09:30' })
  })

  it('时区变化会替换旧 event', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'America/New_York' }, schedule: { eventId: 'old-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel' : 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await ensureDailySummarySchedule(sender, new Date('2026-08-27T10:00:00.000Z'))
    expect(sender.send.mock.calls[0][0]).toBe('daily.summary')
    expect(sender.send.mock.calls[1][0]).toBe('awl:delete-events')
  })

  it('执行后的续排跳过当前 event 取消，并创建次日事件', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'current-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'next-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await ensureDailySummarySchedule(sender, new Date('2026-08-27T00:01:00.000Z'), { skipCancellationForEventId: 'current-event' })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(sender.send.mock.calls[0]).toEqual(['daily.summary', { data: expect.objectContaining({ scheduledFor: '2026-08-28T00:00:00.000Z' }), delayUntil: Date.parse('2026-08-28T00:00:00.000Z') }])
  })
  it('普通同步在到点后保留尚未投递的汇总事件', async () => {
    const schedule = { eventId: 'due-event', scheduledFor: '2026-10-04T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule })
    const sender = { send: vi.fn() }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender, new Date('2026-10-04T00:00:10.000Z'))).resolves.toEqual({ scheduled: false, schedule })
    expect(sender.send).not.toHaveBeenCalled()
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
  })
  it('发送期间设置变化时取消未保存的新事件，保留最新调度', async () => {
    const originalSettings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', updatedAt: '2026-10-04T00:00:00.000Z' }
    const latestSettings = { ...originalSettings, dailySummaryTime: '09:00', updatedAt: '2026-10-04T00:00:01.000Z' }
    const latestSchedule = { eventId: 'latest-event', scheduledFor: '2026-10-04T01:00:00.000Z', dailySummaryTime: '09:00', timezone: 'Asia/Shanghai' }
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings: originalSettings, schedule: null }).mockResolvedValue({ settings: latestSettings, schedule: latestSchedule })
    setDailySummaryScheduleIfCurrent.mockResolvedValueOnce(false)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'stale-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender, new Date('2026-10-03T23:00:00.000Z'))).resolves.toEqual({ scheduled: false, schedule: latestSchedule })
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'stale-event' }), null, originalSettings)
    expect(sender.send).toHaveBeenLastCalledWith('awl:delete-events', { data: { eventIds: ['stale-event'] } })
    expect(sender.send).not.toHaveBeenCalledWith('awl:delete-events', { data: { eventIds: ['latest-event'] } })
  })
  it('维护任务可恢复超时的当天事件，失败的 send 不会更新调度指针', async () => {
    const schedule = { eventId: 'dead-event', scheduledFor: '2026-10-04T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'failed' as const, eventId: 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    const now = new Date('2026-10-04T02:00:00.000Z')
    await expect(ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 3_600_000 })).rejects.toThrow('创建每日汇总事件失败')
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
    sender.send.mockResolvedValue({ sendStatus: 'succeeded', eventId: 'new-event' } as never)
    await ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 3_600_000 })
    expect(sender.send).toHaveBeenCalledWith('daily.summary', { data: expect.objectContaining({ scheduledFor: now.toISOString() }), delayUntil: now.getTime() + 60_000 })
  })
  it('已消费事件清理只影响仍匹配的指针', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'current', scheduledFor: '2026-10-04T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule })
    const { completeDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await completeDailySummaryEvent('current', schedule.scheduledFor)
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledWith(null, schedule, settings)
    setDailySummaryScheduleIfCurrent.mockClear()
    await completeDailySummaryEvent('old-event', schedule.scheduledFor)
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
  })
  it('新事件在调度指针登记前到达时重试，登记后可执行', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const scheduledFor = new Date().toISOString()
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings, schedule: null }).mockResolvedValue({ settings, schedule: { eventId: 'new-event', scheduledFor, ...settings } })
    const { isCurrentDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(isCurrentDailySummaryEvent('new-event', scheduledFor, { waitForRegistration: true })).rejects.toThrow('每日汇总事件等待登记')
    await expect(isCurrentDailySummaryEvent('new-event', scheduledFor, { waitForRegistration: true })).resolves.toBe(true)
  })
  it('首次订阅即刻恢复到期旧汇总，但不重建未来事件', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const overdue = { eventId: 'old-event', scheduledFor: '2026-10-12T00:00:00.000Z', ...settings }
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    const now = new Date('2026-10-12T00:05:00.000Z')
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule: overdue })
    await ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 0 })
    expect(sender.send).toHaveBeenCalledWith('daily.summary', { data: expect.objectContaining({ scheduledFor: now.toISOString() }), delayUntil: now.getTime() + 60_000 })
    sender.send.mockClear()
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule: { ...overdue, scheduledFor: '2026-10-13T00:00:00.000Z' } })
    await ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 0 })
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('没有待办事项或推送订阅时清理现有汇总并停止续排', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'existing-summary', scheduledFor: '2026-10-26T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: false })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'cancel' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender)).resolves.toEqual({ scheduled: false, schedule: null })
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledWith(null, schedule, settings, false)
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('awl:delete-events', { data: { eventIds: [schedule.eventId] } })
  })

  it('空队列保持休眠，新增事项或订阅后恢复每日汇总', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings, schedule: null, eligible: false }).mockResolvedValue({ settings, schedule: null, eligible: true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'resumed-summary' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender)).resolves.toEqual({ scheduled: false, schedule: null })
    expect(sender.send).not.toHaveBeenCalled()
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
    await expect(ensureDailySummarySchedule(sender, new Date('2026-10-25T23:00:00.000Z'))).resolves.toMatchObject({ scheduled: true, schedule: { eventId: 'resumed-summary' } })
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'resumed-summary' }), null, settings, true)
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('daily.summary', { data: { scheduledFor: '2026-10-26T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', settingsUpdatedAt: null, previousEventId: null }, delayUntil: Date.parse('2026-10-26T00:00:00.000Z') })
  })

  it('执行中的汇总发现队列为空时仅清理自身指针', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'current-summary', scheduledFor: '2026-10-25T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: false })
    const sender = { send: vi.fn() }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender, new Date('2026-10-25T00:01:00.000Z'), { skipCancellationForEventId: schedule.eventId })).resolves.toEqual({ scheduled: false, schedule: null })
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledWith(null, schedule, settings, false)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('空快照之后新增事项时重新读取，不能取消仍然有效的汇总', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'needed-summary', scheduledFor: '2026-10-26T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings, schedule, eligible: false }).mockResolvedValue({ settings, schedule, eligible: true })
    setDailySummaryScheduleIfCurrent.mockResolvedValueOnce(false)
    const sender = { send: vi.fn() }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender, new Date('2026-10-25T23:00:00.000Z'))).resolves.toEqual({ scheduled: false, schedule })
    expect(getDailySummaryScheduleState).toHaveBeenCalledTimes(2)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('创建期间失去订阅或任务时取消未登记的新事件并停止续排', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings, schedule: null, eligible: true }).mockResolvedValue({ settings, schedule: null, eligible: false })
    setDailySummaryScheduleIfCurrent.mockResolvedValueOnce(false)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'orphan-summary' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await expect(ensureDailySummarySchedule(sender)).resolves.toEqual({ scheduled: false, schedule: null })
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: 'orphan-summary' }), null, settings, true)
    expect(sender.send).toHaveBeenLastCalledWith('awl:delete-events', { data: { eventIds: ['orphan-summary'] } })
  })

  it('续排事件携带设置版本和父事件指针用于创建进程中断后的恢复', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', updatedAt: '2026-10-25T00:00:00.000Z' }
    const schedule = { eventId: 'parent-summary', scheduledFor: '2026-10-25T00:00:00.000Z', dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: true })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'child-summary' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await ensureDailySummarySchedule(sender, new Date('2026-10-25T00:01:00.000Z'), { skipCancellationForEventId: schedule.eventId })
    expect(sender.send).toHaveBeenCalledExactlyOnceWith('daily.summary', {
      data: { scheduledFor: '2026-10-26T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', settingsUpdatedAt: settings.updatedAt, previousEventId: schedule.eventId },
      delayUntil: Date.parse('2026-10-26T00:00:00.000Z')
    })
  })

  it.each([null, 'parent-summary'])('云端指针为%s时，到点事件可以补登记自身', async previousEventId => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', updatedAt: '2026-10-25T00:00:00.000Z' }
    const schedule = previousEventId ? { eventId: previousEventId, scheduledFor: '2026-10-25T00:00:00.000Z', dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone } : null
    const data = { scheduledFor: '2026-10-26T00:00:00.000Z', dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone, settingsUpdatedAt: settings.updatedAt, previousEventId }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: true })
    const { registerUnboundDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(registerUnboundDailySummaryEvent('accepted-alarm', data)).resolves.toBe(true)
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledExactlyOnceWith({ eventId: 'accepted-alarm', scheduledFor: data.scheduledFor, dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone }, schedule, settings, true)
  })

  it.each(['dailySummaryTime', 'timezone', 'updatedAt'] as const)('设置的%s变化后不能用旧报警补登记', async field => {
    const originalSettings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', updatedAt: '2026-10-25T00:00:00.000Z' }
    const changes = { dailySummaryTime: '09:00', timezone: 'Europe/London', updatedAt: '2026-10-25T00:01:00.000Z' }
    const settings = { ...originalSettings, [field]: changes[field] }
    const data = { scheduledFor: '2026-10-26T00:00:00.000Z', dailySummaryTime: originalSettings.dailySummaryTime, timezone: originalSettings.timezone, settingsUpdatedAt: originalSettings.updatedAt, previousEventId: null }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule: null, eligible: true })
    const { registerUnboundDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(registerUnboundDailySummaryEvent('old-alarm', data)).resolves.toBe(false)
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
  })

  it('其他事件已成功绑定后，旧报警不会覆盖该指针', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'newer-alarm', scheduledFor: '2026-10-26T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: true })
    const data = { scheduledFor: schedule.scheduledFor, ...settings, settingsUpdatedAt: null, previousEventId: null }
    const { registerUnboundDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(registerUnboundDailySummaryEvent('old-alarm', data)).resolves.toBe(false)
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
  })

  it('已绑定的当前事件不重复写入，未带恢复元数据的旧事件不补登记', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const schedule = { eventId: 'current-alarm', scheduledFor: '2026-10-26T00:00:00.000Z', ...settings }
    getDailySummaryScheduleState.mockResolvedValue({ settings, schedule, eligible: true })
    const { registerUnboundDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(registerUnboundDailySummaryEvent(schedule.eventId, { scheduledFor: schedule.scheduledFor, ...settings, settingsUpdatedAt: null, previousEventId: null })).resolves.toBe(true)
    await expect(registerUnboundDailySummaryEvent('legacy-event', { scheduledFor: schedule.scheduledFor })).resolves.toBe(false)
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
  })

  it('没有待办或订阅的报警不自登记，CAS冲突也不会误认登记成功', async () => {
    const settings = { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    const data = { scheduledFor: '2026-10-26T00:00:00.000Z', ...settings, settingsUpdatedAt: null, previousEventId: null }
    getDailySummaryScheduleState.mockResolvedValueOnce({ settings, schedule: null, eligible: false }).mockResolvedValue({ settings, schedule: null, eligible: true })
    setDailySummaryScheduleIfCurrent.mockResolvedValue(false)
    const { registerUnboundDailySummaryEvent } = await import('../server/reminders/dailySummaryScheduler')
    await expect(registerUnboundDailySummaryEvent('accepted-alarm', data)).resolves.toBe(false)
    expect(setDailySummaryScheduleIfCurrent).not.toHaveBeenCalled()
    await expect(registerUnboundDailySummaryEvent('accepted-alarm', data)).resolves.toBe(false)
    expect(setDailySummaryScheduleIfCurrent).toHaveBeenCalledOnce()
  })
})
