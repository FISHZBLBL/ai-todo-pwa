import { beforeEach, describe, expect, it, vi } from 'vitest'

const isCurrentDailySummaryEvent = vi.fn()
const ensureDailySummarySchedule = vi.fn()
const sendDailySummary = vi.fn()
vi.mock('../server/reminders/dailySummaryScheduler', () => ({ DAILY_SUMMARY_EVENT: 'daily.summary', isCurrentDailySummaryEvent, ensureDailySummarySchedule }))
vi.mock('../server/push', () => ({ sendDailySummary }))

function event(eventId = 'summary-event') {
  return {
    eventName: 'daily.summary', eventData: { scheduledFor: new Date(Date.now() - 1_000).toISOString() }, eventId, attempt: 0, request: new Request('https://example.test'),
    step: { run: vi.fn(async (_id: string, callback: () => unknown) => callback()), sleep: vi.fn() }
  } as any
}

describe('每日汇总 workload', () => {
  beforeEach(() => { isCurrentDailySummaryEvent.mockReset(); ensureDailySummarySchedule.mockReset(); sendDailySummary.mockReset() })

  it('当前事件发送后安排下一天', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    ensureDailySummarySchedule.mockResolvedValue({ scheduled: true })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    const workloadEvent = event()
    await handleDailySummary(workloadEvent)
    expect(sendDailySummary).toHaveBeenCalledOnce()
    expect(ensureDailySummarySchedule).toHaveBeenCalledWith(undefined, expect.any(Date), { skipCancellationForEventId: 'summary-event' })
  })

  it('旧 daily event 到达时既不发送也不续排', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(false)
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary(event('old-event'))
    expect(sendDailySummary).not.toHaveBeenCalled()
    expect(ensureDailySummarySchedule).not.toHaveBeenCalled()
  })
})
