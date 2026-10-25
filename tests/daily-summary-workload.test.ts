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

  it('当前事件发送后直接续排下一天，无需等待维护扫描', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    const workloadEvent = event()
    await handleDailySummary(workloadEvent)
    expect(sendDailySummary).toHaveBeenCalledOnce()
    expect(sendDailySummary).toHaveBeenCalledWith(new Date(workloadEvent.eventData.scheduledFor))
    expect(ensureDailySummarySchedule).toHaveBeenCalledWith(expect.objectContaining({ send: expect.any(Function) }), expect.any(Date), { skipCancellationForEventId: 'summary-event' })
  })

  it('旧 daily event 到达时既不发送也不续排', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(false)
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary(event('old-event'))
    expect(sendDailySummary).not.toHaveBeenCalled()
    expect(ensureDailySummarySchedule).not.toHaveBeenCalled()
  })
  it('全量发送失败保留当前事件，并在下一次尝试重新发送', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValueOnce({ sent: 0, failed: 1, subscriptions: 1 }).mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    const cache = new Map<string, unknown>()
    const workloadEvent = event()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cache.has(key)) return cache.get(key)
      const result = await callback()
      cache.set(key, result)
      return result
    })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await expect(handleDailySummary(workloadEvent)).rejects.toThrow('每日汇总发送失败')
    expect(ensureDailySummarySchedule).not.toHaveBeenCalled()
    await handleDailySummary(workloadEvent)
    expect(sendDailySummary).toHaveBeenCalledTimes(2)
    expect(ensureDailySummarySchedule).toHaveBeenCalledOnce()
  })
  it('无任务或当天已发送时由调度层判断是否需要下一次汇总', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValue({ date: '2026-10-04', sent: 0, skipped: 'empty' })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary(event())
    expect(ensureDailySummarySchedule).toHaveBeenCalledOnce()
  })
  it('升级前已缓存的失败汇总会真正重试发送', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    const workloadEvent = event()
    const cached = new Map<string, unknown>([[`send-daily-summary:${workloadEvent.eventData.scheduledFor}`, { stale: false, sent: 0, failed: 1, subscriptions: 1 }]])
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cached.has(key)) return cached.get(key)
      const result = await callback()
      cached.set(key, result)
      return result
    })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await handleDailySummary(workloadEvent)
    expect(sendDailySummary).toHaveBeenCalledOnce()
    expect(ensureDailySummarySchedule).toHaveBeenCalledOnce()
  })
  it('续排失败重试时不会重复发送已经成功的每日汇总', async () => {
    isCurrentDailySummaryEvent.mockResolvedValue(true)
    sendDailySummary.mockResolvedValue({ sent: 1, failed: 0, subscriptions: 1 })
    ensureDailySummarySchedule.mockRejectedValueOnce(new Error('schedule unavailable')).mockResolvedValue({ scheduled: true })
    const workloadEvent = event()
    const cache = new Map<string, unknown>()
    workloadEvent.step.run = vi.fn(async (key: string, callback: () => unknown) => {
      if (cache.has(key)) return cache.get(key)
      const result = await callback()
      cache.set(key, result)
      return result
    })
    const { handleDailySummary } = await import('../netlify/functions/daily-summary')
    await expect(handleDailySummary(workloadEvent)).rejects.toThrow('schedule unavailable')
    await handleDailySummary(workloadEvent)
    expect(sendDailySummary).toHaveBeenCalledOnce()
    expect(ensureDailySummarySchedule).toHaveBeenCalledTimes(2)
  })
})
