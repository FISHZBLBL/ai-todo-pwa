import { describe, expect, it } from 'vitest'
import { normalizeAIResponse, parseAIResponse } from '../server/ai/response'

describe('AI response contract', () => {
  const completeTask = { title: '做实验', dueDate: '2026-08-30', dateRange: null, startTime: '15:00', endTime: null, url: null, reminders: [] }

  it('接受完整标准输出', () => expect(parseAIResponse({ tasks: [completeTask] })).toEqual({ tasks: [completeTask] }))
  it('缺少 nullable fields 时补为 null，reminders 补为空数组', () => expect(parseAIResponse({ tasks: [{ title: '做实验', dueDate: '2026-08-30', startTime: '15:00' }] })).toEqual({ tasks: [completeTask] }))
  it('接受模糊提醒', () => expect(parseAIResponse({ tasks: [{ title: '做实验', dueDate: null, reminders: [{ requested: true, date: '2026-08-30', time: null, period: 'evening' }] }] }).tasks[0]?.reminders[0]).toEqual({ requested: true, date: '2026-08-30', time: null, period: 'evening', recurrence: null }))
  it('精确提醒缺少 period 时补为 null', () => expect(parseAIResponse({ tasks: [{ title: '做实验', reminders: [{ requested: true, date: '2026-08-30', time: '20:00' }] }] }).tasks[0]?.reminders[0]?.period).toBeNull())
  it('周末是日期语义而不是 period，安全清理模型的 weekend 误填', () => expect(parseAIResponse({ tasks: [{ title: '整理资料', reminders: [{ requested: true, date: '2026-09-05', time: null, period: 'weekend' }] }] }).tasks[0]?.reminders[0]).toEqual({ requested: true, date: '2026-09-05', time: null, period: null, recurrence: null }))
  it('安全包装 bare task array', () => expect(normalizeAIResponse([{ title: '做实验', dueDate: '2026-08-30' }])).toEqual({ tasks: [{ title: '做实验', dueDate: '2026-08-30' }] }))
  it('安全包装 bare single task', () => expect(normalizeAIResponse({ title: '做实验', dueDate: '2026-08-30' })).toEqual({ tasks: [{ title: '做实验', dueDate: '2026-08-30' }] }))
  it('拒绝真正非法日期', () => expect(() => parseAIResponse({ tasks: [{ title: '做实验', dueDate: '明天' }] })).toThrow())
  it('拒绝真正非法时间', () => expect(() => parseAIResponse({ tasks: [{ title: '做实验', dueDate: '2026-08-30', startTime: '下午三点' }] })).toThrow())
  it('拒绝无法安全解释的非法 period', () => expect(() => parseAIResponse({ tasks: [{ title: '做实验', reminders: [{ requested: true, date: '2026-08-30', time: null, period: 'dawn' }] }] })).toThrow())
  it('保持多提醒能力', () => expect(parseAIResponse({ tasks: [{ title: '交材料', reminders: [{ requested: true, date: '2026-09-01', time: '20:00' }, { requested: true, date: '2026-09-09', time: '19:00' }] }] }).tasks[0]?.reminders).toHaveLength(2))
  it('接受有限和无限的日/周重复规则', () => {
    const finite = parseAIResponse({ tasks: [{ title: '滴眼液使用期限', reminders: [{ requested: true, date: '2026-09-12', time: '08:00', recurrence: { unit: 'week', interval: 1, end: 'count', count: 12, countdown: true } }] }] })
    const infinite = parseAIResponse({ tasks: [{ title: '喝水', reminders: [{ requested: true, date: '2026-09-06', time: '08:00', recurrence: { unit: 'day', interval: 1, end: 'never' } }] }] })
    expect(finite.tasks[0]?.reminders[0]?.recurrence).toMatchObject({ count: 12, until: null, countdown: true })
    expect(infinite.tasks[0]?.reminders[0]?.recurrence).toMatchObject({ end: 'never', count: null, until: null })
  })
  it('拒绝早于首次提醒的结束日期', () => expect(() => parseAIResponse({ tasks: [{ title: '周期提醒', reminders: [{ requested: true, date: '2026-09-12', time: '08:00', recurrence: { unit: 'week', interval: 1, end: 'date', until: '2026-09-05' } }] }] })).toThrow())
  it('旧 singular reminder 只在 normalization 边界转为 reminders', () => expect(parseAIResponse({ tasks: [{ title: '做实验', reminder: { requested: true, date: '2026-08-30', time: '20:00' } }] }).tasks[0]?.reminders).toEqual([{ requested: true, date: '2026-08-30', time: '20:00', period: null, recurrence: null }]))
})
