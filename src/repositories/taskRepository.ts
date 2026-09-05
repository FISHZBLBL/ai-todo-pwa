import { db } from '../storage/database'
import type { SyncChange, Task } from '../types'
import { automaticReminder, explicitReminder } from '../utils/reminder'

export function normalizeTask(value: Task | (Partial<Task> & Record<string, unknown>)): Task {
  const legacy = value as Partial<Task> & { date?: string | null; time?: string | null; reminderEnabled?: boolean; reminderAt?: string | null; reminderEventId?: string | null; reminderSentAt?: string | null }
  const dueDate = value.dueDate ?? legacy.date ?? null
  const startTime = value.startTime ?? legacy.time ?? null
  const auto = automaticReminder(dueDate, startTime).reminders ?? []
  // Pinia makes nested task data reactive. IndexedDB cannot structured-clone
  // Proxy arrays/objects, so the repository boundary must always own a plain
  // serializable copy rather than retaining reactive references.
  const reminders = Array.isArray(value.reminders) ? value.reminders.map(reminder => ({ ...reminder, recurrence: reminder.recurrence ? { ...reminder.recurrence } : null })) : legacy.reminderEnabled && legacy.reminderAt ? [legacy.reminderMode === 'auto' ? { ...(auto[0] ?? explicitReminder(legacy.reminderAt, 'legacy')), eventId: legacy.reminderEventId ?? null, sentAt: legacy.reminderSentAt ?? null } : { ...explicitReminder(legacy.reminderAt, 'legacy'), eventId: legacy.reminderEventId ?? null, sentAt: legacy.reminderSentAt ?? null }] : []
  const dateRange = value.dateRange ? { ...value.dateRange } : null
  const { reminderEnabled: _enabled, reminderAt: _at, reminderEventId: _event, reminderSentAt: _sent, ...rest } = value as typeof legacy
  return {
    ...rest,
    dueDate,
    dateRange,
    startTime,
    reminderMode: value.reminderMode ?? (reminders.length ? (reminders[0]?.source === 'auto' ? 'auto' : 'explicit') : 'off'),
    reminders,
    sortOrder: value.sortOrder ?? null
  } as Task
}

export const taskRepository = {
  async list(includeDeleted = false) {
    const tasks = await (await db()).getAll('tasks')
    const normalized = tasks.map(normalizeTask)
    return includeDeleted ? normalized : normalized.filter(task => !task.deletedAt)
  },
  async get(id: string) { const task = await (await db()).get('tasks', id); return task ? normalizeTask(task) : undefined },
  async save(task: Task, shouldQueue = true) {
    const normalized = normalizeTask(task)
    const database = await db()
    // Persist the task and its sync intent atomically. If an installed PWA is
    // closed immediately after an action, it must never keep one without the
    // other and later let stale cloud state resurrect the task.
    const transaction = database.transaction(['tasks', 'syncQueue'], 'readwrite')
    await transaction.objectStore('tasks').put(normalized)
    if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'task', value: normalized, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return normalized
  },
  async saveMany(tasks: Task[], shouldQueue = true) {
    for (const task of tasks) await this.save(task, shouldQueue)
    return tasks
  },
  async removePermanently(id: string) { await (await db()).delete('tasks', id) },
  async purgeExpiredTombstones(now = new Date()) {
    const cutoff = now.getTime() - 30 * 86400000
    const tasks = await this.list(true)
    for (const task of tasks) if (task.deletedAt && Date.parse(task.deletedAt) < cutoff) await this.removePermanently(task.id)
  }
}
