import { asyncWorkloadFn, ErrorDoNotRetry, ErrorRetryAfterDelay, type AsyncWorkloadConfig, type AsyncWorkloadEvent, type CustomAsyncWorkloadEvent } from '@netlify/async-workloads'
import { cloudStore } from '../../server/storage.js'
import { sendPushPayload } from '../../server/push.js'
import { TODO_REMINDER_EVENT } from '../../server/reminders/scheduler.js'

interface TodoReminderEvent extends CustomAsyncWorkloadEvent {
  eventName: typeof TODO_REMINDER_EVENT
  eventData: { todoId: string }
}

function isCurrent(task: Awaited<ReturnType<typeof cloudStore.getTask>>, todoId: string, eventId: string) {
  return Boolean(task && task.id === todoId && task.reminderEnabled && task.reminderAt && !task.completed && !task.deletedAt && task.reminderEventId === eventId && !task.reminderSentAt)
}

export async function handleTodoReminder(event: AsyncWorkloadEvent<TodoReminderEvent>) {
  const { todoId } = event.eventData
  const task = await cloudStore.getTask(todoId)
  if (!isCurrent(task, todoId, event.eventId)) return
  const reminderAt = Date.parse(task!.reminderAt!)
  if (reminderAt > Date.now() + 5_000) throw new ErrorRetryAfterDelay({ message: '提醒事件提前到达', retryDelay: reminderAt - Date.now(), forceDelayTime: true })
  const result = await event.step.run(`send-push:${event.eventId}`, async () => {
    const current = await cloudStore.getTask(todoId)
    if (!isCurrent(current, todoId, event.eventId)) return { stale: true as const, sent: 0, failed: 0, subscriptions: 0 }
    return { stale: false as const, ...(await sendPushPayload({ title: current!.title ?? '任务提醒', body: '该做这件事了', url: `/?todo=${encodeURIComponent(todoId)}`, tag: `todo-${todoId}-${event.eventId}` })) }
  })
  if (result.stale) return
  if (!result.sent && !result.subscriptions) throw new ErrorDoNotRetry('没有可用的 Push Subscription')
  if (!result.sent) throw new ErrorRetryAfterDelay({ message: 'Web Push 发送失败', retryDelay: '1m' })
  await event.step.run(`mark-sent:${event.eventId}`, () => cloudStore.markReminderSent(todoId, event.eventId))
}

export default asyncWorkloadFn<TodoReminderEvent>(handleTodoReminder)

export const asyncWorkloadConfig: AsyncWorkloadConfig<TodoReminderEvent> = {
  events: [TODO_REMINDER_EVENT],
  maxRetries: 4,
  eventFilter: event => Boolean(event.eventData?.todoId)
}
