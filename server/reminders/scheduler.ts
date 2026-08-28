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
  if (!task?.reminderEnabled || !task.reminderAt || task.completed || task.deletedAt) return { skipped: 'disabled' as const }
  if (task.reminderSentAt) return { skipped: 'sent' as const }
  if (task.reminderEventId) return { skipped: 'scheduled' as const, eventId: task.reminderEventId }
  const reminderAt = Date.parse(task.reminderAt)
  if (!Number.isFinite(reminderAt)) throw new Error('提醒时间无效')
  if (reminderAt <= now) return { skipped: 'past' as const }
  if (reminderAt >= now + MAX_DELAY_MS) throw new Error('提醒时间不能超过一年')
  const result = await sender.send(TODO_REMINDER_EVENT, { data: { todoId: task.id }, delayUntil: reminderAt })
  if (result.sendStatus !== 'succeeded') throw new Error('创建提醒事件失败')
  if (!(await cloudStore.setReminderEvent(task.id, task.reminderAt, result.eventId))) {
    await cancelReminderEvents([result.eventId], sender)
    return { skipped: 'changed' as const }
  }
  return { eventId: result.eventId }
}

export async function reconcileReminderTransitions(transitions: ReminderTransition[], sender?: AsyncEventSender) {
  if (!transitions.length) return
  const client = sender ?? defaultSender()
  for (const transition of transitions) await reconcileReminder(transition, client)
}
