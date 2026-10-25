import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createECDH } from 'node:crypto'
import { ErrorDoNotRetry, ErrorRetryAfterDelay } from '../server/reminders/workflow'

const mocks = vi.hoisted(() => ({
  config: { VAPID_PUBLIC_KEY: 'test-public', VAPID_PRIVATE_KEY: 'test-private', VAPID_SUBJECT: 'mailto:test@example.com', APP_TIMEZONE: 'Asia/Shanghai' },
  read: vi.fn(), getTask: vi.fn(), markReminderSent: vi.fn(), setReminderEvent: vi.fn(), clearReminderEventIfCurrent: vi.fn(), removeSubscription: vi.fn(), getDailySummaryScheduleState: vi.fn(),
  sendNotification: vi.fn(), setVapidDetails: vi.fn()
}))
vi.mock('../server/config', () => ({ config: mocks.config }))
vi.mock('../server/storage', () => ({ cloudStore: { read: mocks.read, getTask: mocks.getTask, markReminderSent: mocks.markReminderSent, setReminderEvent: mocks.setReminderEvent, clearReminderEventIfCurrent: mocks.clearReminderEventIfCurrent, removeSubscription: mocks.removeSubscription, getDailySummaryScheduleState: mocks.getDailySummaryScheduleState } }))
vi.mock('web-push', () => ({ default: { sendNotification: mocks.sendNotification, setVapidDetails: mocks.setVapidDetails } }))

const task = (eventId: string | null = 'registered-event') => ({ id: 'synthetic-task', title: '本地诊断任务', completed: false, deletedAt: null, reminders: [{ id: 'r1', at: new Date(Date.now() - 60_000).toISOString(), eventId, sentAt: null, source: 'explicit' }] })
const event = () => ({ eventName: 'todo.reminder', eventData: { todoId: 'synthetic-task', reminderId: 'r1' }, eventId: 'registered-event', attempt: 0, request: new Request('https://example.test'), step: { run: async (_key: string, callback: () => unknown) => callback() } })

describe('提醒故障状态的本地只读诊断', () => {
  beforeEach(() => {
    for (const fn of [mocks.read, mocks.getTask, mocks.markReminderSent, mocks.setReminderEvent, mocks.clearReminderEventIfCurrent, mocks.removeSubscription, mocks.getDailySummaryScheduleState, mocks.sendNotification, mocks.setVapidDetails]) fn.mockReset()
    const keyPair = createECDH('prime256v1'); keyPair.generateKeys()
    mocks.config.VAPID_PUBLIC_KEY = keyPair.getPublicKey().toString('base64url'); mocks.config.VAPID_PRIVATE_KEY = keyPair.getPrivateKey().toString('base64url')
    mocks.read.mockResolvedValue({ tasks: [], subscriptions: [] })
    mocks.getTask.mockResolvedValue(task())
    mocks.getDailySummaryScheduleState.mockResolvedValue({ settings: { dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' }, schedule: { eventId: 'future-summary', scheduledFor: '2099-01-01T00:00:00.000Z', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai' } })
  })

  it('配置缺失先报 VAPID 未配置，不接触订阅或推送端点', async () => {
    mocks.config.VAPID_PUBLIC_KEY = ''
    const { sendPushPayload } = await import('../server/push')
    await expect(sendPushPayload({ title: '诊断', body: '', url: '/', tag: 'diagnostic' })).rejects.toThrow('VAPID 未配置')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it('事件尚未登记时报登记重试，尚未执行 Push 检查', async () => {
    mocks.getTask.mockResolvedValue(task(null))
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toBeInstanceOf(ErrorRetryAfterDelay)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it('VAPID 已配但无订阅时先CAS清除未发送事件指针，再停止当前事件', async () => {
    const current = task()
    mocks.getTask.mockResolvedValue(current)
    mocks.clearReminderEventIfCurrent.mockImplementation(async (_todoId, _reminderId, eventId) => { if (current.reminders[0].eventId !== eventId) return false; current.reminders[0].eventId = null; return true })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toBeInstanceOf(ErrorDoNotRetry)
    expect(current.reminders[0]).toMatchObject({ eventId: null, sentAt: null })
    expect(mocks.clearReminderEventIfCurrent).toHaveBeenCalledWith('synthetic-task', 'r1', 'registered-event', { requireNoSubscriptions: true })
    expect(mocks.markReminderSent).not.toHaveBeenCalled()
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it('零订阅终止后保留未发送状态，新增订阅触发明确的事项重排', async () => {
    const current = task()
    const state: { tasks: typeof current[]; subscriptions: unknown[] } = { tasks: [current], subscriptions: [] }
    mocks.read.mockImplementation(async () => state)
    mocks.getTask.mockImplementation(async () => current)
    mocks.clearReminderEventIfCurrent.mockImplementation(async (_todoId, _reminderId, eventId) => { if (current.reminders[0].eventId !== eventId) return false; current.reminders[0].eventId = null; return true })
    mocks.setReminderEvent.mockImplementation(async (_todoId, _reminderId, _at, eventId) => { if (current.reminders[0].eventId) return false; current.reminders[0].eventId = eventId; return true })
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toBeInstanceOf(ErrorDoNotRetry)
    const sender = { send: vi.fn(async () => ({ sendStatus: 'succeeded' as const, eventId: 'recovered-event' })) }
    expect(sender.send).not.toHaveBeenCalled()
    expect(mocks.setReminderEvent).not.toHaveBeenCalled()
    state.subscriptions.push({ endpoint: 'https://push.example.test/synthetic', keys: { auth: 'synthetic', p256dh: 'synthetic' }, appUrl: 'https://app.example.test/' })
    const { reconcileReminder } = await import('../server/reminders/scheduler')
    await reconcileReminder({ todoId: current.id, oldEventIds: [] }, sender, Date.now(), { includeOverdue: true })
    expect(sender.send).toHaveBeenCalledOnce()
    expect(current.reminders[0]).toMatchObject({ eventId: 'recovered-event', sentAt: null })
    expect(mocks.sendNotification).not.toHaveBeenCalled()
  })

  it('零订阅快照后新订阅到达时保留事件并重试，不清掉新设备的提醒', async () => {
    const current = task()
    mocks.getTask.mockResolvedValue(current)
    mocks.clearReminderEventIfCurrent.mockResolvedValue(false)
    const { handleTodoReminder } = await import('../netlify/functions/todo-reminder')
    await expect(handleTodoReminder(event() as never)).rejects.toBeInstanceOf(ErrorRetryAfterDelay)
    expect(current.reminders[0].eventId).toBe('registered-event')
    expect(mocks.clearReminderEventIfCurrent).toHaveBeenCalledWith('synthetic-task', 'r1', 'registered-event', { requireNoSubscriptions: true })
    expect(mocks.markReminderSent).not.toHaveBeenCalled()
  })
})
