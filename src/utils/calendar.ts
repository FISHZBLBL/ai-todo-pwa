import type { Task } from '../types'
import { toDateKey } from './date'

export interface CalendarDay {
  date: Date
  key: string
  inVisibleMonth: boolean
}

const fromDateKey = (key: string) => {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export const mondayIndex = (date: Date) => (date.getDay() + 6) % 7

export function monthGrid(visibleMonth: Date): CalendarDay[] {
  const firstOfMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  const gridStart = new Date(firstOfMonth)
  gridStart.setDate(firstOfMonth.getDate() - mondayIndex(firstOfMonth))

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)
    return {
      date,
      key: toDateKey(date),
      inVisibleMonth: date.getMonth() === visibleMonth.getMonth(),
    }
  })
}

export function activeDueDateTaskCounts(tasks: Iterable<Task>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.completed || task.deletedAt || !task.dueDate) continue
    counts.set(task.dueDate, (counts.get(task.dueDate) ?? 0) + 1)
  }
  return counts
}

/** Date keys are zero-padded local calendar dates, so inclusive comparison is timezone-safe. */
export const isDateKeyInRange = (dateKey: string, range: { start: string; end: string }) => dateKey >= range.start && dateKey <= range.end

export function activeCalendarTaskCounts(tasks: Iterable<Task>, days: Iterable<CalendarDay>): Map<string, number> {
  const counts = new Map<string, number>()
  const activeTasks = [...tasks].filter(task => !task.completed && !task.deletedAt)
  for (const day of days) {
    const count = activeTasks.filter(task => task.dueDate === day.key || (task.dateRange && isDateKeyInRange(day.key, task.dateRange))).length
    if (count) counts.set(day.key, count)
  }
  return counts
}

export const taskDotCount = (count: number | undefined) => Math.min(count ?? 0, 3)

export function activeTasksForDate(tasks: Iterable<Task>, dateKey: string): Task[] {
  return [...tasks].filter(task => !task.completed && !task.deletedAt && (task.dueDate === dateKey || (task.dateRange && isDateKeyInRange(dateKey, task.dateRange))))
}

export const dateFromKey = fromDateKey
