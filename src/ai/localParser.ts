import type { ParsedTask } from '../types'
import { parseNaturalTask } from '../utils/date'

export function parseLocalInbox(content: string, now = new Date()): ParsedTask[] {
  const segments = content.split(/[，,。；;\n]+/).map(value => value.trim()).filter(Boolean)
  let inheritedDueDate: string | null = null
  let inheritedRange: ParsedTask['dateRange'] = null
  return segments.map(segment => {
    const parsed = parseNaturalTask(segment, now)
    if (parsed.dueDate || parsed.dateRange) {
      inheritedDueDate = parsed.dueDate
      inheritedRange = parsed.dateRange
    } else if (inheritedDueDate || inheritedRange) {
      parsed.dueDate = inheritedDueDate
      parsed.dateRange = inheritedRange
    }
    return { ...parsed, selected: true }
  })
}
