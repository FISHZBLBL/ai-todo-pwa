import { beforeEach, describe, expect, it } from 'vitest'
import { importData, migrateExport, tasksToIcs } from '../src/utils/export'
import type { Task } from '../src/types'
import { resetDatabaseForTests, db, defaultSettings } from '../src/storage/database'
import { taskRepository } from '../src/repositories/taskRepository'

describe('导入导出', () => {
  beforeEach(resetDatabaseForTests)
  it('迁移旧版本并补齐设置同步字段', () => { const result = migrateExport({ schemaVersion: 1, tasks: [], drafts: [], settings: { dailySummaryTime: '08:00' } }); expect(result.schemaVersion).toBe(2); expect(result.settings).toMatchObject({ id: 'settings', dailySummaryTime: '08:00' }); expect(result.settings.timezone).toBeTruthy(); expect(result.settings.updatedAt).toBeTruthy() })
  it('把旧 date/time 迁移为独立任务时间且默认关闭提醒', () => {
    const legacy = { id: crypto.randomUUID(), title: '旧任务', date: '2026-08-28', dateRange: null, time: '15:00', endTime: null, pinned: false, completed: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', source: 'manual' }
    const task = migrateExport({ schemaVersion: 1, tasks: [legacy], drafts: [] }).tasks[0]
    expect(task).toMatchObject({ dueDate: '2026-08-28', startTime: '15:00', reminderEnabled: false, reminderAt: null })
    expect(task).not.toHaveProperty('date')
    expect(task).not.toHaveProperty('time')
  })
  it('拒绝未来版本', () => expect(() => migrateExport({ schemaVersion: 99 })).toThrow())
  it('只导出明确时间任务', () => { const base: Task = { id: '1', title: '会议', dueDate: '2026-08-28', startTime: '15:00', endTime: null, dateRange: null, reminderEnabled: false, pinned: false, completed: false, createdAt: '', updatedAt: '', source: 'manual' }; expect(tasksToIcs([base], 'Asia/Shanghai')).toContain('DTSTART;TZID=Asia/Shanghai:20260828T150000') })
  it('覆盖导入为被移除的任务写入同步 tombstone', async () => {
    const old: Task = { id: crypto.randomUUID(), title: '旧任务', dueDate: null, dateRange: null, startTime: null, endTime: null, reminderEnabled: false, pinned: false, completed: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, source: 'manual' }
    await taskRepository.save(old)
    await importData({ schemaVersion: 1, exportedAt: new Date().toISOString(), tasks: [], drafts: [], settings: defaultSettings }, 'replace')
    expect((await taskRepository.get(old.id))?.deletedAt).toBeTruthy()
    const queued = await (await db()).getAll('syncQueue')
    expect(queued.some(change => {
      if (change.entity !== 'task' || !('deletedAt' in change.value)) return false
      return change.value.id === old.id && Boolean(change.value.deletedAt)
    })).toBe(true)
  })
})
