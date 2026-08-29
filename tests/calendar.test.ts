import { describe, expect, it } from 'vitest'
import type { Task } from '../src/types'
import { activeCalendarTaskCounts, activeTasksForDate, mondayIndex, monthGrid, taskDotCount } from '../src/utils/calendar'
import { toggleCollapsedGroup } from '../src/utils/groupCollapse'

const task = (id: string, dueDate: string | null, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  dueDate,
  dateRange: null,
  startTime: null,
  endTime: null,
  reminders: [],
  reminderMode: 'off',
  completed: false,
  completedAt: null,
  deletedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  sortOrder: 0,
  pinned: false,
  note: null,
  url: null,
  source: 'manual',
  ...overrides,
})

describe('calendar date helpers', () => {
  it('uses Monday as the first weekday', () => {
    expect(mondayIndex(new Date(2026, 8, 7))).toBe(0)
    expect(mondayIndex(new Date(2026, 8, 13))).toBe(6)
  })

  it('builds a six-week grid with the correct month offset', () => {
    const days = monthGrid(new Date(2026, 7, 1))
    expect(days).toHaveLength(42)
    expect(days[0]?.key).toBe('2026-07-27')
    expect(days[5]?.key).toBe('2026-08-01')
  })

  it('keeps adjacent-month dates in the grid for cross-month selection', () => {
    const days = monthGrid(new Date(2026, 7, 1))
    expect(days.find(day => day.key === '2026-09-01')).toMatchObject({ inVisibleMonth: false })
  })

  it('projects one active dateRange task to each included day, including across months', () => {
    const range = task('range', null, { dateRange: { start: '2026-08-30', end: '2026-09-03' } })
    const days = monthGrid(new Date(2026, 7, 1))
    const counts = activeCalendarTaskCounts([range], days)
    expect(counts.get('2026-08-30')).toBe(1)
    expect(counts.get('2026-08-31')).toBe(1)
    expect(counts.get('2026-09-01')).toBe(1)
    expect(counts.get('2026-09-03')).toBe(1)
    expect(counts.get('2026-08-29')).toBeUndefined()
    expect(activeTasksForDate([range], '2026-09-02')).toEqual([range])
  })

  it('hides completed ranges and still groups active dueDate tasks', () => {
    const days = monthGrid(new Date(2026, 8, 1))
    const counts = activeCalendarTaskCounts([
      task('due', '2026-09-02'),
      task('done', '2026-09-02', { completed: true }),
      task('deleted', '2026-09-02', { deletedAt: '2026-09-01T00:00:00.000Z' }),
      task('range-done', null, { completed: true, dateRange: { start: '2026-09-02', end: '2026-09-05' } }),
    ], days)
    expect(counts.get('2026-09-02')).toBe(1)
    expect(activeTasksForDate([task('due', '2026-09-02'), task('done', '2026-09-02', { completed: true })], '2026-09-02')).toHaveLength(1)
  })

  it('caps visible dots at three', () => {
    expect(taskDotCount(1)).toBe(1)
    expect(taskDotCount(2)).toBe(2)
    expect(taskDotCount(8)).toBe(3)
  })

  it('toggles home group visibility without changing task data or order', () => {
    const tasks = [task('first', null), task('second', null)]
    const collapsed = toggleCollapsedGroup(new Set(), '无日期')
    expect(collapsed.has('无日期')).toBe(true)
    expect(tasks.map(item => item.id)).toEqual(['first', 'second'])
    expect(tasks.every(item => !item.deletedAt && !item.completed)).toBe(true)
    expect(toggleCollapsedGroup(collapsed, '无日期').has('无日期')).toBe(false)
  })
})
