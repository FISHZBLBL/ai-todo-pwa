import { describe, expect, it } from 'vitest'
import { automaticReminder, reminderAtFromStartTime } from '../src/utils/reminder'
describe('默认提醒', () => {
  it('使用本地日期和开始时间生成 ISO 时间', () => { const at = reminderAtFromStartTime('2026-08-29', '08:30')!; expect(new Date(at).getTime()).toBe(new Date(2026, 7, 29, 8, 30).getTime()); expect(automaticReminder('2026-08-29', '08:30').reminders?.[0]?.at).toBe(at) })
  it('缺少日期或开始时间时没有提醒', () => { expect(automaticReminder('2026-08-29', null)).toEqual({ reminderMode: 'off', reminders: [] }); expect(automaticReminder(null, '08:30')).toEqual({ reminderMode: 'off', reminders: [] }) })
})
