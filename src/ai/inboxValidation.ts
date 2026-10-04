import { INPUT_LIMITS } from '../../shared/limits'
import type { ParsedInboxItem } from '../types'
import { checklistInputError } from '../utils/checklist'
import { hasIncompleteReminder } from './reminderPreview'

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const boundedInteger = (value: number | null) => value != null && Number.isInteger(value) && value >= 1 && value <= 365

export function parsedInboxItemError(item: ParsedInboxItem): string | null {
  if (item.kind === 'checklist') return checklistInputError(item.title, { sections: item.sections.map(section => ({
    id: '', title: section.title, note: section.note,
    items: section.items.filter(value => value.selected !== false).map(value => ({ id: '', text: value.text, completed: false }))
  })) })
  if (!item.title.trim()) return '请填写任务名称'
  if (item.title.trim().length > INPUT_LIMITS.taskTitle) return `任务名称最多 ${INPUT_LIMITS.taskTitle} 字`
  if (item.dueDate && !validDate(item.dueDate)) return '任务日期无效'
  if (item.dateRange && (!validDate(item.dateRange.start) || !validDate(item.dateRange.end) || item.dateRange.start > item.dateRange.end)) return '请填写有效的日期范围'
  if (item.dueDate && item.dateRange) return '日期与日期范围不能同时设置'
  if (item.startTime && (!item.dueDate || !validTime(item.startTime))) return '开始时间需要指定任务日期'
  if (item.endTime && (!item.startTime || !validTime(item.endTime) || item.endTime < item.startTime)) return '结束时间不能早于开始时间'
  if (item.url) { if (item.url.length > 4000) return '链接最多 4000 字'; try { new URL(item.url) } catch { return '请填写有效链接' } }
  if ((item.reminders?.length ?? 0) > INPUT_LIMITS.reminders) return `每个任务最多 ${INPUT_LIMITS.reminders} 条提醒`
  if (hasIncompleteReminder(item)) return '请补全每条提醒的日期和时间'
  for (const reminder of item.reminders ?? []) {
    if (!reminder.date || !validDate(reminder.date) || !reminder.time || !validTime(reminder.time)) return '提醒的日期或时间无效'
    const recurrence = reminder.recurrence
    if (!recurrence) continue
    if (!boundedInteger(recurrence.interval)) return '重复间隔须为 1–365 的整数'
    if (recurrence.end === 'count' && !boundedInteger(recurrence.count)) return '总次数须为 1–365 的整数'
    if (recurrence.end === 'date' && (!recurrence.until || !validDate(recurrence.until) || recurrence.until < reminder.date)) return '结束日期不能早于首次提醒'
  }
  return null
}
