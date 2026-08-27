import { db } from '../storage/database'
import type { SyncChange, Task } from '../types'

const queue = async (value: Task) => (await db()).add('syncQueue', { entity: 'task', value, queuedAt: new Date().toISOString() } satisfies SyncChange)

export const taskRepository = {
  async list(includeDeleted = false) {
    const tasks = await (await db()).getAll('tasks')
    return includeDeleted ? tasks : tasks.filter(task => !task.deletedAt)
  },
  async get(id: string) { return (await db()).get('tasks', id) },
  async save(task: Task, shouldQueue = true) {
    await (await db()).put('tasks', task)
    if (shouldQueue) await queue(task)
    return task
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
