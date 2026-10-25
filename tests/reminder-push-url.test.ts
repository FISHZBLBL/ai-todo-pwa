import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), removeSubscription: vi.fn(), sendNotification: vi.fn(), setVapidDetails: vi.fn() }))
vi.mock('../server/storage', () => ({ cloudStore: { read: mocks.read, removeSubscription: mocks.removeSubscription } }))
vi.mock('../server/config', async () => {
  const { createECDH } = await import('node:crypto')
  const scalar = Buffer.alloc(32); scalar[31] = 1
  const curve = createECDH('prime256v1'); curve.setPrivateKey(scalar)
  return { config: { VAPID_PUBLIC_KEY: curve.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32 - curve.getPrivateKey().length), curve.getPrivateKey()]).toString('base64url'), VAPID_SUBJECT: 'mailto:test@example.com' } }
})
vi.mock('web-push', () => ({ default: { sendNotification: mocks.sendNotification, setVapidDetails: mocks.setVapidDetails } }))

describe('实际 Push payload 的应用子目录链接', () => {
  beforeEach(() => { mocks.read.mockReset(); mocks.removeSubscription.mockReset(); mocks.removeSubscription.mockResolvedValue(undefined); mocks.sendNotification.mockReset(); mocks.sendNotification.mockResolvedValue(undefined) })

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

  it('并发发送最多四个订阅，为慢端点设置超时并在有空位时继续发送', async () => {
    const subscriptions = Array.from({ length: 9 }, (_, index) => ({ endpoint: `https://push.example/${index}`, keys: { auth: 'auth', p256dh: 'p256dh' } }))
    mocks.read.mockResolvedValue({ subscriptions })
    const pending: Array<() => void> = []
    let active = 0, peak = 0
    mocks.sendNotification.mockImplementation(() => new Promise<void>(resolve => {
      active += 1; peak = Math.max(peak, active)
      pending.push(() => { active -= 1; resolve() })
    }))
    const { sendPushPayload } = await import('../server/push')
    const sending = sendPushPayload({ title: '通知', body: '内容', url: '/', tag: 'test' })
    await vi.waitFor(() => expect(mocks.sendNotification).toHaveBeenCalledTimes(4))
    expect(active).toBe(4)
    pending.shift()!()
    await vi.waitFor(() => expect(mocks.sendNotification).toHaveBeenCalledTimes(5))
    expect(active).toBe(4)
    while (mocks.sendNotification.mock.calls.length < subscriptions.length) {
      const previousCount = mocks.sendNotification.mock.calls.length
      pending.shift()!()
      await vi.waitFor(() => expect(mocks.sendNotification.mock.calls.length).toBeGreaterThan(previousCount))
    }
    for (const finish of pending) finish()
    await expect(sending).resolves.toEqual({ sent: 9, failed: 0, subscriptions: 9 })
    expect(peak).toBe(4)
    for (const call of mocks.sendNotification.mock.calls) expect(call[2]).toMatchObject({ timeout: 10_000 })
  })

  it('独立统计混合结果，超时保留订阅，404 和 410 删除过期订阅', async () => {
    const subscriptions = ['ok', 'timeout', 'gone404', 'gone410', 'invalid', 'later'].map(name => ({ endpoint: `https://push.example/${name}`, keys: { auth: name === 'invalid' ? '' : 'auth', p256dh: 'p256dh' } }))
    mocks.read.mockResolvedValue({ subscriptions })
    mocks.sendNotification.mockImplementation(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith('/timeout')) throw new Error('Socket timeout')
      if (subscription.endpoint.endsWith('/gone404')) throw Object.assign(new Error('Not found'), { statusCode: 404 })
      if (subscription.endpoint.endsWith('/gone410')) throw Object.assign(new Error('Gone'), { statusCode: 410 })
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { sendPushPayload } = await import('../server/push')
      await expect(sendPushPayload({ title: '通知', body: '内容', url: '/', tag: 'test' })).resolves.toEqual({ sent: 2, failed: 4, subscriptions: 6 })
      expect(mocks.sendNotification).toHaveBeenCalledTimes(5)
      expect(mocks.removeSubscription.mock.calls.map(call => call[0]).sort()).toEqual(['https://push.example/gone404', 'https://push.example/gone410'])
    } finally { logged.mockRestore() }
  })

  it('全部端点超时仍返回失败计数，让提醒调用方继续现有重试', async () => {
    mocks.read.mockResolvedValue({ subscriptions: [{ endpoint: 'https://push.example/timeout', keys: { auth: 'auth', p256dh: 'p256dh' } }] })
    mocks.sendNotification.mockRejectedValue(new Error('Socket timeout'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { sendPushPayload } = await import('../server/push')
      await expect(sendPushPayload({ title: '通知', body: '内容', url: '/', tag: 'test' })).resolves.toEqual({ sent: 0, failed: 1, subscriptions: 1 })
      expect(mocks.removeSubscription).not.toHaveBeenCalled()
    } finally { logged.mockRestore() }
  })
})
