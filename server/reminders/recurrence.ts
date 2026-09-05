interface Recurrence {
  unit: 'day' | 'week'
  interval: number
  end: 'never' | 'count' | 'date'
  count: number | null
  until: string | null
  occurrence: number
  timezone: string
  countdown: boolean
}

interface RecurringReminder { at: string; recurrence?: Recurrence | null }

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value ?? 0)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

const pad = (value: number) => `${value}`.padStart(2, '0')
const dateKey = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`

function zonedTimestamp(date: string, hour: number, minute: number, timezone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = wanted
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(new Date(timestamp), timezone)
    timestamp += wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
  }
  return timestamp
}

export function nextRecurringOccurrence(reminder: RecurringReminder) {
  const rule = reminder.recurrence
  if (!rule) return null
  const occurrence = rule.occurrence + 1
  if (rule.end === 'count' && rule.count != null && occurrence > rule.count) return null
  const current = localParts(new Date(reminder.at), rule.timezone)
  const days = rule.interval * (rule.unit === 'week' ? 7 : 1)
  const nextDateValue = new Date(Date.UTC(current.year, current.month - 1, current.day + days))
  const nextDate = dateKey(nextDateValue.getUTCFullYear(), nextDateValue.getUTCMonth() + 1, nextDateValue.getUTCDate())
  if (rule.end === 'date' && rule.until && nextDate > rule.until) return null
  return {
    at: new Date(zonedTimestamp(nextDate, current.hour, current.minute, rule.timezone)).toISOString(),
    recurrence: { ...rule, occurrence }
  }
}

export function recurringReminderBody(title: string, reminder: RecurringReminder) {
  const rule = reminder.recurrence
  if (!rule?.countdown) return '该做这件事了'
  if (rule.end === 'count' && rule.count != null) {
    const remaining = Math.max(0, rule.count - rule.occurrence)
    if (remaining === 0) return '已到设定期限，请停止使用'
    return `还剩 ${remaining} ${rule.unit === 'week' ? '周' : '天'}到期`
  }
  return `${title}的期限正在接近`
}
