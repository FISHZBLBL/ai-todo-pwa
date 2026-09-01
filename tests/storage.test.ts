import { beforeEach, describe, expect, it } from 'vitest'
import { taskRepository } from '../src/repositories/taskRepository'
import { draftRepository } from '../src/repositories/draftRepository'
import { resetDatabaseForTests } from '../src/storage/database'
import type { Task } from '../src/types'

const task = (updatedAt = '2026-08-27T00:00:00.000Z'): Task => ({ id: crypto.randomUUID(), title: '测试', dueDate: null, dateRange: null, startTime: null, endTime: null, reminderMode: 'off', reminders: [], pinned: false, completed: false, createdAt: updatedAt, updatedAt, source: 'manual', recurrence: null })
describe('任务存储', () => {
  beforeEach(async () => resetDatabaseForTests())
  it('创建和更新', async () => { const item = task(); await taskRepository.save(item); await taskRepository.save({ ...item, title: '更新', updatedAt: '2026-08-28T00:00:00.000Z' }); expect((await taskRepository.get(item.id))?.title).toBe('更新') })
  it('软删除默认不返回', async () => { const item = { ...task(), deletedAt: new Date().toISOString() }; await taskRepository.save(item); expect(await taskRepository.list()).toHaveLength(0); expect(await taskRepository.list(true)).toHaveLength(1) })
  it('30 天后清理 tombstone', async () => { const item = { ...task(), deletedAt: '2026-01-01T00:00:00.000Z' }; await taskRepository.save(item); await taskRepository.purgeExpiredTombstones(new Date('2026-02-01T00:00:01.000Z')); expect(await taskRepository.get(item.id)).toBeUndefined() })
  it('草稿删除保存 tombstone 并可在 30 天后清理', async () => { const item = { id: crypto.randomUUID(), content: '草稿', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', aiParseStatus: 'idle' as const }; await draftRepository.save(item); await draftRepository.delete(item.id); expect(await draftRepository.list()).toHaveLength(0); const deleted = (await draftRepository.list(true))[0]; expect(deleted.deletedAt).toBeTruthy(); const afterRetention = new Date(new Date(deleted.deletedAt!).getTime() + 31 * 24 * 60 * 60 * 1000); await draftRepository.purgeExpiredTombstones(afterRetention); expect(await draftRepository.get(item.id)).toBeUndefined() })
})
