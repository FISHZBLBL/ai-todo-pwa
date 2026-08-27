import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, resetDatabaseForTests } from '../src/storage/database'
import { taskRepository } from '../src/repositories/taskRepository'
import { syncNow } from '../src/sync/syncService'
import type { Task } from '../src/types'

function lww<T extends { id: string; updatedAt: string }>(local: T[], remote: T[]) { const map = new Map(local.map(x => [x.id, x])); for (const item of remote) if (!map.has(item.id) || item.updatedAt > map.get(item.id)!.updatedAt) map.set(item.id, item); return [...map.values()] }
describe('同步冲突', () => {
  beforeEach(async () => { await resetDatabaseForTests(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }) })
  it('较新修改获胜', () => expect(lww([{ id:'1', updatedAt:'2026-01-01', title:'旧' }], [{ id:'1', updatedAt:'2026-01-02', title:'新' }])[0].title).toBe('新'))
  it('删除 tombstone 参与 LWW', () => expect(lww([{ id:'1', updatedAt:'2026-01-01', deletedAt:null }], [{ id:'1', updatedAt:'2026-01-02', deletedAt:'2026-01-02' }])[0].deletedAt).toBeTruthy())
  it('网络请求完成后使用新事务确认队列，且不删除请求期间新增的变更', async () => {
    const makeTask = (id: string): Task => ({ id, title: id, date: null, dateRange: null, time: null, endTime: null, pinned: false, completed: false, createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z', source: 'manual' })
    await taskRepository.save(makeTask('11111111-1111-4111-8111-111111111111'))
    localStorage.setItem('todo-session', 'test-token')
    vi.stubGlobal('fetch', vi.fn(async () => { await taskRepository.save(makeTask('22222222-2222-4222-8222-222222222222')); return { ok: true, status: 200, json: async () => ({ tasks: [], drafts: [], settings: null }) } as Response }))
    await expect(syncNow()).resolves.toBe(true)
    const queued = await (await db()).getAll('syncQueue')
    expect(queued).toHaveLength(1)
    expect((queued[0].value as Task).id).toBe('22222222-2222-4222-8222-222222222222')
  })
})
