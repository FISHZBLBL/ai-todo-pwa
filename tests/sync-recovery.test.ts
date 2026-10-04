import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, defaultSettings, getSettings, resetDatabaseForTests } from '../src/storage/database'
import { taskRepository } from '../src/repositories/taskRepository'
import { draftRepository } from '../src/repositories/draftRepository'
import { api, type SyncResponse } from '../src/services/api'
import { applySyncResponse, getSyncIssues, syncNow } from '../src/sync/syncService'
import { jsonBytes, MAX_SYNC_BATCH_BYTES, MAX_SYNC_CHANGES } from '../shared/limits'
import type { SyncChange, Task } from '../src/types'

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const task = (n: number, patch: Partial<Task> = {}): Task => ({ id: id(n), title: '测试', pinned: false, completed: false, reminderMode: 'off', reminders: [], source: 'manual', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...patch })
const response = (patch: Partial<SyncResponse> = {}): SyncResponse => ({ tasks: [], drafts: [], profiles: [], settings: null, ...patch })
const change = (value: Task): SyncChange => ({ entity: 'task', value, queuedAt: '2026-10-01T00:00:00.000Z' })

describe('sync recovery and atomic persistence', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await resetDatabaseForTests()
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem('todo-session', 'test-only')
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })
  it('drops invalid historical snapshots once a corrected version is queued', async () => {
    await (await db()).add('syncQueue', change(task(1, { title: '' })))
    await taskRepository.save(task(1, { title: '已修正', updatedAt: '2026-10-02T00:00:00.000Z' }))
    const sent = vi.spyOn(api, 'sync').mockResolvedValue(response())
    await syncNow()
    const tasks = sent.mock.calls.flatMap(([changes]) => changes.filter(change => change.entity === 'task'))
    expect(tasks).toHaveLength(1)
    expect(tasks[0].value).toMatchObject({ title: '已修正' })
    expect(await getSyncIssues()).toEqual([])
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
  it('quarantines invalid latest data intact while valid records continue syncing', async () => {
    const invalid = { id: id(1), content: '超'.repeat(10_001), createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', aiParseStatus: 'idle' as const }
    await (await db()).put('drafts', invalid)
    await (await db()).add('syncQueue', { entity: 'draft', value: invalid, queuedAt: invalid.updatedAt })
    await taskRepository.save(task(2))
    const sent = vi.spyOn(api, 'sync').mockResolvedValue(response())
    await syncNow()
    expect(sent.mock.calls[0][0].some(change => change.entity === 'task')).toBe(true)
    expect(sent.mock.calls[0][0].some(change => change.entity === 'draft')).toBe(false)
    expect((await getSyncIssues())[0].change).toMatchObject({ value: invalid })
    expect(await draftRepository.get(invalid.id)).toEqual(invalid)
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
  it('batches over 1000 records under the wire byte limit', async () => {
    const transaction = (await db()).transaction('syncQueue', 'readwrite')
    for (let n = 1; n <= 1001; n++) await transaction.store.add(change(task(n, { note: '资料'.repeat(300) })))
    await transaction.done
    const sent = vi.spyOn(api, 'sync').mockResolvedValue(response())
    await syncNow()
    expect(sent.mock.calls.length).toBeGreaterThan(1)
    const uploaded = sent.mock.calls.flatMap(([batch]) => {
      expect(batch.length).toBeLessThanOrEqual(MAX_SYNC_CHANGES)
      expect(jsonBytes({ changes: batch })).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES)
      return batch.filter(change => change.entity === 'task')
    })
    expect(uploaded).toHaveLength(1001)
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
  it('keeps a failed batch queued without requeueing successful batches', async () => {
    await taskRepository.saveMany([task(1, { note: '文'.repeat(50_000) }), task(2, { note: '文'.repeat(50_000) })])
    vi.spyOn(api, 'sync').mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('离线'))
    await expect(syncNow()).rejects.toThrow('离线')
    const queue = await (await db()).getAll('syncQueue')
    expect(queue).toHaveLength(1)
    expect(queue[0].value.id).toBe(id(2))
  })
  it('concurrent remote application and local update retain both changes', async () => {
    await taskRepository.save(task(1), false)
    await Promise.all([
      applySyncResponse(response({ tasks: [task(1, { title: '云端标题', updatedAt: '2026-10-02T00:00:00.000Z' })] }), []),
      taskRepository.update(id(1), current => ({ ...current, pinned: true, updatedAt: '2026-10-03T00:00:00.000Z' }))
    ])
    expect(await taskRepository.get(id(1))).toMatchObject({ title: '云端标题', pinned: true })
    expect((await (await db()).getAll('syncQueue'))[0].value).toMatchObject({ title: '云端标题', pinned: true })
  })
  it('minimal deletion versions hide old tasks without deleting newer edits', async () => {
    await taskRepository.saveMany([task(1), task(2, { updatedAt: '2026-10-03T00:00:00.000Z' })], false)
    const deletions = [1, 2].map(n => ({ entity: 'task' as const, id: id(n), updatedAt: '2026-10-02T00:00:00.000Z', deletedAt: '2026-10-02T00:00:00.000Z' }))
    await applySyncResponse(response({ deletions }), [])
    expect((await taskRepository.list()).map(task => task.id)).toEqual([id(2)])
  })
  it('epoch settings on a new device yield to existing cloud preferences', async () => {
    const remote = { ...defaultSettings, dailySummaryTime: '09:30', timezone: 'Asia/Shanghai', updatedAt: '2026-10-01T00:00:00.000Z' }
    const sent = vi.spyOn(api, 'sync').mockResolvedValue(response({ settings: remote }))
    await syncNow()
    const settings = sent.mock.calls[0][0].find(change => change.entity === 'settings')
    expect(settings?.value.updatedAt).toBe(defaultSettings.updatedAt)
    expect(await getSettings()).toMatchObject({ dailySummaryTime: remote.dailySummaryTime, timezone: remote.timezone, updatedAt: remote.updatedAt })
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
  it('a late AI draft write cannot revive a consumed draft', async () => {
    const draft = { id: id(1), content: '草稿', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', aiParseStatus: 'parsing' as const }
    await draftRepository.save(draft); await draftRepository.delete(draft.id)
    await draftRepository.save({ ...draft, aiParseStatus: 'parsed', updatedAt: '2099-01-01T00:00:00.000Z' })
    expect(await draftRepository.list()).toEqual([])
  })
  it('rejects an invalid batch before persisting any tasks', async () => {
    await expect(taskRepository.saveMany([task(1), task(2, { title: '' })])).rejects.toThrow()
    expect(await taskRepository.list()).toEqual([])
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
  it('creating tasks and consuming their draft commit together', async () => {
    const draft = { id: id(3), content: '原始内容', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', aiParseStatus: 'parsed' as const }
    await draftRepository.save(draft, false)
    await taskRepository.saveMany([task(1), task(2)], true, draft.id)
    expect(await taskRepository.list()).toHaveLength(2)
    expect(await draftRepository.list()).toEqual([])
    expect(await (await db()).getAll('syncQueue')).toHaveLength(3)
    await taskRepository.saveMany([task(4)], true, draft.id)
    expect(await taskRepository.get(id(4))).toBeUndefined()
  })
  it('a failure consuming the draft rolls back already written tasks and queue intents', async () => {
    const draft = { id: id(3), content: '原始内容', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', aiParseStatus: 'parsed' as const }
    await draftRepository.save(draft, false)
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'drafts' && value.deletedAt) throw new DOMException('disk full', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(taskRepository.saveMany([task(1)], true, draft.id)).rejects.toThrow('disk full')
    expect(await taskRepository.list()).toEqual([])
    expect(await draftRepository.get(draft.id)).toEqual(draft)
    expect(await (await db()).getAll('syncQueue')).toEqual([])
  })
})
