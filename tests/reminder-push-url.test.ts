import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), removeSubscription: vi.fn(), sendNotification: vi.fn(), setVapidDetails: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: { read: mocks.read, removeSubscription: mocks.removeSubscription } }))
vi.mock('../server/config', () => ({ config: { VAPID_PUBLIC_KEY: 'test-public', VAPID_PRIVATE_KEY: 'test-private', VAPID_SUBJECT: 'mailto:test@example.com' } }))
vi.mock('web-push', () => ({ default: { sendNotification: mocks.sendNotification, setVapidDetails: mocks.setVapidDetails } }))

describe('实际 Push payload 的应用子目录链接', () => {
  beforeEach(() => { mocks.read.mockReset(); mocks.sendNotification.mockReset(); mocks.sendNotification.mockResolvedValue(undefined) })

  it.each([
    ['https://site.example/repo/', '/?todo=task-1', 'https://site.example/repo/?todo=task-1'],
    ['https://site.example/repo/', '/', 'https://site.example/repo/'],
    ['https://site.example/', '/?todo=task-1', 'https://site.example/?todo=task-1'],
    ['https://site.example/', '/', 'https://site.example/'],
    ['https://site.example/repo', '/?todo=task-1', 'https://site.example/repo/?todo=task-1']
  ])('appUrl=%s 与通知路径=%s 保持正确入口', async (appUrl, path, expected) => {
    mocks.read.mockResolvedValue({ subscriptions: [{ endpoint: 'https://push.example/subscription', appUrl, keys: { auth: 'auth', p256dh: 'p256dh' } }] })
    const { sendPushPayload } = await import('../server/push')
    await expect(sendPushPayload({ title: '通知', body: '内容', url: path, tag: 'test' })).resolves.toEqual({ sent: 1, failed: 0, subscriptions: 1 })
    expect(JSON.parse(mocks.sendNotification.mock.calls[0][1])).toMatchObject({ url: expected })
  })

  it.each(['https://other.example/', '//other.example/', '/../other', '/\\other'])('拒绝非应用首页的通知目标 %s', async path => {
    mocks.read.mockResolvedValue({ subscriptions: [{ endpoint: 'https://push.example/subscription', appUrl: 'https://site.example/repo/', keys: { auth: 'auth', p256dh: 'p256dh' } }] })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { sendPushPayload } = await import('../server/push')
    await expect(sendPushPayload({ title: '通知', body: '内容', url: path, tag: 'test' })).resolves.toEqual({ sent: 0, failed: 1, subscriptions: 1 })
    expect(mocks.sendNotification).not.toHaveBeenCalled()
    logged.mockRestore()
  })
})
