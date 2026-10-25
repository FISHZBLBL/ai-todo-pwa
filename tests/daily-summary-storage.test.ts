import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
const task = { id: 'task-id', updatedAt: '2026-10-25T00:00:00.000Z', completed: false }
const schedule = { eventId: 'summary-event', scheduledFor: '2026-10-26T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }
const subscription = { endpoint: 'https://push.example.test/subscription' }

beforeEach(async () => {
  vi.resetModules()
  directory = await mkdtemp(join(tmpdir(), 'ai-todo-daily-summary-'))
  vi.stubEnv('STORAGE_ADAPTER', 'file')
  vi.stubEnv('DATA_FILE', join(directory, 'state.json'))
})
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules()
  await unlink(join(directory, 'state.json')).catch(() => undefined)
  await unlink(join(directory, 'state.json.lock')).catch(() => undefined)
  await rmdir(directory)
})

describe('daily summary eligibility storage snapshots', () => {
  it('only becomes eligible with a subscription and an unfinished, undeleted task', async () => {
    const { cloudStore } = await import('../server/storage')
    expect((await cloudStore.getDailySummaryScheduleState()).eligible).toBe(false)
    await cloudStore.addSubscription(subscription)
    expect((await cloudStore.getDailySummaryScheduleState()).eligible).toBe(false)
    const completed = { ...task, id: 'completed', completed: true }
    const deleted = { ...task, id: 'deleted', deletedAt: task.updatedAt }
    await cloudStore.merge([{ entity: 'task', value: completed }, { entity: 'task', value: deleted }])
    expect((await cloudStore.getDailySummaryScheduleState()).eligible).toBe(false)
    await cloudStore.merge([{ entity: 'task', value: task }])
    expect((await cloudStore.getDailySummaryScheduleState()).eligible).toBe(true)
    await cloudStore.removeSubscription(subscription.endpoint)
    expect((await cloudStore.getDailySummaryScheduleState()).eligible).toBe(false)
  })

  it('rejects clearing a schedule when an empty snapshot was superseded by a new task', async () => {
    const { cloudStore } = await import('../server/storage')
    await cloudStore.addSubscription(subscription)
    await cloudStore.setDailySummarySchedule(schedule)
    const emptySnapshot = await cloudStore.getDailySummaryScheduleState()
    expect(emptySnapshot.eligible).toBe(false)
    await cloudStore.merge([{ entity: 'task', value: task }])
    expect(await cloudStore.setDailySummaryScheduleIfCurrent(null, emptySnapshot.schedule, emptySnapshot.settings, emptySnapshot.eligible)).toBe(false)
    expect((await cloudStore.getDailySummaryScheduleState()).schedule).toEqual(schedule)
  })

  it('rejects scheduling after the final subscription disappears', async () => {
    const { cloudStore } = await import('../server/storage')
    await cloudStore.addSubscription(subscription)
    await cloudStore.merge([{ entity: 'task', value: task }])
    const activeSnapshot = await cloudStore.getDailySummaryScheduleState()
    expect(activeSnapshot.eligible).toBe(true)
    await cloudStore.removeSubscription(subscription.endpoint)
    expect(await cloudStore.setDailySummaryScheduleIfCurrent(schedule, activeSnapshot.schedule, activeSnapshot.settings, activeSnapshot.eligible)).toBe(false)
    expect((await cloudStore.getDailySummaryScheduleState()).schedule).toBeNull()
  })
})
