import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, unlink, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string | undefined
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
  if (directory) {
    await unlink(join(directory, 'state.json')).catch(() => undefined)
    await unlink(join(directory, 'state.json.lock')).catch(() => undefined)
    await rmdir(directory)
    directory = undefined
  }
})
async function fileStore() {
  directory = await mkdtemp(join(tmpdir(), 'ai-todo-push-recovery-'))
  vi.stubEnv('STORAGE_ADAPTER', 'file'); vi.stubEnv('DATA_FILE', join(directory, 'state.json'))
  return (await import('../server/storage')).cloudStore
}
const subscription = { endpoint: 'https://push.example.test/synthetic', keys: { auth: 'synthetic', p256dh: 'synthetic' }, appUrl: 'https://app.example.test/' }
const due = '2026-10-12T00:00:00.000Z', future = '2026-10-13T00:00:00.000Z'

describe('首次 Push 订阅与遗留提醒恢复的原子存储', () => {
  it('CAS只清除匹配且未发送的事件，旧handler不能清除新指针', async () => {
    const store = await fileStore()
    const value = { id: 'test-task', updatedAt: due, reminders: [{ id: 'r1', at: due, eventId: null, sentAt: null, source: 'explicit' as const }] }
    await store.merge([{ entity: 'task', value }])
    await store.setReminderEvent(value.id, 'r1', due, 'new-event')
    expect(await store.clearReminderEventIfCurrent(value.id, 'r1', 'old-event')).toBe(false)
    expect((await store.getTask(value.id))?.reminders?.[0].eventId).toBe('new-event')
    expect(await store.clearReminderEventIfCurrent(value.id, 'r1', 'new-event')).toBe(true)
    expect((await store.getTask(value.id))?.reminders?.[0]).toMatchObject({ eventId: null, sentAt: null })
    await store.setReminderEvent(value.id, 'r1', due, 'sent-event')
    await store.markReminderSent(value.id, 'r1', 'sent-event')
    expect(await store.clearReminderEventIfCurrent(value.id, 'r1', 'sent-event')).toBe(false)
  })
  it('首个订阅清除到期未发送旧指针，同时保留未来、已发送、完成、删除记录', async () => {
    const store = await fileStore()
    const value = { id: 'test-task', updatedAt: due, reminders: [
      { id: 'due', at: due, eventId: null, sentAt: null },
      { id: 'future', at: future, eventId: null, sentAt: null },
      { id: 'sent', at: due, eventId: null, sentAt: null },
      { id: 'unbound', at: due, eventId: null, sentAt: null }
    ] }
    await store.merge([{ entity: 'task', value }])
    for (const id of ['due', 'future', 'sent']) await store.setReminderEvent(value.id, id, id === 'future' ? future : due, `${id}-event`)
    await store.markReminderSent(value.id, 'sent', 'sent-event')
    const transitions = await store.addSubscription(subscription, Date.parse('2026-10-12T00:05:00.000Z'))
    expect(transitions).toEqual({ firstSubscription: true, reminderTransitions: [{ todoId: value.id, oldEventIds: ['due-event'] }] })
    const reminders = (await store.getTask(value.id))!.reminders!
    expect(reminders.find(item => item.id === 'due')).toMatchObject({ eventId: null, sentAt: null })
    expect(reminders.find(item => item.id === 'future')?.eventId).toBe('future-event')
    expect(reminders.find(item => item.id === 'sent')).toMatchObject({ eventId: 'sent-event', sentAt: expect.any(String) })
    expect(await store.addSubscription({ ...subscription, endpoint: 'https://push.example.test/second' }, Date.parse('2026-10-12T00:06:00.000Z'))).toEqual({ firstSubscription: false, reminderTransitions: [] })
  })
  it('首个订阅也可恢复旧版单条提醒，禁用状态不被复活', async () => {
    const store = await fileStore()
    const base = { updatedAt: due, reminderEnabled: true, reminderAt: due, reminderSentAt: null }
    await writeFile(join(directory!, 'state.json'), JSON.stringify({ tasks: [
      { id: 'legacy', ...base, reminderEventId: 'legacy-event' },
      { id: 'completed', ...base, reminderEventId: 'done-event', completed: true },
      { id: 'deleted', ...base, reminderEventId: 'deleted-event', deletedAt: due }
    ] }))
    expect(await store.addSubscription(subscription, Date.parse('2026-10-12T00:05:00.000Z'))).toEqual({ firstSubscription: true, reminderTransitions: [{ todoId: 'legacy', oldEventIds: ['legacy-event'] }] })
    expect((await store.getTask('legacy'))?.reminderEventId).toBeNull()
    expect((await store.getTask('completed'))?.reminderEventId).toBe('done-event')
    expect((await store.getTask('deleted'))?.reminderEventId).toBe('deleted-event')
  })
  it('首次订阅返回的到期transition会以新根事件补排，旧事件CAS不能清掉新指针', async () => {
    const store = await fileStore()
    const value = { id: 'test-task', updatedAt: due, reminders: [{ id: 'r1', at: due, eventId: null, sentAt: null }] }
    await store.merge([{ entity: 'task', value }])
    await store.setReminderEvent(value.id, 'r1', due, 'dead-event')
    const now = Date.parse('2026-10-12T00:05:00.000Z')
    const saved = await store.addSubscription(subscription, now)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'todo.reminder' ? 'fresh-event' : 'cancel-event' })) }
    const { reconcileReminderTransitions } = await import('../server/reminders/scheduler')
    await reconcileReminderTransitions(saved.reminderTransitions, sender, { includeOverdue: true })
    expect(sender.send).toHaveBeenCalledWith('awl:delete-events', { data: { eventIds: ['dead-event'] } })
    expect(sender.send).toHaveBeenCalledWith('todo.reminder', { data: { todoId: value.id, reminderId: 'r1' }, delayUntil: now + 60_000 })
    expect((await store.getTask(value.id))?.reminders?.[0].eventId).toBe('fresh-event')
    expect(await store.clearReminderEventIfCurrent(value.id, 'r1', 'dead-event')).toBe(false)
    expect((await store.getTask(value.id))?.reminders?.[0].eventId).toBe('fresh-event')
    clock.mockRestore()
  })
})
