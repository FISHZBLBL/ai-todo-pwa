import { db } from '../storage/database'
import type { Draft, SyncChange, Task } from '../types'
import { automaticReminder, explicitReminder } from '../utils/reminder'
import { cloneChecklist } from '../utils/checklist'
import { draftValueSchema, taskValueSchema } from '../../shared/syncSchema'
import { nextTimestamp, validateRecord } from '../storage/validation'

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
    kind: value.kind === 'checklist' ? 'checklist' : 'task',
    dueDate,
    dateRange,
    startTime,
    reminderMode: value.reminderMode ?? (reminders.length ? (reminders[0]?.source === 'auto' ? 'auto' : 'explicit') : 'off'),
    reminders,
    sortOrder: value.sortOrder ?? null,
    checklist: value.kind === 'checklist' ? cloneChecklist(value.checklist) : null
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
    let normalized = validateRecord(taskValueSchema, normalizeTask(task))
    const database = await db()
    // Persist the task and its sync intent atomically. If an installed PWA is
    // closed immediately after an action, it must never keep one without the
    // other and later let stale cloud state resurrect the task.
    const transaction = database.transaction(['tasks', 'syncQueue'], 'readwrite')
    const previous = await transaction.objectStore('tasks').get(task.id)
    if (shouldQueue && previous && normalized.updatedAt <= previous.updatedAt) normalized = { ...normalized, updatedAt: nextTimestamp(previous.updatedAt) }
    await transaction.objectStore('tasks').put(normalized)
    if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'task', value: normalized, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return normalized
  },
  async update(id: string, updater: (current: Task) => Task): Promise<Task | undefined> {
    const database = await db()
    const transaction = database.transaction(['tasks', 'syncQueue'], 'readwrite')
    const current = await transaction.objectStore('tasks').get(id)
    if (!current) { await transaction.done; return undefined }
    let updated: Task
    try {
      updated = validateRecord(taskValueSchema, normalizeTask(updater(normalizeTask(current))))
      if (updated.id !== id) throw new Error('更新任务时不能修改标识')
      if (updated.updatedAt <= current.updatedAt) updated.updatedAt = nextTimestamp(current.updatedAt)
    } catch (error) {
      transaction.abort()
      await transaction.done.catch(() => undefined)
      throw error
    }
    await transaction.objectStore('tasks').put(updated)
    await transaction.objectStore('syncQueue').add({ entity: 'task', value: updated, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return updated
  },
  async saveMany(tasks: Task[], shouldQueue = true, consumedDraftId?: string) {
    const normalized = tasks.map(task => validateRecord(taskValueSchema, normalizeTask(task)))
    const transaction = (await db()).transaction(['tasks', 'drafts', 'syncQueue'], 'readwrite')
    const saved: Task[] = []
    try {
      const draft = consumedDraftId ? await transaction.objectStore('drafts').get(consumedDraftId) : undefined
      if (draft?.deletedAt) { await transaction.done; return saved }
      let consumed: Draft | undefined
      if (draft) {
        const now = nextTimestamp(draft.updatedAt)
        consumed = validateRecord(draftValueSchema, { ...draft, updatedAt: now, deletedAt: now })
      }
      for (let task of normalized) {
        const previous = await transaction.objectStore('tasks').get(task.id)
        if (shouldQueue && previous && task.updatedAt <= previous.updatedAt) task = { ...task, updatedAt: nextTimestamp(previous.updatedAt) }
        await transaction.objectStore('tasks').put(task)
        if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'task', value: task, queuedAt: new Date().toISOString() } satisfies SyncChange)
        saved.push(task)
      }
      if (consumed) {
        await transaction.objectStore('drafts').put(consumed)
        if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'draft', value: consumed, queuedAt: new Date().toISOString() } satisfies SyncChange)
      }
      await transaction.done
      return saved
    } catch (error) {
      try { transaction.abort() } catch { /* A failed IndexedDB request may have already aborted. */ }
      await transaction.done.catch(() => undefined)
      throw error
    }
  },
  async removePermanently(id: string) { await (await db()).delete('tasks', id) },
  async purgeExpiredTombstones(now = new Date()) {
    const cutoff = now.getTime() - 30 * 86400000
    const tasks = await this.list(true)
    for (const task of tasks) if (task.deletedAt && Date.parse(task.deletedAt) < cutoff) await this.removePermanently(task.id)
  }
}
