import type { ParsedTask, Task } from '../types'
import { explicitReminder, reminderAtFromStartTime } from '../utils/reminder'

export function hasIncompleteReminder(task: ParsedTask) {
  return (task.reminders ?? []).some(reminder => !reminder.date || (!reminder.time && !reminder.recurrence))
}

export function parsedTaskToTaskInput(task: ParsedTask, options: { dailySummaryTime?: string; timezone?: string } = {}): Partial<Task> & Pick<Task, 'title'> {
  const base = {
    title: task.title,
    dueDate: task.dueDate,
    dateRange: task.dateRange,
    startTime: task.startTime,
    endTime: task.endTime,
    url: task.url
  }
  const reminders = (task.reminders ?? []).flatMap(reminder => {
    const time = reminder.time ?? (reminder.recurrence ? options.dailySummaryTime ?? '08:00' : null)
    if (!reminder.date || !time) return []
    const at = reminderAtFromStartTime(reminder.date, time)
    if (!at) return []
    const value = explicitReminder(at)
    const recurrence = reminder.recurrence ? {
      ...reminder.recurrence,
      count: reminder.recurrence.end === 'count' ? reminder.recurrence.count : null,
      until: reminder.recurrence.end === 'date' ? reminder.recurrence.until : null,
      countdown: reminder.recurrence.end === 'count' && reminder.recurrence.countdown,
      occurrence: 1,
      timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    } : null
    return [{ ...value, recurrence }]
  })
  return reminders.length ? { ...base, reminderMode: 'explicit', reminders } : base
}
