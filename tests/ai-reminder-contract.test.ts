import { describe, expect, it } from 'vitest'
import { parsedTaskToTaskInput, hasIncompleteReminder } from '../src/ai/reminderPreview'
import type { ParsedTask } from '../src/types'
const preview = (reminders: ParsedTask['reminders']): ParsedTask => ({ title: '交材料', dueDate: '2026-09-10', dateRange: null, startTime: null, endTime: null, url: null, reminders })
describe('AI 多提醒契约', () => {
  it('两次明确提醒保存为同一任务的两条 reminder', () => { const saved = parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-01', time: '20:00', period: 'evening' }, { requested: true, date: '2026-09-09', time: '19:00', period: 'evening' }])); expect(saved.reminderMode).toBe('explicit'); expect(saved.reminders).toHaveLength(2) })
  it('自我修正由 parser 仅提供最终的一条 19:00 reminder', () => { const saved = parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-01', time: '19:00', period: 'evening' }])); expect(saved.reminders).toHaveLength(1); expect(saved.reminders?.[0]?.at).toBe(new Date(2026, 8, 1, 19, 0).toISOString()) })
  it('其中一条模糊时只标记该任务待补全，不丢失另一条', () => { const item = preview([{ requested: true, date: '2026-09-01', time: null, period: 'evening' }, { requested: true, date: '2026-09-09', time: '19:00', period: 'evening' }]); expect(hasIncompleteReminder(item)).toBe(true); expect(parsedTaskToTaskInput(item).reminders).toHaveLength(1) })
  it('提前一天和提前一小时可表达为两条完整 reminder', () => { expect(parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-09', time: '15:00', period: 'afternoon' }, { requested: true, date: '2026-09-10', time: '14:00', period: 'afternoon' }])).reminders).toHaveLength(2) })
})
