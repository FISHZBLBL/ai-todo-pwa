import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PushConfig } from '../src/services/api'
import { flushPromises, mountSfc } from './helpers/mountSfc'

const publicKey = Buffer.from([4, ...Array.from({ length: 64 }, () => 1)]).toString('base64url')
const oldPublicKey = Buffer.from([4, ...Array.from({ length: 64 }, () => 2)]).toString('base64url')
const validConfig: PushConfig = { configured: true, publicKey, reason: null, schedulingAvailable: true }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Settings Web Push 运行时公钥', () => {
  it('构建时未提供 VITE_VAPID_PUBLIC_KEY、服务器已配置时仍能订阅', async () => {
    const mounted = mountSettings()
    await flushPromises()
    await mounted.vm.enablePush()
    expect(mounted.vm.pushMessage).toBe('当前设备已订阅提醒')
    expect(mounted.api.getPushConfig).toHaveBeenCalled()
    expect(mounted.subscribe).toHaveBeenCalledTimes(1)
    expect(mounted.api.savePush).toHaveBeenCalledTimes(1)
  })

  it('构建值过时也使用服务器当前公钥', async () => {
    const mounted = mountSettings(validConfig, { buildPublicKey: oldPublicKey })
    await flushPromises()
    await mounted.vm.enablePush()
    const used = mounted.subscribe.mock.calls[0][0].applicationServerKey as Uint8Array
    expect([...used]).toEqual([...Buffer.from(publicKey, 'base64url')])
  })

  it.each([
    ['missing_public_key', '服务端尚未配置 Web Push 公钥'],
    ['missing_private_key', '服务端尚未配置 Web Push 私钥'],
    ['invalid_keys', '服务端 Web Push 密钥格式无效'],
    ['key_mismatch', '服务端 Web Push 公钥与私钥不匹配']
  ] as const)('运行时配置不可用（%s）时不使用旧构建值，也不破坏现有订阅', async (reason, message) => {
    const subscription = makeSubscription(oldPublicKey, 'old')
    const mounted = mountSettings({ configured: false, publicKey: null, reason, schedulingAvailable: true }, { subscription, buildPublicKey: oldPublicKey })
    await flushPromises()
    await mounted.vm.enablePush()
    expect(mounted.vm.pushMessage).toContain(message)
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(mounted.subscribe).not.toHaveBeenCalled()
    expect(mounted.api.savePush).not.toHaveBeenCalled()
    expect(mounted.vm.pushRegistered).toBe(false)
  })

  it('旧订阅使用其他公钥时先显示未订阅，再由用户点击重建', async () => {
    const subscription = makeSubscription(oldPublicKey, 'old')
    const mounted = mountSettings(validConfig, { subscription })
    await flushPromises()
    expect(mounted.vm.pushRegistered).toBe(false)
    expect(mounted.vm.pushMessage).toContain('旧公钥')
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    await mounted.vm.enablePush()
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(mounted.subscribe).toHaveBeenCalledTimes(1)
    expect(mounted.api.savePush).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.test/current' }))
    expect(mounted.vm.pushRegistered).toBe(true)
  })

  it('无法识别旧订阅公钥时也重建，避免保留不可用的旧订阅', async () => {
    const subscription = makeSubscription(undefined, 'legacy')
    const mounted = mountSettings(validConfig, { subscription })
    await flushPromises()
    await mounted.vm.enablePush()
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(mounted.subscribe).toHaveBeenCalledTimes(1)
  })

  it('公钥一致的有效订阅复用并重新登记服务端，不重复向浏览器订阅', async () => {
    const subscription = makeSubscription(publicKey)
    const mounted = mountSettings(validConfig, { subscription })
    await flushPromises()
    expect(mounted.vm.pushRegistered).toBe(true)
    await mounted.vm.enablePush()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(mounted.subscribe).not.toHaveBeenCalled()
    expect(mounted.api.savePush).toHaveBeenCalledTimes(1)
  })

  it.each([
    Buffer.from([4, 1, 2]).toString('base64url'),
    Buffer.from([3, ...Array.from({ length: 64 }, () => 1)]).toString('base64url'),
    'not a key!'
  ])('运行时公钥长度、首字节或编码不合法时不给浏览器订阅 (%s)', async key => {
    const subscription = makeSubscription(oldPublicKey, 'old')
    const mounted = mountSettings({ ...validConfig, publicKey: key }, { subscription })
    await flushPromises()
    await mounted.vm.enablePush()
    expect(mounted.vm.pushMessage).toBe('服务端 Web Push 公钥格式无效')
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(mounted.subscribe).not.toHaveBeenCalled()
  })

  it('调度未启用时可以注册浏览器订阅，并明确说明自动提醒尚未启用', async () => {
    const mounted = mountSettings({ ...validConfig, schedulingAvailable: false })
    await flushPromises()
    await mounted.vm.enablePush()
    expect(mounted.vm.pushMessage).toBe('当前设备已订阅提醒')
    expect(mounted.subscribe).toHaveBeenCalledTimes(1)
    expect(mounted.container.textContent).toContain('服务端提醒调度尚未启用')
  })

  it('连续点击只请求一次通知授权，并且只登记一次订阅', async () => {
    let grantPermission!: (permission: NotificationPermission) => void
    const permission = new Promise<NotificationPermission>(resolve => { grantPermission = resolve })
    const mounted = mountSettings(validConfig, { permission: 'default', permissionResult: permission })
    await flushPromises()
    const first = mounted.vm.enablePush()
    const second = mounted.vm.enablePush()
    expect(mounted.requestPermission).toHaveBeenCalledTimes(1)
    grantPermission('granted')
    await Promise.all([first, second])
    expect(mounted.subscribe).toHaveBeenCalledTimes(1)
    expect(mounted.api.savePush).toHaveBeenCalledTimes(1)
    expect(mounted.vm.pushBusy).toBe(false)
  })
})

function makeSubscription(key?: string, suffix = 'current') {
  const endpoint = `https://push.example.test/${suffix}`
  return {
    endpoint,
    options: { applicationServerKey: key ? new Uint8Array(Buffer.from(key, 'base64url')).buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'test-client-key', auth: 'test-client-auth' } }),
    unsubscribe: vi.fn(async () => true)
  }
}

function mountSettings(config: PushConfig = validConfig, options: { subscription?: ReturnType<typeof makeSubscription>; buildPublicKey?: string; permission?: NotificationPermission; permissionResult?: Promise<NotificationPermission> } = {}) {
  const subscribe = vi.fn(async (_options: PushSubscriptionOptionsInit) => makeSubscription(publicKey))
  const requestPermission = vi.fn(async () => await (options.permissionResult ?? Promise.resolve('granted')))
  vi.stubGlobal('Notification', { permission: options.permission ?? 'granted', requestPermission })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn(async () => options.subscription ?? null), subscribe } }) } })
  const api = {
    getPushConfig: vi.fn(async () => config),
    health: vi.fn(async () => ({ ai: { provider: 'test', model: 'test', configured: false } })),
    getDeepseekSettings: vi.fn(async () => ({ deepseek: { configured: false, maskedKey: null, updatedAt: null } })),
    savePush: vi.fn(async () => ({ ok: true })),
    pushStatus: vi.fn(async () => ({ registered: true }))
  }
  const mounted = mountSfc('src/views/SettingsView.vue', {
    '../services/api': { api },
    '../storage/database': { getSettings: async () => ({ id: 'settings', dailySummaryTime: '08:00', timezone: 'Asia/Shanghai', updatedAt: new Date(0).toISOString() }), saveSettings: vi.fn() },
    '../sync/syncService': { getSyncIssues: async () => [], syncNow: vi.fn() }
  }, {}, ['enablePush', 'pushMessage', 'pushRegistered', 'pushBusy'], { BASE_URL: '/', ...(options.buildPublicKey ? { VITE_VAPID_PUBLIC_KEY: options.buildPublicKey } : {}) })
  cleanups.push(mounted.unmount)
  return { ...mounted, api, subscribe, requestPermission }
}
