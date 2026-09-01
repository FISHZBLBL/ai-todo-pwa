import { describe, expect, it } from 'vitest'
import { automaticReminder, hasMissedReminder, reminderAtFromStartTime } from '../src/utils/reminder'
describe('默认提醒', () => {
  it('使用本地日期和开始时间生成 ISO 时间', () => { const at = reminderAtFromStartTime('2026-08-29', '08:30')!; expect(new Date(at).getTime()).toBe(new Date(2026, 7, 29, 8, 30).getTime()); expect(automaticReminder('2026-08-29', '08:30').reminders?.[0]?.at).toBe(at) })
  it('缺少日期或开始时间时没有提醒', () => { expect(automaticReminder('2026-08-29', null)).toEqual({ reminderMode: 'off', reminders: [] }); expect(automaticReminder(null, '08:30')).toEqual({ reminderMode: 'off', reminders: [] }) })
  it('只把已到时间但未成功发送的提醒标记为未送达', () => {
    const now = new Date('2026-08-31T04:00:00.000Z')
    const reminder = { id: 'r1', at: '2026-08-31T03:00:00.000Z', eventId: 'event-1', sentAt: null, source: 'explicit' as const }
    expect(hasMissedReminder({ reminders: [reminder], completed: false, deletedAt: null }, now)).toBe(true)
    expect(hasMissedReminder({ reminders: [{ ...reminder, sentAt: '2026-08-31T03:00:01.000Z' }], completed: false, deletedAt: null }, now)).toBe(false)
    expect(hasMissedReminder({ reminders: [{ ...reminder, at: '2026-08-31T05:00:00.000Z' }], completed: false, deletedAt: null }, now)).toBe(false)
    expect(hasMissedReminder({ reminders: [reminder], completed: true, deletedAt: null }, now)).toBe(false)
  })
})
