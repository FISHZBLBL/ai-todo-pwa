import { AsyncWorkloadsClient } from '@netlify/async-workloads'
import { cloudStore } from '../storage.js'
import { ensureDailySummarySchedule } from './dailySummaryScheduler.js'
import { reconcileReminder, type AsyncEventSender } from './scheduler.js'

const RECOVERY_OVERDUE_MS = 60 * 60 * 1000

// Each scheduled invocation starts outside an Async Workload event chain.
// State records remain pending when a send fails, allowing the next run to
// recover without caching a failed SDK result or requiring a user sync.
export async function maintainReminderSchedules(sender?: AsyncEventSender, now = new Date()) {
  const data = await cloudStore.read()
  // No device can receive a notification yet. Leave reminders unbound until
  // subscribing resumes them, rather than repeatedly creating doomed events.
  if (data.subscriptions?.length === 0) return { skipped: 'no-subscriptions' as const }
  const client = sender ?? new AsyncWorkloadsClient()
  const failures: unknown[] = []
  for (const task of data.tasks) {
    if (task.completed || task.deletedAt) continue
    const reminders = task.reminders ?? (task.reminderEnabled && task.reminderAt
      ? [{ id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId, sentAt: task.reminderSentAt }] : [])
    let pending = reminders.some(reminder => !reminder.sentAt && !reminder.eventId)
    const oldEventIds: string[] = []
    try {
      for (const reminder of reminders) {
        // The router can acknowledge an event that never reaches durable queue
        // storage. Give active delivery retries an hour before recovering it.
        if (reminder.sentAt || !reminder.eventId || !(Date.parse(reminder.at) <= now.getTime() - RECOVERY_OVERDUE_MS)) continue
        if (await cloudStore.clearReminderEventIfCurrent(task.id, reminder.id, reminder.eventId)) {
          oldEventIds.push(reminder.eventId)
          pending = true
        }
      }
      if (pending) await reconcileReminder({ todoId: task.id, oldEventIds }, client, now.getTime(), { includeOverdue: true })
    } catch (error) { failures.push(error) }
  }
  try {
    await ensureDailySummarySchedule(client, now, { recoverOverdueAfterMs: RECOVERY_OVERDUE_MS })
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, '部分提醒调度失败，下次定时检查将重试')
}
