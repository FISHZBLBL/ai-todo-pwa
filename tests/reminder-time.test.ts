import { describe, expect, it } from 'vitest'
import { automaticReminder, reminderAtFromStartTime } from '../src/utils/reminder'

describe('开始时间提醒', () => {
  it('明确日期和开始时间自动生成提醒时间', () => {
    const reminderAt = reminderAtFromStartTime('2026-08-29', '08:30')
    expect(new Date(reminderAt!).getTime()).toBe(new Date(2026, 7, 29, 8, 30).getTime())
    expect(automaticReminder('2026-08-29', '08:30')).toEqual({ reminderEnabled: true, reminderAt })
  })

  it('缺少日期或开始时间时不创建提醒', () => {
    expect(automaticReminder('2026-08-29', null)).toEqual({ reminderEnabled: false, reminderAt: null })
    expect(automaticReminder(null, '08:30')).toEqual({ reminderEnabled: false, reminderAt: null })
  })
})
