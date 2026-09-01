import { describe, expect, it } from 'vitest'
import type { Task } from '../src/types'
import { isOverdue, taskOverdueAt } from '../src/utils/date'
import { buildHomeTaskGroups } from '../src/utils/homeGroups'
import { getTaskAttention } from '../src/utils/taskAttention'

const now = new Date(2026, 8, 1, 12)
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, title: id, dueDate: null, dateRange: null, startTime: null, endTime: null,
  reminderMode: 'off', reminders: [], pinned: false, sortOrder: null,
  completed: false, completedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  deletedAt: null, recurrence: null, source: 'manual', ...overrides,
})
const reminderAt = (hour: number) => new Date(2026, 8, 1, hour).toISOString()

describe('task attention', () => {
  it('distinguishes delivered and undelivered reached reminders', () => {
    const sent = task('sent', { reminders: [{ id: 'r1', at: reminderAt(10), eventId: 'e1', sentAt: reminderAt(10), source: 'explicit' }] })
    const unsent = task('unsent', { reminders: [{ id: 'r1', at: reminderAt(10), eventId: 'e1', sentAt: null, source: 'explicit' }] })
    expect(getTaskAttention(sent, now)?.reminderStatus).toBe('sent')
    expect(getTaskAttention(unsent, now)?.reminderStatus).toBe('unsent')
  })

  it('keeps a multi-reminder task in attention and sorts by its latest reached reminder', () => {
    const first = task('first', { reminders: [{ id: 'r1', at: reminderAt(8), eventId: 'e1', sentAt: reminderAt(8), source: 'explicit' }] })
    const latest = task('latest', { reminders: [{ id: 'r1', at: reminderAt(7), eventId: 'e1', sentAt: reminderAt(7), source: 'explicit' }, { id: 'r2', at: reminderAt(11), eventId: 'e2', sentAt: reminderAt(11), source: 'explicit' }] })
    expect(buildHomeTaskGroups([first, latest], now)[0]?.tasks.map(item => item.id)).toEqual(['latest', 'first'])
  })

  it('moves dated, undated and pinned attention tasks out of their original groups without clearing pinned', () => {
    const tasks = [
      task('dated', { dueDate: '2026-08-31' }),
      task('undated', { reminders: [{ id: 'r1', at: reminderAt(10), eventId: 'e1', sentAt: reminderAt(10), source: 'explicit' }] }),
      task('pinned', { pinned: true, reminders: [{ id: 'r1', at: reminderAt(11), eventId: 'e2', sentAt: null, source: 'explicit' }] }),
      task('normal-pinned', { pinned: true }),
    ]
    const groups = buildHomeTaskGroups(tasks, now)
    expect(groups[0]).toMatchObject({ key: 'attention', label: '需处理', attention: true })
    expect(groups[0]?.tasks.map(item => item.id)).toEqual(['pinned', 'undated', 'dated'])
    expect(groups.flatMap(group => group.tasks).filter(item => item.id === 'pinned')).toHaveLength(1)
    expect(groups.find(group => group.label === '置顶')?.tasks.map(item => item.id)).toEqual(['normal-pinned'])
    expect(tasks.find(item => item.id === 'pinned')?.pinned).toBe(true)
  })

  it('leaves attention when the relevant reminder is moved to the future', () => {
    const value = task('rescheduled', { reminders: [{ id: 'r1', at: new Date(2026, 8, 1, 18).toISOString(), eventId: null, sentAt: null, source: 'explicit' }] })
    expect(getTaskAttention(value, now)).toBeNull()
    expect(buildHomeTaskGroups([value], now)[0]?.key).toBe('无日期')
  })
})

describe('task overdue boundary', () => {
  it('date-only and start-only tasks expire at the end of the local day', () => {
    const dateOnly = task('date', { dueDate: '2026-09-01' })
    const startOnly = task('start', { dueDate: '2026-09-01', startTime: '09:00' })
    expect(isOverdue(dateOnly, now)).toBe(false)
    expect(isOverdue(startOnly, now)).toBe(false)
    expect(taskOverdueAt(dateOnly)).toBe(new Date(2026, 8, 2).getTime())
  })

  it('uses endTime when present and the range end otherwise', () => {
    const ended = task('ended', { dueDate: '2026-09-01', startTime: '09:00', endTime: '11:00' })
    const range = task('range', { dateRange: { start: '2026-08-30', end: '2026-08-31' } })
    expect(isOverdue(ended, now)).toBe(true)
    expect(isOverdue(range, now)).toBe(true)
  })
})
