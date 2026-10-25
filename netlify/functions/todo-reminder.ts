import { asyncWorkloadFn, ErrorDoNotRetry, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { cloudStore } from '../../server/storage.js'
import { sendPushPayload } from '../../server/push.js'
import { cancelReminderEvents, TODO_REMINDER_EVENT } from '../../server/reminders/scheduler.js'
import { nextRecurringOccurrence, recurringReminderBody } from '../../server/reminders/recurrence.js'
import { createRootEventSender } from '../../server/reminders/rootEventSender.js'

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
    if (!pushed.sent && !pushed.subscriptions) {
      await cloudStore.clearReminderEventIfCurrent(todoId, reminderId, event.eventId)
      throw new ErrorDoNotRetry('没有可用的 Push Subscription，等待设备订阅后重新安排')
    }
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
  let nextEventId: string | null = null
  if (next) {
    try {
      nextEventId = await event.step.run(`schedule-next-root:${event.eventId}`, async () => {
        const scheduled = await createRootEventSender().send(TODO_REMINDER_EVENT, { data: { todoId, reminderId }, delayUntil: Date.parse(next.at) })
        if (scheduled.sendStatus !== 'succeeded') throw new Error('创建后续提醒事件失败')
        return scheduled.eventId
      })
    } catch {
      // This occurrence was delivered successfully. Leave the next occurrence
      // unbound for maintenance instead of stranding the delivered old event
      // after SDK retries are exhausted. Storage failures still retry with the
      // successful push cached above.
      await event.step.run(`advance-pending-reminder:${event.eventId}`, () => cloudStore.advanceReminderOccurrence(todoId, reminderId, event.eventId, next, null))
      console.warn('后续提醒安排失败，将由维护任务恢复')
      return
    }
  }
  // Keep the current event registered until its successor exists. A retry reuses
  // the cached event ID and successful delivery instead of sending either again.
  const advanced = await event.step.run(`advance-reminder-v2:${event.eventId}`, () => cloudStore.advanceReminderOccurrence(todoId, reminderId, event.eventId, next, nextEventId))
  if (!advanced && nextEventId) {
    const latest = await cloudStore.getTask(todoId)
    // Another attempt may have published this same cached successor already.
    if (reminderFor(latest, reminderId)?.eventId !== nextEventId) await cancelReminderEvents([nextEventId])
  }
}

export default asyncWorkloadFn<TodoReminderEvent>(handleTodoReminder)

export const asyncWorkloadConfig: AsyncWorkloadConfig<TodoReminderEvent> = {
  events: [TODO_REMINDER_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.todoId)
}
