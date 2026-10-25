import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, defaultSettings, resetDatabaseForTests, saveSettings } from '../src/storage/database'
import { taskRepository } from '../src/repositories/taskRepository'
import { installAutoSync, syncNow } from '../src/sync/syncService'
import type { Task } from '../src/types'

const task: Task = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: '后台上传', pinned: false, completed: false, reminderMode: 'off', reminders: [], source: 'manual', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
const visibility = (value: 'hidden' | 'visible') => Object.defineProperty(document, 'visibilityState', { value, configurable: true })
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true })
let dispose: (() => void) | undefined

describe('automatic sync while the app is in the background', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await resetDatabaseForTests()
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem('todo-session', 'test-only')
    visibility('hidden'); online(true)
    await saveSettings({ ...defaultSettings, updatedAt: '2026-10-01T00:00:00.000Z' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tasks: [], drafts: [], profiles: [], settings: null }) } as Response)))
  })
  afterEach(() => {
    dispose?.(); dispose = undefined
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    delete (document as unknown as Record<string, unknown>).visibilityState
    delete (navigator as unknown as Record<string, unknown>).onLine
  })

  it('does not request cloud data on hidden, empty-queue timer ticks', async () => {
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    await vi.advanceTimersByTimeAsync(180_000)
    await (await db()).count('syncQueue')
    expect(fetch).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('uploads queued edits on a hidden timer tick and then stops empty polling', async () => {
    await taskRepository.save(task)
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
    const request = vi.mocked(fetch).mock.calls[0][1]
    expect(JSON.parse(String(request?.body)).changes).toEqual([expect.objectContaining({ entity: 'task', value: expect.objectContaining({ id: task.id }) })])
    expect(await (await db()).count('syncQueue')).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    await (await db()).count('syncQueue')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('refreshes immediately when the app becomes visible and keeps foreground polling', async () => {
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    visibility('visible'); document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps edits queued while offline and uploads immediately on reconnection', async () => {
    await taskRepository.save(task)
    online(false)
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(await (await db()).count('syncQueue')).toBe(1)
    online(true); window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
    expect(await (await db()).count('syncQueue')).toBe(0)
  })

  it('still refreshes an empty hidden tab when the connection returns', async () => {
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('cleans up timer and event listeners when disposed', async () => {
    const changed = vi.fn()
    dispose = installAutoSync(changed)
    dispose()
    visibility('visible'); document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not suppress explicit sync calls in a hidden tab', async () => {
    dispose = installAutoSync()
    await expect(syncNow()).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
