import { AsyncWorkloadsClient } from '@netlify/async-workloads'
import { cloudStore } from '../storage.js'
import { ensureDailySummarySchedule } from './dailySummaryScheduler.js'
import { reconcileReminder, type AsyncEventSender } from './scheduler.js'

// Each scheduled invocation starts outside an Async Workload event chain.
// State records remain pending when a send fails, allowing the next run to
// recover without caching a failed SDK result or requiring a user sync.
export async function maintainReminderSchedules(sender: AsyncEventSender = new AsyncWorkloadsClient(), now = new Date()) {
  const data = await cloudStore.read()
  const failures: unknown[] = []
  for (const task of data.tasks) {
    if (task.completed || task.deletedAt || !task.reminders?.some(reminder => !reminder.sentAt && !reminder.eventId)) continue
    try {
      await reconcileReminder({ todoId: task.id, oldEventIds: [] }, sender, now.getTime(), { includeOverdue: true })
    } catch (error) { failures.push(error) }
  }
  try {
    await ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 60 * 60 * 1000 })
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, '部分提醒调度失败，下次定时检查将重试')
}
