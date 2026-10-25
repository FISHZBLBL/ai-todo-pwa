import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const getTask = vi.fn(), setReminderEvent = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { getTask, setReminderEvent } }))
const at = (hour: number) => `2026-08-28T${`${hour}`.padStart(2, '0')}:00:00.000Z`
const updatedAt = '2026-08-28T00:00:00.000Z'
const task = (reminders: unknown[], extra = {}) => ({ id: 'todo-1', updatedAt, reminders, completed: false, deletedAt: null, ...extra })
describe('多提醒事件调度', () => {
  beforeEach(() => { getTask.mockReset(); setReminderEvent.mockReset(); setReminderEvent.mockResolvedValue(true); vi.stubGlobal('Netlify', undefined); vi.stubEnv('REMINDER_SCHEDULER_URL', ''); vi.stubEnv('REMINDER_SCHEDULER_SECRET', '') })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  it('为多条 reminder 创建各自独立的 event', async () => { getTask.mockResolvedValue(task([{ id: 'r1', at: at(10), eventId: null, sentAt: null }, { id: 'r2', at: at(11), eventId: null, sentAt: null }])); const sender = { send: vi.fn(async (_: string) => ({ sendStatus: 'succeeded' as const, eventId: `e${sender.send.mock.calls.length}` })) }; const { reconcileReminder } = await import('../server/reminders/scheduler'); await expect(reconcileReminder({ todoId: 'todo-1', oldEventIds: [] }, sender, Date.parse(at(9)))).resolves.toEqual({ eventIds: ['e1', 'e2'] }); expect(sender.send).toHaveBeenNthCalledWith(1, 'todo.reminder', { data: { todoId: 'todo-1', reminderId: 'r1', expectedAt: at(10), expectedUpdatedAt: updatedAt }, delayUntil: Date.parse(at(10)) }); expect(setReminderEvent).toHaveBeenCalledWith('todo-1', 'r2', at(11), 'e2') })
  it('已有 event 的 reminder 不会重建', async () => { getTask.mockResolvedValue(task([{ id: 'r1', at: at(10), eventId: 'e1', sentAt: null }])); const sender = { send: vi.fn() }; const { reconcileReminder } = await import('../server/reminders/scheduler'); await reconcileReminder({ todoId: 'todo-1', oldEventIds: [] }, sender, Date.parse(at(9))); expect(sender.send).not.toHaveBeenCalled() })
  it('修改一条提醒只取消它的旧 event 并调度新的', async () => { getTask.mockResolvedValue(task([{ id: 'r1', at: at(11), eventId: null, sentAt: null }, { id: 'r2', at: at(12), eventId: 'e2', sentAt: null }])); const sender = { send: vi.fn(async (name: string) => ({ sendStatus: 'succeeded' as const, eventId: name === 'awl:delete-events' ? 'cancel' : 'e1new' })) }; const { reconcileReminder } = await import('../server/reminders/scheduler'); await reconcileReminder({ todoId: 'todo-1', oldEventIds: ['e1old'] }, sender, Date.parse(at(9))); expect(sender.send).toHaveBeenNthCalledWith(1, 'awl:delete-events', { data: { eventIds: ['e1old'] } }); expect(sender.send).toHaveBeenCalledTimes(2) })
  it('完成、删除和过去时间不调度新 event', async () => { const { reconcileReminder } = await import('../server/reminders/scheduler'); const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'x' })) }; getTask.mockResolvedValue(task([], { completed: true })); await reconcileReminder({ todoId: 'todo-1', oldEventIds: ['e1', 'e2'] }, sender, Date.parse(at(9))); getTask.mockResolvedValue(task([{ id: 'past', at: at(8), eventId: null, sentAt: null }])); await reconcileReminder({ todoId: 'todo-1', oldEventIds: [] }, sender, Date.parse(at(9))); expect(sender.send).toHaveBeenCalledOnce() })
  it('调度可用性由 Cloudflare 服务地址和密钥决定，无需 Netlify 请求上下文', async () => {
    const { isReminderSchedulingAvailable } = await import('../server/reminders/scheduler')
    expect(isReminderSchedulingAvailable()).toBe(false)
    vi.stubGlobal('Netlify', { context: { url: 'https://example.netlify.app/api/sync' } })
    expect(isReminderSchedulingAvailable()).toBe(false)
    vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.workers.dev')
    vi.stubEnv('REMINDER_SCHEDULER_SECRET', 'synthetic-scheduler-secret-1234567890')
    vi.stubGlobal('Netlify', undefined)
    expect(isReminderSchedulingAvailable()).toBe(true)
    vi.stubGlobal('Netlify', { context: { url: 'invalid' } })
    expect(isReminderSchedulingAvailable()).toBe(true)
    vi.stubEnv('REMINDER_SCHEDULER_SECRET', 'too-short')
    expect(isReminderSchedulingAvailable()).toBe(false)
  })
  it('读取 Netlify 运行时环境中的 Cloudflare 配置，拒绝不安全地址', async () => {
    const { isReminderSchedulingAvailable } = await import('../server/reminders/scheduler')
    const values = { REMINDER_SCHEDULER_URL: 'https://reminders.example.workers.dev', REMINDER_SCHEDULER_SECRET: 'synthetic-scheduler-secret-1234567890' }
    vi.stubGlobal('Netlify', { env: { get: (name: keyof typeof values) => values[name] } })
    expect(isReminderSchedulingAvailable()).toBe(true)
    values.REMINDER_SCHEDULER_URL = 'http://reminders.example.workers.dev'
    expect(isReminderSchedulingAvailable()).toBe(false)
  })
})
