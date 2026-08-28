import { db } from '../storage/database'
import type { SyncChange, Task } from '../types'

const queue = async (value: Task) => (await db()).add('syncQueue', { entity: 'task', value, queuedAt: new Date().toISOString() } satisfies SyncChange)

export function normalizeTask(value: Task | (Partial<Task> & Record<string, unknown>)): Task {
  const legacy = value as Partial<Task> & { date?: string | null; time?: string | null }
  const dueDate = value.dueDate ?? legacy.date ?? null
  const startTime = value.startTime ?? legacy.time ?? null
  return {
    ...value,
    dueDate,
    startTime,
    reminderEnabled: value.reminderEnabled ?? false,
    reminderAt: value.reminderAt ?? null,
    reminderEventId: value.reminderEventId ?? null,
    reminderSentAt: value.reminderSentAt ?? null
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
    await (await db()).put('tasks', normalized)
    if (shouldQueue) await queue(normalized)
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
