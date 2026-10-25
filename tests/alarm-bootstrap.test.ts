import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapReminderSchedules } from '../server/reminders/bootstrap'
const mocks = vi.hoisted(() => ({ read: vi.fn(), clear: vi.fn(), reconcile: vi.fn(), cancel: vi.fn(), daily: vi.fn(), import: vi.fn(), sender: {} }))
vi.mock('../server/storage', () => ({ cloudStore: { read: mocks.read, clearReminderEventIfCurrent: mocks.clear } }))
vi.mock('../server/reminders/scheduler', () => ({ reconcileReminder: mocks.reconcile, cancelReminderEvents: mocks.cancel }))
vi.mock('../server/reminders/dailySummaryScheduler', () => ({ ensureDailySummarySchedule: mocks.daily }))
vi.mock('../server/reminders/alarmClient', () => ({ createAlarmEventSender: () => mocks.sender, importAlarmEvents: mocks.import }))
const at = '2026-10-26T02:00:00.000Z'
const task = (id: string, eventId: string | null, extra = {}) => ({ id, reminders: [{ id: 'r1', at, eventId, sentAt: null }], ...extra })

describe('one-time migration and subscription changes', () => {
  beforeEach(() => {
    for (const fn of [mocks.read, mocks.clear, mocks.reconcile, mocks.cancel, mocks.daily, mocks.import]) fn.mockReset()
    mocks.clear.mockResolvedValue(true); mocks.import.mockResolvedValue(undefined)
  })
  it('adopts legacy IDs, skips acknowledged CF IDs, completed tasks and sent reminders', async () => {
    const data = { subscriptions: [{}], tasks: [task('legacy', 'old-event'), task('pending', null), task('already-cf', 'cf:queued'), task('done', 'old-done', { completed: true }), task('sent', 'old-sent', { reminders: [{ id: 'r1', at, eventId: 'old-sent', sentAt: at }] })], dailySummarySchedule: { eventId: 'old-daily', scheduledFor: at } }
    mocks.read.mockResolvedValue(data)
    expect(await bootstrapReminderSchedules()).toEqual({ migrated: 2 })
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(mocks.reconcile).toHaveBeenCalledWith({ todoId: 'pending', oldEventIds: [] }, mocks.sender, expect.any(Number), { includeOverdue: true })
    expect(mocks.import).toHaveBeenCalledWith([
      { eventId: 'old-event', eventName: 'todo.reminder', data: { todoId: 'legacy', reminderId: 'r1' }, delayUntil: Date.parse(at) },
      { eventId: 'old-daily', eventName: 'daily.summary', data: { scheduledFor: at }, delayUntil: Date.parse(at) }
    ])
  })
  it('last unsubscribe cancels pointers, creates no events and ends the daily chain', async () => {
    mocks.read.mockResolvedValue({ subscriptions: [], tasks: [task('todo', 'cf:future')], dailySummarySchedule: null })
    expect(await bootstrapReminderSchedules()).toEqual({ migrated: 0, skipped: 'no-subscriptions' })
    expect(mocks.clear).toHaveBeenCalledWith('todo', 'r1', 'cf:future', { requireNoSubscriptions: true })
    expect(mocks.cancel).toHaveBeenCalledWith(['cf:future'], mocks.sender)
    expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled(); expect(mocks.daily).toHaveBeenCalledOnce()
  })
  it('a failed migration is reported and can be replayed without resetting IDs', async () => {
    const data = { subscriptions: [{}], tasks: [task('todo', 'old-event')], dailySummarySchedule: null }
    mocks.read.mockResolvedValue(data); mocks.import.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined)
    await expect(bootstrapReminderSchedules()).rejects.toThrow('temporary failure')
    await expect(bootstrapReminderSchedules()).resolves.toEqual({ migrated: 1 })
    expect(mocks.import.mock.calls[0][0]).toEqual(mocks.import.mock.calls[1][0])
    expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('a subscription arriving after the empty snapshot prevents cancelling its current event', async () => {
    mocks.read.mockResolvedValue({ subscriptions: [], tasks: [task('todo', 'cf:future')], dailySummarySchedule: null })
    mocks.clear.mockResolvedValue(false)
    await bootstrapReminderSchedules()
    expect(mocks.clear).toHaveBeenCalledWith('todo', 'r1', 'cf:future', { requireNoSubscriptions: true })
    expect(mocks.cancel).toHaveBeenCalledWith([], mocks.sender)
  })
})
