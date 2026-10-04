import { describe, expect, it } from 'vitest'
import { parsedTaskToTaskInput, hasIncompleteReminder } from '../src/ai/reminderPreview'
import type { ParsedTask } from '../src/types'
const preview = (reminders: ParsedTask['reminders']): ParsedTask => ({ title: '交材料', dueDate: '2026-09-10', dateRange: null, startTime: null, endTime: null, url: null, reminders })
describe('AI 多提醒契约', () => {
  it('两次明确提醒保存为同一任务的两条 reminder', () => { const saved = parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-01', time: '20:00', period: 'evening' }, { requested: true, date: '2026-09-09', time: '19:00', period: 'evening' }])); expect(saved.reminderMode).toBe('explicit'); expect(saved.reminders).toHaveLength(2) })
  it('自我修正由 parser 仅提供最终的一条 19:00 reminder', () => { const saved = parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-01', time: '19:00', period: 'evening' }])); expect(saved.reminders).toHaveLength(1); expect(saved.reminders?.[0]?.at).toBe(new Date(2026, 8, 1, 19, 0).toISOString()) })
  it('其中一条模糊时禁止保存，避免静默丢失这一条提醒', () => { const item = preview([{ requested: true, date: '2026-09-01', time: null, period: 'evening' }, { requested: true, date: '2026-09-09', time: '19:00', period: 'evening' }]); expect(hasIncompleteReminder(item)).toBe(true); expect(() => parsedTaskToTaskInput(item)).toThrow('请补全每条提醒的日期和时间') })
  it('重复提醒时间被清空时预览标记为待补全，转换默认时间也不会丢失提醒', () => {
    const item = preview([{ requested: true, date: '2026-09-01', time: '', period: null, recurrence: { unit: 'week', interval: 1, end: 'count', count: 3, until: null, countdown: false } }])
    expect(hasIncompleteReminder(item)).toBe(true)
    expect(parsedTaskToTaskInput(item, { dailySummaryTime: '09:30', timezone: 'Asia/Shanghai' }).reminders).toHaveLength(1)
    expect(parsedTaskToTaskInput(item, { dailySummaryTime: '09:30' }).reminders?.[0].at).toBe(new Date(2026, 8, 1, 9, 30).toISOString())
  })
  it('提前一天和提前一小时可表达为两条完整 reminder', () => { expect(parsedTaskToTaskInput(preview([{ requested: true, date: '2026-09-09', time: '15:00', period: 'afternoon' }, { requested: true, date: '2026-09-10', time: '14:00', period: 'afternoon' }])).reminders).toHaveLength(2) })
})
