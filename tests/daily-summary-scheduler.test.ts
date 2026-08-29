import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDailySummaryScheduleState = vi.fn()
const setDailySummarySchedule = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getDailySummaryScheduleState, setDailySummarySchedule } }))

describe('每日汇总动态调度', () => {
  beforeEach(() => { getDailySummaryScheduleState.mockReset(); setDailySummarySchedule.mockReset() })

  it('Asia/Shanghai 的 08:00 正确换算为 UTC 时间戳', async () => {
    const { nextDailySummaryAt } = await import('../server/reminders/dailySummaryScheduler')
    expect(new Date(nextDailySummaryAt({ dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, new Date('2026-08-26T23:00:00.000Z'))).toISOString()).toBe('2026-08-27T00:00:00.000Z')
  })

  it('修改时间时取消旧 event 并创建新的 delayed event', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '09:30', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'old-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel' : 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    const result = await ensureDailySummarySchedule(sender, new Date('2026-08-26T23:00:00.000Z'))
    expect(sender.send.mock.calls[0]).toEqual(['awl:delete-events', { data: { eventIds: ['old-event'] } }])
    expect(sender.send.mock.calls[1]).toEqual(['daily.summary', { data: { scheduledFor: '2026-08-27T01:30:00.000Z' }, delayUntil: Date.parse('2026-08-27T01:30:00.000Z') }])
    expect(result.schedule).toMatchObject({ eventId: 'new-event', dailySummaryTime: '09:30' })
  })

  it('时区变化会替换旧 event', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'America/New_York' }, schedule: { eventId: 'old-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel' : 'new-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await ensureDailySummarySchedule(sender, new Date('2026-08-27T10:00:00.000Z'))
    expect(sender.send.mock.calls[0][0]).toBe('awl:delete-events')
    expect(sender.send.mock.calls[1][0]).toBe('daily.summary')
  })

  it('执行后的续排跳过当前 event 取消，并创建次日事件', async () => {
    getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'current-event', scheduledFor: '2026-08-27T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'next-event' })) }
    const { ensureDailySummarySchedule } = await import('../server/reminders/dailySummaryScheduler')
    await ensureDailySummarySchedule(sender, new Date('2026-08-27T00:01:00.000Z'), { skipCancellationForEventId: 'current-event' })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(sender.send.mock.calls[0]).toEqual(['daily.summary', { data: { scheduledFor: '2026-08-28T00:00:00.000Z' }, delayUntil: Date.parse('2026-08-28T00:00:00.000Z') }])
  })
})
