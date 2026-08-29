import { asyncWorkloadFn, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { sendDailySummary } from '../../server/push.js'
import { ensureDailySummarySchedule, isCurrentDailySummaryEvent, DAILY_SUMMARY_EVENT } from '../../server/reminders/dailySummaryScheduler.js'

interface DailySummaryEvent extends CustomAsyncWorkloadEvent {
  eventName: typeof DAILY_SUMMARY_EVENT
  eventData: { scheduledFor: string }
}

export async function handleDailySummary(event: AsyncWorkloadEvent<DailySummaryEvent>) {
  const { scheduledFor } = event.eventData
  if (!(await isCurrentDailySummaryEvent(event.eventId, scheduledFor))) return
  const delay = Date.parse(scheduledFor) - Date.now()
  if (delay > 5_000) throw new ErrorRetryAfterDelay({ message: '每日汇总事件提前到达', retryDelay: delay, forceDelayTime: true })
  const result = await event.step.run(`send-daily-summary:${scheduledFor}`, async () => {
    if (!(await isCurrentDailySummaryEvent(event.eventId, scheduledFor))) return { stale: true as const }
    return { stale: false as const, ...(await sendDailySummary(new Date())) }
  })
  if (result.stale) return
  await event.step.run(`schedule-next-daily-summary:${scheduledFor}`, () => ensureDailySummarySchedule(undefined, new Date(), { skipCancellationForEventId: event.eventId }))
}

export default asyncWorkloadFn<DailySummaryEvent>(handleDailySummary)

export const asyncWorkloadConfig: AsyncWorkloadConfig<DailySummaryEvent> = {
  events: [DAILY_SUMMARY_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.scheduledFor)
}
