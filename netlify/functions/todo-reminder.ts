import { asyncWorkloadFn, ErrorDoNotRetry, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { cloudStore } from '../../server/storage.js'
import { sendPushPayload } from '../../server/push.js'
import { TODO_REMINDER_EVENT } from '../../server/reminders/scheduler.js'
import { nextRecurringOccurrence, recurringReminderBody } from '../../server/reminders/recurrence.js'

interface TodoReminderEvent extends CustomAsyncWorkloadEvent {
  eventName: typeof TODO_REMINDER_EVENT
  eventData: { todoId: string; reminderId?: string }
}

function reminderFor(task: Awaited<ReturnType<typeof cloudStore.getTask>>, reminderId: string) {
  return task?.reminders?.find(item => item.id === reminderId) ?? (!task?.reminders && task?.reminderEnabled && task.reminderAt ? { id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId ?? null, sentAt: task.reminderSentAt ?? null } : undefined)
}
function isCurrent(task: Awaited<ReturnType<typeof cloudStore.getTask>>, todoId: string, reminderId: string, eventId: string) {
  const reminder = reminderFor(task, reminderId)
  return Boolean(task && reminder && task.id === todoId && reminder.at && !task.completed && !task.deletedAt && reminder.eventId === eventId && !reminder.sentAt)
}

export async function handleTodoReminder(event: AsyncWorkloadEvent<TodoReminderEvent>) {
  const { todoId } = event.eventData
  const reminderId = event.eventData.reminderId ?? 'legacy'
  const task = await cloudStore.getTask(todoId)
  if (!isCurrent(task, todoId, reminderId, event.eventId)) {
    const pending = reminderFor(task, reminderId)
    if (task && !task.completed && !task.deletedAt && pending && !pending.eventId && !pending.sentAt) throw new ErrorRetryAfterDelay({ message: '提醒事件等待登记', retryDelay: '1m' })
    return
  }
  const reminderAt = Date.parse(reminderFor(task, reminderId)!.at)
  if (reminderAt > Date.now() + 5_000) throw new ErrorRetryAfterDelay({ message: '提醒事件提前到达', retryDelay: reminderAt - Date.now(), forceDelayTime: true })
  const deliver = async () => {
    const current = await cloudStore.getTask(todoId)
    if (!isCurrent(current, todoId, reminderId, event.eventId)) return { stale: true as const, sent: 0, failed: 0, subscriptions: 0 }
    const currentReminder = reminderFor(current, reminderId)!
    const pushed = await sendPushPayload({ title: current!.title ?? '任务提醒', body: recurringReminderBody(current!.title ?? '任务提醒', currentReminder), url: `/?todo=${encodeURIComponent(todoId)}`, tag: `todo-${todoId}-${event.eventId}` })
    // A returned value is cached by step.run. Failed deliveries must throw inside
    // the callback so a later attempt actually contacts the push service again.
    if (!pushed.sent && !pushed.subscriptions) throw new ErrorDoNotRetry('没有可用的 Push Subscription')
    if (!pushed.sent) throw new ErrorRetryAfterDelay({ message: 'Web Push 发送失败', retryDelay: '1m' })
    return { stale: false as const, ...pushed }
  }
  let result = await event.step.run(`send-push:${event.eventId}`, deliver)
  // Events created by earlier deployments may already have a cached failed
  // result. Re-run only those failures under a new step key; keep successful
  // delivery caches so storage retries do not send the notification again.
  if (!result.stale && !result.sent) result = await event.step.run(`retry-send-push-v2:${event.eventId}`, deliver)
  if (result.stale) return
  const current = await cloudStore.getTask(todoId)
  if (!isCurrent(current, todoId, reminderId, event.eventId)) return
  const currentReminder = reminderFor(current, reminderId)
  if (!currentReminder?.recurrence) {
    await event.step.run(`mark-sent:${event.eventId}`, () => task?.reminders ? cloudStore.markReminderSent(todoId, reminderId, event.eventId) : cloudStore.markReminderSent(todoId, event.eventId))
    return
  }
  const next = nextRecurringOccurrence(currentReminder)
  // The independent maintenance schedule creates the next root event. Sending it
  // from this workload would grow the SDK's event chain until the chain limit.
  await event.step.run(`advance-reminder:${event.eventId}`, () => cloudStore.advanceReminderOccurrence(todoId, reminderId, event.eventId, next, null))
}

export default asyncWorkloadFn<TodoReminderEvent>(handleTodoReminder)

export const asyncWorkloadConfig: AsyncWorkloadConfig<TodoReminderEvent> = {
  events: [TODO_REMINDER_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.todoId)
}
