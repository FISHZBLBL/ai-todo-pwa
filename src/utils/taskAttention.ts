import type { Task } from '../types'
import { isOverdue, taskOverdueAt } from './date'
import { getReminderAttention, type ReminderAttentionStatus } from './reminder'

export interface TaskAttention {
  overdue: boolean
  reminderStatus: ReminderAttentionStatus | null
  attentionAt: number
}

export function getTaskAttention(task: Task, now = new Date()): TaskAttention | null {
  if (task.completed || task.deletedAt) return null
  const overdue = isOverdue(task, now)
  const reminder = getReminderAttention(task, now)
  if (!overdue && !reminder) return null
  const overdueAt = overdue ? taskOverdueAt(task) : null
  return {
    overdue,
    reminderStatus: reminder?.status ?? null,
    attentionAt: Math.max(overdueAt ?? Number.NEGATIVE_INFINITY, reminder?.latestAt ?? Number.NEGATIVE_INFINITY),
  }
}
