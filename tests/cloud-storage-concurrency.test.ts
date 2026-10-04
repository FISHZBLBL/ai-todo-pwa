import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string | undefined
afterEach(async () => {
  vi.useRealTimers()
  vi.doUnmock('../server/cos')
  vi.resetModules()
  for (const key of ['STORAGE_ADAPTER', 'DATA_FILE', 'COS_BUCKET', 'COS_REGION', 'COS_SECRET_ID', 'COS_SECRET_KEY']) delete process.env[key]
  if (directory) {
    await unlink(join(directory, 'state.json')).catch(() => undefined)
    await unlink(join(directory, 'state.json.lock')).catch(() => undefined)
    await rmdir(directory)
    directory = undefined
  }
})

async function fileStore() {
  directory = await mkdtemp(join(tmpdir(), 'ai-todo-storage-'))
  process.env.STORAGE_ADAPTER = 'file'
  process.env.DATA_FILE = join(directory, 'state.json')
  return (await import('../server/storage')).cloudStore
}

function useMockCos(options: { slowFirstWrite?: boolean; uncertainCommit?: boolean } = {}) {
  process.env.STORAGE_ADAPTER = 'cos'
  process.env.COS_BUCKET = 'test-bucket-1234567890'
  process.env.COS_REGION = 'ap-shanghai'
  process.env.COS_SECRET_ID = 'test-only-id'
  process.env.COS_SECRET_KEY = 'test-only-secret'
  const objects = new Map<string, string>()
  const writes: string[] = []
  let instanceCount = 0
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  vi.doMock('../server/cos', () => ({ CosObjectStore: class {
    readonly instance = ++instanceCount
    async assertSafeLocking() {}
    async getText(key: string) { if (options.slowFirstWrite && this.instance === 1 && !key.endsWith('.lock')) await delay(11000); return objects.get(key) ?? null }
    async putText(key: string, value: string, opts: { forbidOverwrite?: boolean } = {}) {
      if (options.slowFirstWrite && this.instance === 1) await delay(key.endsWith('.lock') ? 11000 : 9000)
      if (opts.forbidOverwrite && objects.has(key)) return false
      if (!key.endsWith('.lock') && options.uncertainCommit) throw new Error('连接腾讯 COS 超时')
      objects.set(key, value)
      writes.push(key)
      return true
    }
    async delete(key: string) { objects.delete(key) }
  } }))
  return { objects, writes }
}

describe('cloud storage mutation safety', () => {
  it('serializes writers even when the first COS operation lasts more than 30 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
    const { objects } = useMockCos({ slowFirstWrite: true })
    const firstStore = (await import('../server/storage')).cloudStore
    vi.resetModules()
    const secondStore = (await import('../server/storage')).cloudStore
    const first = firstStore.merge([{ entity: 'task', value: { id: 'first', updatedAt: '2026-10-04T00:00:00Z' } }])
    await vi.advanceTimersByTimeAsync(30000)
    const second = secondStore.merge([{ entity: 'task', value: { id: 'second', updatedAt: '2026-10-04T00:00:01Z' } }])
    const completed = Promise.all([first, second])
    await vi.advanceTimersByTimeAsync(2000)
    await completed
    expect(JSON.parse(objects.get('ai-todo/state.json')!).tasks.map((task: any) => task.id).sort()).toEqual(['first', 'second'])
    expect(objects.has('ai-todo/state.json.lock')).toBe(false)
  })

  it('retains the COS lock after an uncertain state PUT so a late write cannot overwrite a newer writer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
    const { objects, writes } = useMockCos({ uncertainCommit: true })
    const { cloudStore } = await import('../server/storage')
    await expect(cloudStore.merge([{ entity: 'task', value: { id: 'first', updatedAt: '2026-10-04T00:00:00Z' } }])).rejects.toThrow('超时')
    expect(objects.has('ai-todo/state.json.lock')).toBe(true)
    const rejection = expect(cloudStore.merge([])).rejects.toThrow('已停止写入')
    await vi.advanceTimersByTimeAsync(8200)
    await rejection
    expect(writes).toEqual(['ai-todo/state.json.lock'])
  })

  it.each(['task', 'draft', 'profile'] as const)('retains only the deletion version for an expired %s and rejects a stale offline record', async entity => {
    const cloudStore = await fileStore()
    const deleted = { id: 'deleted-id', title: 'private-body', content: 'private-content', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', deletedAt: '2026-01-02T00:00:00Z' }
    await cloudStore.merge([{ entity, value: deleted }])
    await cloudStore.purgeExpiredTombstones(new Date('2026-02-04T00:00:00Z'))
    const persisted = await readFile(join(directory!, 'state.json'), 'utf8')
    expect(persisted).not.toContain('private-body')
    expect(persisted).not.toContain('private-content')
    const result = await cloudStore.merge([{ entity, value: { ...deleted, deletedAt: null, updatedAt: '2026-01-01T00:00:00Z' } }])
    expect(result.tasks).toHaveLength(0)
    expect(result.drafts).toHaveLength(0)
    expect(result.profiles).toHaveLength(0)
    expect(result.deletions).toEqual([{ entity, id: deleted.id, updatedAt: deleted.updatedAt, deletedAt: deleted.deletedAt }])
  })

  it('rejects an old settings snapshot and an obsolete schedule when committing daily summary scheduling', async () => {
    const cloudStore = await fileStore()
    const firstSettings = { id: 'settings', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', schemaVersion: 2, updatedAt: '2026-10-04T00:00:00Z' }
    const firstSchedule = { eventId: 'old-event', scheduledFor: '2026-10-05T00:00:00Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
    await cloudStore.merge([{ entity: 'settings', value: firstSettings }])
    await cloudStore.setDailySummarySchedule(firstSchedule)
    const snapshot = await cloudStore.getDailySummaryScheduleState()
    const latestSettings = { ...firstSettings, dailySummaryTime: '09:00', updatedAt: '2026-10-04T00:00:01Z' }
    const latestSchedule = { ...firstSchedule, eventId: 'new-event', dailySummaryTime: '09:00', scheduledFor: '2026-10-05T01:00:00Z' }
    await cloudStore.merge([{ entity: 'settings', value: latestSettings }])
    expect(await cloudStore.setDailySummaryScheduleIfCurrent(firstSchedule, snapshot.schedule, snapshot.settings)).toBe(false)
    expect(await cloudStore.setDailySummaryScheduleIfCurrent(latestSchedule, snapshot.schedule, latestSettings)).toBe(true)
    expect(await cloudStore.setDailySummaryScheduleIfCurrent(firstSchedule, snapshot.schedule, latestSettings)).toBe(false)
    expect((await cloudStore.getDailySummaryScheduleState()).schedule).toEqual(latestSchedule)
  })

  it('preserves a newer explicit edit while old deletion history remains available to old clients', async () => {
    const cloudStore = await fileStore()
    await cloudStore.merge([{ entity: 'task', value: { id: 'task-id', updatedAt: '2026-01-02T00:00:00Z', deletedAt: '2026-01-02T00:00:00Z' } }])
    await cloudStore.purgeExpiredTombstones(new Date('2026-02-04T00:00:00Z'))
    const restored = { id: 'task-id', title: 'restored', updatedAt: '2026-02-05T00:00:00Z', deletedAt: null }
    const result = await cloudStore.merge([{ entity: 'task', value: restored }])
    expect(result.tasks[0].title).toBe('restored')
  })

  it('advances a recurring reminder without a child event so maintenance can schedule a fresh root', async () => {
    const cloudStore = await fileStore()
    const rule = { unit: 'week' as const, interval: 1, end: 'never' as const, count: null, until: null, occurrence: 1, timezone: 'Asia/Shanghai', countdown: false }
    await cloudStore.merge([{ entity: 'task', value: { id: 'task-id', updatedAt: '2026-10-04T00:00:00Z', reminders: [{ id: 'r1', at: '2026-10-04T00:00:00Z', eventId: null, sentAt: null, recurrence: rule }] } as any }])
    await cloudStore.setReminderEvent('task-id', 'r1', '2026-10-04T00:00:00Z', 'event-1')
    expect(await cloudStore.advanceReminderOccurrence('task-id', 'r1', 'event-1', { at: '2026-10-11T00:00:00Z', recurrence: { ...rule, occurrence: 2 } }, null)).toBe(true)
    expect((await cloudStore.getTask('task-id'))?.reminders?.[0]).toMatchObject({ at: '2026-10-11T00:00:00Z', eventId: null, recurrence: { occurrence: 2 } })
  })

  it('compares historical offset versions and normalized UTC by their actual instant, including deletion retention', async () => {
    const cloudStore = await fileStore()
    const historical = { id: 'task-id', title: 'old', updatedAt: '2026-10-04T09:00:00+08:00' }
    const settings = { id: 'settings', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', schemaVersion: 3, updatedAt: historical.updatedAt }
    const equivalent = { id: 'equal-id', title: 'original', updatedAt: '2026-10-04T01:00:00-08:00' }
    await cloudStore.merge([{ entity: 'task', value: historical }, { entity: 'settings', value: settings }, { entity: 'task', value: equivalent }])
    const updated = { ...historical, title: 'new', updatedAt: '2026-10-04T02:00:00Z' }
    const updatedSettings = { ...settings, dailySummaryTime: '09:00', updatedAt: updated.updatedAt }
    const equalUpdate = { ...equivalent, title: 'equal edit must not overwrite', updatedAt: '2026-10-04T09:00:00Z' }
    const result = await cloudStore.merge([{ entity: 'task', value: updated }, { entity: 'settings', value: updatedSettings }, { entity: 'task', value: equalUpdate }])
    expect(result.tasks.find(task => task.id === historical.id)?.title).toBe('new')
    expect(result.settings?.dailySummaryTime).toBe('09:00')
    expect(result.tasks.find(task => task.id === equivalent.id)?.title).toBe('original')

    await cloudStore.merge([{ entity: 'task', value: { id: 'deleted-id', updatedAt: '2026-01-02T02:00:00+08:00', deletedAt: '2026-01-02T02:00:00+08:00' } }])
    await cloudStore.purgeExpiredTombstones(new Date('2026-02-04T00:00:00Z'))
    const restore = { id: 'deleted-id', title: 'explicit newer restoration', updatedAt: '2026-01-01T19:00:00Z', deletedAt: null }
    expect((await cloudStore.merge([{ entity: 'task', value: restore }])).tasks.find(task => task.id === restore.id)?.title).toBe(restore.title)
    await cloudStore.merge([{ entity: 'task', value: { id: restore.id, updatedAt: '2026-01-01T20:00:00Z', deletedAt: '2026-01-01T20:00:00Z' } }])
    await cloudStore.purgeExpiredTombstones(new Date('2026-02-04T00:00:00Z'))
    const afterOldOfflineUpload = await cloudStore.merge([{ entity: 'task', value: { ...restore, updatedAt: '2026-01-01T19:30:00Z' } }])
    expect(afterOldOfflineUpload.tasks.some(task => task.id === restore.id)).toBe(false)
    expect(afterOldOfflineUpload.deletions.find(value => value.id === restore.id)?.updatedAt).toBe('2026-01-01T20:00:00Z')
  })
})
