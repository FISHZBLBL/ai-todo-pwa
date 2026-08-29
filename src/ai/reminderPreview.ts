import type { ParsedTask, Task } from '../types'
import { explicitReminder, reminderAtFromStartTime } from '../utils/reminder'

export function hasIncompleteReminder(task: ParsedTask) {
  return [...(task.reminders ?? []), ...(task.reminder ? [task.reminder] : [])].some(reminder => !reminder.date || !reminder.time)
}

export function parsedTaskToTaskInput(task: ParsedTask): Partial<Task> & Pick<Task, 'title'> {
  const base = {
    title: task.title,
    dueDate: task.dueDate,
    dateRange: task.dateRange,
    startTime: task.startTime,
    endTime: task.endTime,
    url: task.url
  }
  const reminders = [...(task.reminders ?? []), ...(task.reminder ? [task.reminder] : [])].flatMap(reminder => {
    if (!reminder.date || !reminder.time) return []
    const at = reminderAtFromStartTime(reminder.date, reminder.time)
    return at ? [explicitReminder(at)] : []
  })
  return reminders.length ? { ...base, reminderMode: 'explicit', reminders } : base
}
