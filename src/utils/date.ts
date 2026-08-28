import type { DateRange } from '../types'

const pad = (value: number) => `${value}`.padStart(2, '0')
export const toDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export const addDays = (date: Date, days: number) => { const result = new Date(date); result.setDate(result.getDate() + days); return result }
export const startOfDay = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

export function nextWeekRange(now = new Date()): DateRange {
  const day = now.getDay() || 7
  const nextMonday = addDays(startOfDay(now), 8 - day)
  return { start: toDateKey(nextMonday), end: toDateKey(addDays(nextMonday, 4)) }
}

export function weekendRange(now = new Date()): DateRange {
  const day = now.getDay()
  const saturday = addDays(startOfDay(now), day === 0 ? -1 : 6 - day)
  return { start: toDateKey(saturday), end: toDateKey(addDays(saturday, 1)) }
}

const cnHour = (raw: string) => {
  const digits = raw.match(/\d{1,2}/)?.[0]
  if (digits) return Number(digits)
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
  return map[raw]
}

export interface LocalParseResult { title: string; dueDate: string | null; dateRange: DateRange | null; startTime: string | null; endTime: string | null; url: string | null }

export function parseNaturalTask(input: string, now = new Date()): LocalParseResult {
  let title = input.trim()
  let dueDate: string | null = null
  let dateRange: DateRange | null = null
  if (/后天/.test(title)) { dueDate = toDateKey(addDays(now, 2)); title = title.replace(/后天/, '') }
  else if (/明天/.test(title)) { dueDate = toDateKey(addDays(now, 1)); title = title.replace(/明天/, '') }
  else if (/今天/.test(title)) { dueDate = toDateKey(now); title = title.replace(/今天/, '') }
  else if (/下周/.test(title)) { dateRange = nextWeekRange(now); title = title.replace(/下周/, '') }
  else if (/周末|本周末/.test(title)) { dateRange = weekendRange(now); title = title.replace(/本?周末/, '') }

  let startTime: string | null = null
  let endTime: string | null = null
  const normalizedHour = (raw: string, period = '') => {
    let hour = cnHour(raw)
    if (hour != null && /下午|晚上/.test(period) && hour < 12) hour += 12
    if (hour != null && period === '中午' && hour < 11) hour += 12
    return hour != null && hour >= 0 && hour <= 23 ? hour : null
  }
  const timedRange = title.match(/(上午|下午|晚上|中午)?([一二两三四五六七八九十\d]{1,3})点(?:到|至)(上午|下午|晚上|中午)?([一二两三四五六七八九十\d]{1,3})点/)
  const timed = title.match(/(上午|下午|晚上|中午)?([一二两三四五六七八九十\d]{1,3})点(?:([0-5]?\d)分)?/)
  if (timedRange) {
    const start = normalizedHour(timedRange[2], timedRange[1] ?? '')
    const end = normalizedHour(timedRange[4], timedRange[3] ?? timedRange[1] ?? '')
    if (start != null && end != null) { startTime = `${pad(start)}:00`; endTime = `${pad(end)}:00`; title = title.replace(timedRange[0], '') }
  } else if (timed) {
    const hour = normalizedHour(timed[2], timed[1] ?? '')
    if (hour != null) { startTime = `${pad(hour)}:${pad(Number(timed[3] ?? 0))}`; title = title.replace(timed[0], '') }
  }
  const url = title.match(/https?:\/\/[^\s，,。]+/)?.[0] ?? null
  return { title: title.replace(/^(记得|请|要)\s*/, '').replace(/^[，,、\s]+|[，,、\s]+$/g, '') || input.trim(), dueDate, dateRange, startTime, endTime, url }
}

export const taskDateKey = (task: { dueDate?: string | null; dateRange?: DateRange | null }) => task.dueDate ?? task.dateRange?.start ?? null
export const isOverdue = (task: { dueDate?: string | null; dateRange?: DateRange | null; completed?: boolean }, now = new Date()) => {
  const key = task.dueDate ?? task.dateRange?.end
  return Boolean(key && key < toDateKey(now) && !task.completed)
}

export function formatTaskDate(task: { dueDate?: string | null; dateRange?: DateRange | null }, now = new Date()) {
  const today = toDateKey(now), tomorrow = toDateKey(addDays(now, 1))
  if (task.dueDate === today) return '今天'
  if (task.dueDate === tomorrow) return '明天'
  if (task.dueDate) return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(`${task.dueDate}T00:00:00`))
  const next = nextWeekRange(now), weekend = weekendRange(now)
  if (task.dateRange?.start === next.start && task.dateRange.end === next.end) return '下周'
  if (task.dateRange?.start === weekend.start && task.dateRange.end === weekend.end) return '本周末'
  if (task.dateRange) return `${task.dateRange.start.slice(5)}–${task.dateRange.end.slice(5)}`
  return '无日期'
}
