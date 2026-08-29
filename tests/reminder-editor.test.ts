import { describe, expect, it } from 'vitest'
import { automaticReminder, explicitReminder, reminderAtFromStartTime, resolveReminderState } from '../src/utils/reminder'

describe('多提醒状态转换', () => {
  it('创建有日期与开始时间的任务时建立默认提醒', () => {
    expect(automaticReminder('2026-09-02', '15:00')).toMatchObject({ reminderMode: 'auto', reminders: [{ id: 'auto', source: 'auto' }] })
  })
  it('auto 跟随任务开始时间', () => {
    const previous = { dueDate: '2026-09-02', startTime: '15:00', ...automaticReminder('2026-09-02', '15:00') }
    expect(resolveReminderState(previous, { startTime: '16:00' }).reminders?.[0]?.at).toBe(reminderAtFromStartTime('2026-09-02', '16:00'))
  })
  it('explicit reminders 不跟随任务时间', () => {
    const reminders = [explicitReminder(reminderAtFromStartTime('2026-09-02', '14:30')!, 'first'), explicitReminder(reminderAtFromStartTime('2026-09-03', '09:00')!, 'second')]
    const previous = { dueDate: '2026-09-02', startTime: '15:00', reminderMode: 'explicit' as const, reminders }
    expect(resolveReminderState(previous, { startTime: '16:00' }).reminders).toEqual(reminders)
  })
  it('off 不会因修改开始时间恢复', () => {
    expect(resolveReminderState({ dueDate: '2026-09-02', startTime: '15:00', reminderMode: 'off', reminders: [] }, { startTime: '16:00' })).toEqual({ reminderMode: 'off', reminders: [] })
  })
})
