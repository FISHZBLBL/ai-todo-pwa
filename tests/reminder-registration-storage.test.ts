import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
const version = '2026-10-25T00:00:00.000Z'
const at = '2026-10-25T01:00:00.000Z'

beforeEach(async () => {
  vi.resetModules()
  directory = await mkdtemp(join(tmpdir(), 'ai-todo-reminder-registration-'))
  vi.stubEnv('STORAGE_ADAPTER', 'file')
  vi.stubEnv('DATA_FILE', join(directory, 'state.json'))
})
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules()
  await unlink(join(directory, 'state.json')).catch(() => undefined)
  await unlink(join(directory, 'state.json.lock')).catch(() => undefined)
  await rmdir(directory)
})

const task = (legacy: boolean, extra: Record<string, unknown> = {}, reminderExtra: Record<string, unknown> = {}) => ({
  id: 'todo', updatedAt: version, completed: false,
  ...(legacy ? { reminderEnabled: true, reminderAt: at, reminderEventId: null, reminderSentAt: null, ...reminderExtra }
    : { reminders: [{ id: 'r1', at, eventId: null, sentAt: null, ...reminderExtra }] }),
  ...extra,
})
async function seed(value: ReturnType<typeof task>) {
  await writeFile(join(directory, 'state.json'), JSON.stringify({ tasks: [value] }))
  return (await import('../server/storage')).cloudStore
}

describe('到点自登记的原子版本检查', () => {
  it.each([false, true])('为原样保存的未绑定事项登记（legacy=%s）', async legacy => {
    const store = await seed(task(legacy))
    expect(await store.bindUnregisteredReminder('todo', legacy ? 'legacy' : 'r1', at, 'cf:event', version)).toBe(true)
    const current = await store.getTask('todo')
    expect(legacy ? current?.reminderEventId : current?.reminders?.[0]?.eventId).toBe('cf:event')
    expect(current?.updatedAt).toBe(version)
  })

  it.each([false, true])('同时间但版本较新的事项拒绝旧事件登记（legacy=%s）', async legacy => {
    const store = await seed(task(legacy, { updatedAt: '2026-10-25T00:00:01.000Z' }))
    expect(await store.bindUnregisteredReminder('todo', legacy ? 'legacy' : 'r1', at, 'cf:stale', version)).toBe(false)
    const current = await store.getTask('todo')
    expect(legacy ? current?.reminderEventId : current?.reminders?.[0]?.eventId).toBeNull()
  })

  it.each([
    [{ completed: true }, {}],
    [{ deletedAt: version }, {}],
    [{}, { eventId: 'cf:other' }],
    [{}, { sentAt: version }],
    [{}, { at: '2026-10-25T02:00:00.000Z' }],
  ])('不会恢复已完成、删除、已发送或被修改的提醒 %#', async (extra, reminderExtra) => {
    const store = await seed(task(false, extra, reminderExtra))
    expect(await store.bindUnregisteredReminder('todo', 'r1', at, 'cf:stale', version)).toBe(false)
  })

  it('两个事件并发登记仅一个能获得当前指针', async () => {
    const store = await seed(task(false))
    const results = await Promise.all([
      store.bindUnregisteredReminder('todo', 'r1', at, 'cf:first', version),
      store.bindUnregisteredReminder('todo', 'r1', at, 'cf:second', version),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await store.getTask('todo'))?.reminders?.[0]?.eventId).toBe(results[0] ? 'cf:first' : 'cf:second')
  })

  it.each([false, true])('退订快照过期后不能清除新订阅使用的事件（legacy=%s）', async legacy => {
    const store = await seed(task(legacy, {}, legacy ? { reminderEventId: 'cf:future' } : { eventId: 'cf:future' }))
    expect((await store.read()).subscriptions).toHaveLength(0)
    await store.addSubscription({ endpoint: 'https://push.example.test/new-device' }, Date.parse('2026-10-24T00:00:00.000Z'))
    expect(await store.clearReminderEventIfCurrent('todo', legacy ? 'legacy' : 'r1', 'cf:future', { requireNoSubscriptions: true })).toBe(false)
    const current = await store.getTask('todo')
    expect(legacy ? current?.reminderEventId : current?.reminders?.[0]?.eventId).toBe('cf:future')
  })

  it.each([false, true])('最后一个订阅确实已移除时可清除事件（legacy=%s）', async legacy => {
    const store = await seed(task(legacy, {}, legacy ? { reminderEventId: 'cf:future' } : { eventId: 'cf:future' }))
    expect(await store.clearReminderEventIfCurrent('todo', legacy ? 'legacy' : 'r1', 'cf:future', { requireNoSubscriptions: true })).toBe(true)
    const current = await store.getTask('todo')
    expect(legacy ? current?.reminderEventId : current?.reminders?.[0]?.eventId).toBeNull()
  })
})
