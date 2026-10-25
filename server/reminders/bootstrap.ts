import { cloudStore } from '../storage.js'
import { createAlarmEventSender, importAlarmEvents, type AlarmEvent } from './alarmClient.js'
import { ensureDailySummarySchedule } from './dailySummaryScheduler.js'
import { cancelReminderEvents, reconcileReminder } from './scheduler.js'

/** Idempotent migration after retiring the old entry points, or an explicit
 * subscription change. This function is never run on a periodic schedule. */
export async function bootstrapReminderSchedules(now = new Date()) {
  const data = await cloudStore.read()
  const sender = createAlarmEventSender()
  const noRecipients = !data.subscriptions.length
  for (const task of data.tasks) {
    if (task.completed || task.deletedAt) continue
    const reminders = task.reminders ?? (task.reminderEnabled && task.reminderAt ? [{ id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId, sentAt: task.reminderSentAt }] : [])
    if (noRecipients) {
      const cancelled: string[] = []
      for (const reminder of reminders) {
        if (!reminder.sentAt && reminder.eventId && await cloudStore.clearReminderEventIfCurrent(task.id, reminder.id, reminder.eventId, { requireNoSubscriptions: true })) cancelled.push(reminder.eventId)
      }
      await cancelReminderEvents(cancelled, sender)
    } else if (reminders.some(reminder => !reminder.sentAt && !reminder.eventId)) {
      await reconcileReminder({ todoId: task.id, oldEventIds: [] }, sender, now.getTime(), { includeOverdue: true })
    }
  }
  await ensureDailySummarySchedule(sender, now, { recoverOverdueAfterMs: 0 })
  if (noRecipients) return { migrated: 0, skipped: 'no-subscriptions' as const }
  const latest = await cloudStore.read()
  const events: AlarmEvent[] = []
  for (const task of latest.tasks) {
    if (task.completed || task.deletedAt) continue
    const legacy = !task.reminders
    const reminders = task.reminders ?? (task.reminderEnabled && task.reminderAt ? [{ id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId, sentAt: task.reminderSentAt }] : [])
    for (const reminder of reminders) {
      // New CF pointers were durably acknowledged by /events. Import only the
      // legacy pointers, whose original IDs keep the storage CAS checks valid.
      if (reminder.sentAt || !reminder.eventId || reminder.eventId.startsWith('cf:')) continue
      const delayUntil = Date.parse(reminder.at)
      if (!Number.isFinite(delayUntil)) throw new Error('旧提醒时间无效')
      events.push({ eventId: reminder.eventId, eventName: 'todo.reminder', data: legacy ? { todoId: task.id } : { todoId: task.id, reminderId: reminder.id }, delayUntil })
    }
  }
  const schedule = latest.dailySummarySchedule
  if (schedule && !schedule.eventId.startsWith('cf:')) events.push({ eventId: schedule.eventId, eventName: 'daily.summary', data: { scheduledFor: schedule.scheduledFor }, delayUntil: Date.parse(schedule.scheduledFor) })
  await importAlarmEvents(events)
  return { migrated: events.length }
}
