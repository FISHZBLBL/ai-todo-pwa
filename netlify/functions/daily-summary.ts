import { asyncWorkloadFn, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { sendDailySummary } from '../../server/push.js'
import { completeDailySummaryEvent, isCurrentDailySummaryEvent, DAILY_SUMMARY_EVENT } from '../../server/reminders/dailySummaryScheduler.js'

interface DailySummaryEvent extends CustomAsyncWorkloadEvent {
  eventName: typeof DAILY_SUMMARY_EVENT
  eventData: { scheduledFor: string }
}

export async function handleDailySummary(event: AsyncWorkloadEvent<DailySummaryEvent>) {
  const { scheduledFor } = event.eventData
  if (!(await isCurrentDailySummaryEvent(event.eventId, scheduledFor, { waitForRegistration: true }))) return
  const delay = Date.parse(scheduledFor) - Date.now()
  if (delay > 5_000) throw new ErrorRetryAfterDelay({ message: '每日汇总事件提前到达', retryDelay: delay, forceDelayTime: true })
  const deliver = async () => {
    if (!(await isCurrentDailySummaryEvent(event.eventId, scheduledFor))) return { stale: true as const }
    const summary = await sendDailySummary(new Date(scheduledFor))
    if (!('skipped' in summary) && !summary.sent) throw new ErrorRetryAfterDelay({ message: '每日汇总发送失败', retryDelay: '1m' })
    return { stale: false as const, ...summary }
  }
  let result = await event.step.run(`send-daily-summary:${scheduledFor}`, deliver)
  if (!result.stale && !('skipped' in result) && !result.sent) result = await event.step.run(`retry-send-daily-summary-v2:${scheduledFor}`, deliver)
  if (result.stale) return
  // The independent maintenance function schedules tomorrow as a new root
  // event, keeping daily delivery outside the SDK's finite chaining limit.
  await event.step.run(`complete-daily-summary:${scheduledFor}`, () => completeDailySummaryEvent(event.eventId, scheduledFor))
}

export default asyncWorkloadFn<DailySummaryEvent>(handleDailySummary)

export const asyncWorkloadConfig: AsyncWorkloadConfig<DailySummaryEvent> = {
  events: [DAILY_SUMMARY_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.scheduledFor)
}
