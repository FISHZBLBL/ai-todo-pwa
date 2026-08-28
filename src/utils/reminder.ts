export function reminderAtFromStartTime(dueDate?: string | null, startTime?: string | null) {
  if (!dueDate || !startTime) return null
  const value = new Date(`${dueDate}T${startTime}:00`)
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}

export function automaticReminder(dueDate?: string | null, startTime?: string | null) {
  const reminderAt = reminderAtFromStartTime(dueDate, startTime)
  return { reminderEnabled: Boolean(reminderAt), reminderAt }
}
