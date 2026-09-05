import { describe, expect, it } from 'vitest'
import { nextRecurringOccurrence, recurringReminderBody } from '../server/reminders/recurrence'

const reminder = (overrides = {}) => ({
  at: '2026-09-12T00:00:00.000Z',
  recurrence: { unit: 'week' as const, interval: 1, end: 'count' as const, count: 12, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: true },
  ...overrides
})

describe('重复提醒规则', () => {
  it('按当地日历推进并保留当地时刻', () => {
    const next = nextRecurringOccurrence(reminder())
    expect(next).toMatchObject({ at: '2026-09-19T00:00:00.000Z', recurrence: { occurrence: 2 } })
  })

  it('到达总次数后结束', () => {
    expect(nextRecurringOccurrence(reminder({ recurrence: { ...reminder().recurrence, occurrence: 12 } }))).toBeNull()
  })

  it('无限重复持续生成下一次', () => {
    const value = reminder({ recurrence: { ...reminder().recurrence, end: 'never' as const, count: null, occurrence: 300 } })
    expect(nextRecurringOccurrence(value)?.recurrence.occurrence).toBe(301)
  })

  it('倒计时通知随次数递减，最后提示期限已到', () => {
    expect(recurringReminderBody('滴眼液使用期限', reminder())).toBe('还剩 11 周到期')
    expect(recurringReminderBody('滴眼液使用期限', reminder({ recurrence: { ...reminder().recurrence, occurrence: 12 } }))).toBe('已到设定期限，请停止使用')
  })
})
