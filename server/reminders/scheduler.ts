import { AsyncWorkloadsClient } from '@netlify/async-workloads'
import { cloudStore, type ReminderTransition } from '../storage.js'

export const TODO_REMINDER_EVENT = 'todo.reminder' as const
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000

export interface AsyncEventSender {
  send(eventName: string, options?: { data?: unknown; delayUntil?: number | string; priority?: number }): Promise<{ sendStatus: 'succeeded' | 'failed'; eventId: string }>
}

const defaultSender = () => new AsyncWorkloadsClient() as AsyncEventSender

export async function cancelReminderEvents(eventIds: string[], sender: AsyncEventSender = defaultSender()) {
  const unique = [...new Set(eventIds.filter(Boolean))]
  if (!unique.length) return
  const result = await sender.send('awl:delete-events', { data: { eventIds: unique } })
  if (result.sendStatus !== 'succeeded') throw new Error('取消旧提醒事件失败')
}

export async function reconcileReminder(transition: ReminderTransition, sender: AsyncEventSender = defaultSender(), now = Date.now()) {
  await cancelReminderEvents(transition.oldEventIds, sender)
  const task = await cloudStore.getTask(transition.todoId)
  if (!task || task.completed || task.deletedAt) return { skipped: 'disabled' as const }
  const legacy = !task.reminders
  const reminders = task.reminders ?? (task.reminderEnabled && task.reminderAt ? [{ id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId ?? null, sentAt: task.reminderSentAt ?? null }] : [])
  const created: string[] = []
  for (const reminder of reminders) {
    if (reminder.sentAt || reminder.eventId) continue
    const reminderAt = Date.parse(reminder.at)
    if (!Number.isFinite(reminderAt)) throw new Error('提醒时间无效')
    if (reminderAt <= now) continue
    if (reminderAt >= now + MAX_DELAY_MS) throw new Error('提醒时间不能超过一年')
    const result = await sender.send(TODO_REMINDER_EVENT, { data: legacy ? { todoId: task.id } : { todoId: task.id, reminderId: reminder.id }, delayUntil: reminderAt })
    if (result.sendStatus !== 'succeeded') throw new Error('创建提醒事件失败')
    const stored = legacy ? await cloudStore.setReminderEvent(task.id, reminder.at, result.eventId) : await cloudStore.setReminderEvent(task.id, reminder.id, reminder.at, result.eventId)
    if (!stored) { await cancelReminderEvents([result.eventId], sender); continue }
    created.push(result.eventId)
  }
  return legacy && created.length === 1 ? { eventId: created[0] } : { eventIds: created }
}

export async function reconcileReminderTransitions(transitions: ReminderTransition[], sender?: AsyncEventSender) {
  if (!transitions.length) return
  const client = sender ?? defaultSender()
  for (const transition of transitions) await reconcileReminder(transition, client)
}
