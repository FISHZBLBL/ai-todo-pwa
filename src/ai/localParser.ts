import type { ParsedTask } from '../types'
import { parseNaturalTask } from '../utils/date'

export function parseLocalInbox(content: string, now = new Date()): ParsedTask[] {
  const segments = content.split(/[，,。；;\n]+/).map(value => value.trim()).filter(Boolean)
  let inheritedDate: string | null = null
  let inheritedRange: ParsedTask['dateRange'] = null
  return segments.map(segment => {
    const parsed = parseNaturalTask(segment, now)
    if (parsed.date || parsed.dateRange) {
      inheritedDate = parsed.date
      inheritedRange = parsed.dateRange
    } else if (inheritedDate || inheritedRange) {
      parsed.date = inheritedDate
      parsed.dateRange = inheritedRange
    }
    return { ...parsed, selected: true }
  })
}
