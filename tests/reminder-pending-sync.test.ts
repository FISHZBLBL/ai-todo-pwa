import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, defaultSettings, getSettings, resetDatabaseForTests, saveSettings } from '../src/storage/database'
import { taskRepository } from '../src/repositories/taskRepository'
import { api, type SyncResponse } from '../src/services/api'
import { applySyncResponse, installAutoSync, syncNow } from '../src/sync/syncService'
import type { Task } from '../src/types'

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const task = (n: number, patch: Partial<Task> = {}): Task => ({
  id: id(n), title: '到点提醒', pinned: false, completed: false, reminderMode: 'explicit',
  reminders: [{ id: 'r1', at: '2026-10-25T09:00:00.000Z', source: 'explicit', eventId: null, sentAt: null }],
  source: 'manual', createdAt: '2026-10-25T08:00:00.000Z', updatedAt: '2026-10-25T08:00:00.000Z', ...patch
})
const response = (patch: Partial<SyncResponse> = {}): SyncResponse => ({ tasks: [], drafts: [], profiles: [], settings: null, ...patch })
const previousSyncAt = '2026-10-24T08:00:00.000Z'
let dispose: (() => void) | undefined

describe('reminder scheduling acknowledgement in client sync', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await resetDatabaseForTests()
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem('todo-session', 'test-only')
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    await saveSettings({ ...defaultSettings, updatedAt: '2026-10-25T08:00:00.000Z', lastSyncAt: previousSyncAt })
  })
  afterEach(() => {
    dispose?.(); dispose = undefined
    vi.useRealTimers(); vi.restoreAllMocks()
    delete (navigator as unknown as Record<string, unknown>).onLine
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('applies the remote snapshot without acknowledging queued edits while registration is pending', async () => {
    await taskRepository.save(task(1))
    const keys = await (await db()).getAllKeys('syncQueue')
    const remote = task(1, { title: '其他设备的较新标题', updatedAt: '2026-10-25T08:01:00.000Z' })
    await applySyncResponse(response({ tasks: [remote], reminderSchedulingPending: true }), keys)
    expect(await taskRepository.get(id(1))).toMatchObject({ title: remote.title, updatedAt: remote.updatedAt })
    expect(await (await db()).getAllKeys('syncQueue')).toEqual(keys)
    expect((await getSettings()).lastSyncAt).toBe(previousSyncAt)
  })

  it('reports pending once and only acknowledges its retained keys after a successful retry', async () => {
    const local = await taskRepository.save(task(1))
    await taskRepository.save({ ...local, title: '更新后的事项', updatedAt: '2026-10-25T08:01:00.000Z' })
    const queuedKeys = await (await db()).getAllKeys('syncQueue')
    const remote = task(1, { title: '更新后的事项', updatedAt: '2026-10-25T08:01:00.000Z' })
    const registered = { ...remote, reminders: remote.reminders.map(reminder => ({ ...reminder, eventId: 'cf-reminder-1' })) }
    const sync = vi.spyOn(api, 'sync')
      .mockResolvedValueOnce(response({ tasks: [remote], reminderSchedulingPending: true }))
      .mockResolvedValueOnce(response({ tasks: [registered], reminderSchedulingPending: false }))
    await expect(syncNow()).resolves.toBe(false)
    expect(sync).toHaveBeenCalledOnce()
    expect(await (await db()).getAllKeys('syncQueue')).toEqual(queuedKeys)
    expect((await getSettings()).lastSyncAt).toBe(previousSyncAt)
    await expect(syncNow()).resolves.toBe(true)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls[1][0]).toEqual(sync.mock.calls[0][0])
    expect(await (await db()).count('syncQueue')).toBe(0)
    expect((await taskRepository.get(id(1)))?.reminders[0].eventId).toBe('cf-reminder-1')
    expect((await getSettings()).lastSyncAt).not.toBe(previousSyncAt)
  })

  it('retains a pending batch and untouched later batches while keeping earlier acknowledgements', async () => {
    await taskRepository.saveMany([1, 2, 3].map(n => task(n, { note: '文'.repeat(50_000) })))
    const sync = vi.spyOn(api, 'sync')
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ reminderSchedulingPending: true }))
      .mockResolvedValue(response())
    await expect(syncNow()).resolves.toBe(false)
    expect(sync).toHaveBeenCalledTimes(2)
    expect((await (await db()).getAll('syncQueue')).map(change => change.value.id)).toEqual([id(2), id(3)])
    await expect(syncNow()).resolves.toBe(true)
    expect(sync).toHaveBeenCalledTimes(4)
    expect(sync.mock.calls.slice(2).flatMap(([changes]) => changes.map(change => change.value.id))).toEqual([id(2), id(3)])
    expect(await (await db()).count('syncQueue')).toBe(0)
  })

  it('retries retained edits on the next one-minute timer tick without an immediate retry loop', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await taskRepository.save(task(1))
    const sync = vi.spyOn(api, 'sync')
      .mockResolvedValueOnce(response({ reminderSchedulingPending: true }))
      .mockResolvedValue(response())
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(sync).toHaveBeenCalledOnce()
    expect(await (await db()).count('syncQueue')).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(sync).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(sync).toHaveBeenCalledTimes(2)
    expect(await (await db()).count('syncQueue')).toBe(0)
  })
})
