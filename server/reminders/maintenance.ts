import { AsyncWorkloadsClient } from '@netlify/async-workloads'
import { cloudStore } from '../storage.js'
import { ensureDailySummarySchedule } from './dailySummaryScheduler.js'
import { reconcileReminder, type AsyncEventSender } from './scheduler.js'

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
    const pending = task.reminders?.some(reminder => !reminder.sentAt && !reminder.eventId)
      ?? Boolean(task.reminderEnabled && task.reminderAt && !task.reminderSentAt && !task.reminderEventId)
    if (!pending) continue
    try {
      await reconcileReminder({ todoId: task.id, oldEventIds: [] }, client, now.getTime(), { includeOverdue: true })
    } catch (error) { failures.push(error) }
  }
  try {
    await ensureDailySummarySchedule(client, now, { recoverOverdueAfterMs: 60 * 60 * 1000 })
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, '部分提醒调度失败，下次定时检查将重试')
}
