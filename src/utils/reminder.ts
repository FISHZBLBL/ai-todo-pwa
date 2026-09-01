import type { ReminderMode, Task, TaskReminder } from '../types'

type ReminderFields = Pick<Task, 'dueDate' | 'startTime' | 'reminderMode' | 'reminders'> & { reminderEnabled?: boolean; reminderAt?: string | null }
type ReminderPatch = Partial<Pick<Task, 'dueDate' | 'startTime' | 'reminderMode' | 'reminders'>>

export function reminderAtFromStartTime(dueDate?: string | null, startTime?: string | null) {
  if (!dueDate || !startTime) return null
  const value = new Date(`${dueDate}T${startTime}:00`)
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}

export function automaticReminder(dueDate?: string | null, startTime?: string | null): Pick<Task, 'reminderMode' | 'reminders'> {
  const reminderAt = reminderAtFromStartTime(dueDate, startTime)
  return reminderAt
    ? { reminderMode: 'auto' as const, reminders: [{ id: 'auto', at: reminderAt, eventId: null, sentAt: null, source: 'auto' }] }
    : { reminderMode: 'off' as const, reminders: [] }
}

function sameInstant(left?: string | null, right?: string | null) {
  if (!left || !right) return false
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

export function inferReminderMode(task: Pick<Task, 'dueDate' | 'startTime' | 'reminders'> & { reminderEnabled?: boolean; reminderAt?: string | null }): ReminderMode {
  const reminders = task.reminders ?? (task.reminderEnabled && task.reminderAt ? [task.reminderAt === reminderAtFromStartTime(task.dueDate, task.startTime) ? { id: 'auto', at: task.reminderAt, eventId: null, sentAt: null, source: 'auto' as const } : explicitReminder(task.reminderAt, 'legacy')] : [])
  if (!reminders.length) return 'off'
  return reminders.length === 1 && reminders[0]?.source === 'auto' && sameInstant(reminders[0].at, reminderAtFromStartTime(task.dueDate, task.startTime)) ? 'auto' : 'explicit'
}

export function resolveReminderState(previous: ReminderFields | undefined, patch: ReminderPatch) {
  const dueDate = patch.dueDate !== undefined ? patch.dueDate : previous?.dueDate ?? null
  const startTime = patch.startTime !== undefined ? patch.startTime : previous?.startTime ?? null
  const requestedMode = patch.reminderMode

  if (!previous) {
    if (requestedMode === 'explicit') {
      if (patch.reminders?.length) return { reminderMode: 'explicit' as const, reminders: patch.reminders }
    }
    if (requestedMode === 'off') return { reminderMode: 'off' as const, reminders: [] }
    return automaticReminder(dueDate, startTime)
  }

  const previousReminders = previous.reminders ?? (previous.reminderEnabled && previous.reminderAt ? [previous.reminderMode === 'auto' ? { ...(automaticReminder(previous.dueDate, previous.startTime).reminders?.[0] ?? explicitReminder(previous.reminderAt)), at: previous.reminderAt } : explicitReminder(previous.reminderAt, 'legacy')] : [])
  const mode = requestedMode ?? previous.reminderMode
  if (mode === 'off') return { reminderMode: 'off' as const, reminders: [] }
  if (mode === 'auto') return automaticReminder(dueDate, startTime)
  const reminders = patch.reminders ?? previousReminders
  if (!reminders.length) return { reminderMode: 'off' as const, reminders: [] }
  return { reminderMode: 'explicit' as const, reminders }
}

export function explicitReminder(at: string, id: string = crypto.randomUUID()): TaskReminder { return { id, at, eventId: null, sentAt: null, source: 'explicit' } }

export type ReminderAttentionStatus = 'sent' | 'unsent'

export function getReminderAttention(task: Pick<Task, 'reminders' | 'completed' | 'deletedAt'>, now = new Date()) {
  if (task.completed || task.deletedAt) return null
  const currentTime = now.getTime()
  const reached = task.reminders.flatMap(reminder => {
    const at = Date.parse(reminder.at)
    return Number.isFinite(at) && at <= currentTime ? [{ reminder, at }] : []
  })
  if (!reached.length) return null
  return {
    status: (reached.some(({ reminder }) => !reminder.sentAt) ? 'unsent' : 'sent') as ReminderAttentionStatus,
    latestAt: Math.max(...reached.map(item => item.at)),
  }
}

export function hasMissedReminder(task: Pick<Task, 'reminders' | 'completed' | 'deletedAt'>, now = new Date()) {
  return getReminderAttention(task, now)?.status === 'unsent'
}
