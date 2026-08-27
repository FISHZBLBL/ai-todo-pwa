import { describe, expect, it } from 'vitest'
import { migrateExport, tasksToIcs } from '../src/utils/export'
import type { Task } from '../src/types'

describe('导入导出', () => {
  it('迁移旧版本并补齐设置同步字段', () => { const result = migrateExport({ schemaVersion: 1, tasks: [], drafts: [], settings: { dailySummaryTime: '08:00' } }); expect(result.schemaVersion).toBe(1); expect(result.settings).toMatchObject({ id: 'settings', dailySummaryTime: '08:00' }); expect(result.settings.timezone).toBeTruthy(); expect(result.settings.updatedAt).toBeTruthy() })
  it('拒绝未来版本', () => expect(() => migrateExport({ schemaVersion: 99 })).toThrow())
  it('只导出明确时间任务', () => { const base: Task = { id: '1', title: '会议', date: '2026-08-28', time: '15:00', endTime: null, dateRange: null, pinned: false, completed: false, createdAt: '', updatedAt: '', source: 'manual' }; expect(tasksToIcs([base], 'Asia/Shanghai')).toContain('DTSTART;TZID=Asia/Shanghai:20260828T150000') })
})
