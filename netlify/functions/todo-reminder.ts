import { ErrorDoNotRetry, ErrorRetryAfterDelay, type WorkflowEvent } from '../../server/reminders/workflow.js'
import { cloudStore } from '../../server/storage.js'
import { sendPushPayload } from '../../server/push.js'
import { cancelReminderEvents, TODO_REMINDER_EVENT } from '../../server/reminders/scheduler.js'
import { nextRecurringOccurrence, recurringReminderBody } from '../../server/reminders/recurrence.js'
import { createRootEventSender } from '../../server/reminders/rootEventSender.js'

interface TodoReminderEvent {
  eventName: typeof TODO_REMINDER_EVENT
  eventData: { todoId: string; reminderId?: string; expectedAt?: string; expectedUpdatedAt?: string; previousEventId?: string }
}

function reminderFor(task: Awaited<ReturnType<typeof cloudStore.getTask>>, reminderId: string) {
  return task?.reminders?.find(item => item.id === reminderId) ?? (!task?.reminders && task?.reminderEnabled && task.reminderAt ? { id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId ?? null, sentAt: task.reminderSentAt ?? null } : undefined)
}
function isCurrent(task: Awaited<ReturnType<typeof cloudStore.getTask>>, todoId: string, reminderId: string, eventId: string) {
  const reminder = reminderFor(task, reminderId)
  return Boolean(task && reminder && task.id === todoId && reminder.at && !task.completed && !task.deletedAt && reminder.eventId === eventId && !reminder.sentAt)
}

export async function handleTodoReminder(event: WorkflowEvent<TodoReminderEvent>) {
  const { todoId } = event.eventData
  const reminderId = event.eventData.reminderId ?? 'legacy'
  let task = await cloudStore.getTask(todoId)
  const { expectedAt, expectedUpdatedAt, previousEventId } = event.eventData
  const initialReminder = reminderFor(task, reminderId)
  // The alarm may have been persisted immediately before the API process died
  // while binding its ID. Recover only the exact saved task version, under CAS.
  if (!isCurrent(task, todoId, reminderId, event.eventId) && expectedAt && expectedUpdatedAt && !previousEventId && task && initialReminder && !initialReminder.eventId && !initialReminder.sentAt && initialReminder.at === expectedAt && task.updatedAt === expectedUpdatedAt && !task.completed && !task.deletedAt) {
    await cloudStore.bindUnregisteredReminder(todoId, reminderId, expectedAt, event.eventId, expectedUpdatedAt)
    task = await cloudStore.getTask(todoId)
  }
  if (!isCurrent(task, todoId, reminderId, event.eventId)) {
    const pending = reminderFor(task, reminderId)
    const awaitingInitialBinding = !pending?.eventId && !previousEventId && (!expectedUpdatedAt || (task?.updatedAt === expectedUpdatedAt && pending?.at === expectedAt))
    const awaitingParentAdvance = Boolean(previousEventId && pending?.eventId === previousEventId && pending.recurrence)
    if (task && !task.completed && !task.deletedAt && pending && !pending.sentAt && (awaitingInitialBinding || awaitingParentAdvance)) throw new ErrorRetryAfterDelay({ message: '提醒事件等待登记', retryDelay: '1m' })
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
      const cleared = await cloudStore.clearReminderEventIfCurrent(todoId, reminderId, event.eventId, { requireNoSubscriptions: true })
      if (!cleared) throw new ErrorRetryAfterDelay({ message: 'Push 订阅或事项已更新，等待重新投递', retryDelay: '1m' })
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
    nextEventId = await event.step.run(`schedule-next-root:${event.eventId}`, async () => {
      const nextAt = Date.parse(next.at)
      // A recovered series can contain several missed occurrences. Spread
      // those deliveries out instead of firing every old alarm immediately.
      const now = Date.now()
      const delayUntil = nextAt <= now ? now + 60_000 : nextAt
      const scheduled = await createRootEventSender().send(TODO_REMINDER_EVENT, { data: { todoId, reminderId, expectedAt: next.at, previousEventId: event.eventId }, delayUntil })
      if (scheduled.sendStatus !== 'succeeded') throw new Error('创建后续提醒事件失败')
      return scheduled.eventId
    })
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

// Delivery now enters the authenticated API callback. Retiring this endpoint
// also prevents old queued events from running alongside Cloudflare alarms.
export default async () => new Response(null, { status: 410 })
