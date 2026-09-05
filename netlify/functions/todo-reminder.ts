import { AsyncWorkloadsClient, asyncWorkloadFn, ErrorDoNotRetry, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { cloudStore } from '../../server/storage.js'
import { sendPushPayload } from '../../server/push.js'
import { TODO_REMINDER_EVENT, type AsyncEventSender } from '../../server/reminders/scheduler.js'
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

export async function handleTodoReminder(event: AsyncWorkloadEvent<TodoReminderEvent>, sender?: AsyncEventSender) {
  const { todoId } = event.eventData
  const reminderId = event.eventData.reminderId ?? 'legacy'
  const task = await cloudStore.getTask(todoId)
  if (!isCurrent(task, todoId, reminderId, event.eventId)) return
  const reminderAt = Date.parse(reminderFor(task, reminderId)!.at)
  if (reminderAt > Date.now() + 5_000) throw new ErrorRetryAfterDelay({ message: '提醒事件提前到达', retryDelay: reminderAt - Date.now(), forceDelayTime: true })
  const result = await event.step.run(`send-push:${event.eventId}`, async () => {
    const current = await cloudStore.getTask(todoId)
    if (!isCurrent(current, todoId, reminderId, event.eventId)) return { stale: true as const, sent: 0, failed: 0, subscriptions: 0 }
    const currentReminder = reminderFor(current, reminderId)!
    return { stale: false as const, ...(await sendPushPayload({ title: current!.title ?? '任务提醒', body: recurringReminderBody(current!.title ?? '任务提醒', currentReminder), url: `/?todo=${encodeURIComponent(todoId)}`, tag: `todo-${todoId}-${event.eventId}` })) }
  })
  if (result.stale) return
  if (!result.sent && !result.subscriptions) throw new ErrorDoNotRetry('没有可用的 Push Subscription')
  if (!result.sent) throw new ErrorRetryAfterDelay({ message: 'Web Push 发送失败', retryDelay: '1m' })
  const current = await cloudStore.getTask(todoId)
  const currentReminder = reminderFor(current, reminderId)
  if (!currentReminder?.recurrence) {
    await event.step.run(`mark-sent:${event.eventId}`, () => task?.reminders ? cloudStore.markReminderSent(todoId, reminderId, event.eventId) : cloudStore.markReminderSent(todoId, event.eventId))
    return
  }
  const next = nextRecurringOccurrence(currentReminder)
  let nextEventId: string | null = null
  if (next) {
    const eventSender = sender ?? new AsyncWorkloadsClient() as AsyncEventSender
    const scheduled = await event.step.run(`schedule-next:${event.eventId}`, () => eventSender.send(TODO_REMINDER_EVENT, { data: { todoId, reminderId }, delayUntil: Date.parse(next.at) }))
    if (scheduled.sendStatus !== 'succeeded') throw new ErrorRetryAfterDelay({ message: '下一次重复提醒创建失败', retryDelay: '1m' })
    nextEventId = scheduled.eventId
  }
  const advanced = await event.step.run(`advance-reminder:${event.eventId}`, () => cloudStore.advanceReminderOccurrence(todoId, reminderId, event.eventId, next, nextEventId))
  if (!advanced && nextEventId) await (sender ?? new AsyncWorkloadsClient() as AsyncEventSender).send('awl:delete-events', { data: { eventIds: [nextEventId] } })
}

export default asyncWorkloadFn<TodoReminderEvent>(handleTodoReminder)

export const asyncWorkloadConfig: AsyncWorkloadConfig<TodoReminderEvent> = {
  events: [TODO_REMINDER_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.todoId)
}
