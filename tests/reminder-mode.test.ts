import { describe, expect, it } from 'vitest'
import { automaticReminder, explicitReminder, inferReminderMode, reminderAtFromStartTime, resolveReminderState } from '../src/utils/reminder'
describe('提醒模式迁移', () => {
  it('自动提醒只保留一条 auto reminder', () => expect(resolveReminderState(undefined, { dueDate: '2026-08-29', startTime: '15:00' })).toMatchObject({ reminderMode: 'auto', reminders: [{ id: 'auto', source: 'auto' }] }))
  it('auto 修改开始时间会更新同一默认提醒', () => { const previous = { dueDate: '2026-08-29', startTime: '15:00', ...automaticReminder('2026-08-29', '15:00') }; expect(resolveReminderState(previous, { startTime: '16:00' }).reminders?.[0]?.at).toBe(reminderAtFromStartTime('2026-08-29', '16:00')) })
  it('explicit 可有多条且不跟随任务时间', () => { const reminders = [explicitReminder(reminderAtFromStartTime('2026-08-29', '14:30')!, 'r1'), explicitReminder(reminderAtFromStartTime('2026-08-30', '10:00')!, 'r2')]; expect(resolveReminderState({ dueDate: '2026-08-29', startTime: '15:00', reminderMode: 'explicit', reminders }, { startTime: '16:00' }).reminders).toEqual(reminders) })
  it('旧自动提醒仍可推断', () => expect(inferReminderMode({ dueDate: '2026-08-29', startTime: '15:00', reminderEnabled: true, reminderAt: reminderAtFromStartTime('2026-08-29', '15:00') } as unknown as Parameters<typeof inferReminderMode>[0])).toBe('auto'))
})
