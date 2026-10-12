import { createECDH } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Synthetic scalar fixtures are deterministic and never used outside tests.
function keyPair(scalar: number) {
  const privateBytes = Buffer.alloc(32)
  privateBytes[31] = scalar
  const curve = createECDH('prime256v1')
  curve.setPrivateKey(privateBytes)
  return { publicKey: curve.getPublicKey().toString('base64url'), privateKey: privateBytes.toString('base64url') }
}

const keys = keyPair(1), otherKeys = keyPair(2)
const read = vi.fn()
function mockConfig(publicKey: string | undefined = keys.publicKey, privateKey: string | undefined = keys.privateKey) {
  vi.doMock('../server/config', () => ({ config: { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: 'mailto:test@example.com', APP_TIMEZONE: 'Asia/Shanghai' } }))
}

describe('Web Push runtime configuration', () => {
  beforeEach(() => { vi.resetModules(); read.mockReset(); mockConfig(); vi.doMock('../server/storage', () => ({ cloudStore: { read } })) })
  afterEach(() => { vi.doUnmock('../server/config'); vi.doUnmock('../server/storage'); vi.resetModules(); vi.restoreAllMocks() })

  it('invalid VAPID keys do not break importing the push module and fail before storage or network access', async () => {
    mockConfig('invalid-public', 'invalid-private')
    const imported = import('../server/push')
    await expect(imported).resolves.toHaveProperty('sendPushPayload')
    const { sendPushPayload } = await imported
    await expect(sendPushPayload({ title: '提醒', body: '内容', url: '/', tag: 'test' })).rejects.toThrow('VAPID 配置无效')
    expect(read).not.toHaveBeenCalled()
  })

  it('returns only a verified public key using the runtime defaults', async () => {
    const { getWebPushConfig } = await import('../server/pushConfig')
    const result = getWebPushConfig()
    expect(result).toEqual({ configured: true, publicKey: keys.publicKey, reason: null })
    expect(Object.keys(result).sort()).toEqual(['configured', 'publicKey', 'reason'])
  })

  it.each([
    ['', keys.privateKey, 'missing_public_key'],
    ['   ', keys.privateKey, 'missing_public_key'],
    [keys.publicKey, '', 'missing_private_key'],
    [keys.publicKey, '   ', 'missing_private_key'],
    ['', '', 'missing_public_key']
  ] as const)('reports missing configuration without exposing a key', async (publicKey, privateKey, reason) => {
    const { getWebPushConfig } = await import('../server/pushConfig')
    expect(getWebPushConfig(publicKey, privateKey)).toEqual({ configured: false, publicKey: null, reason })
  })

  it.each([
    ['not-a-key!', keys.privateKey],
    [keys.publicKey, 'not-a-key!'],
    [Buffer.alloc(64).toString('base64url'), keys.privateKey],
    [keys.publicKey, Buffer.alloc(31).toString('base64url')],
    [Buffer.concat([Buffer.from([2]), Buffer.alloc(64)]).toString('base64url'), keys.privateKey],
    [Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'), keys.privateKey],
    [keys.publicKey, Buffer.alloc(32).toString('base64url')]
  ])('rejects malformed or invalid P-256 key material', async (publicKey, privateKey) => {
    const { getWebPushConfig } = await import('../server/pushConfig')
    expect(getWebPushConfig(publicKey, privateKey)).toEqual({ configured: false, publicKey: null, reason: 'invalid_keys' })
  })

  it('rejects valid public/private keys from different pairs', async () => {
    const { getWebPushConfig } = await import('../server/pushConfig')
    expect(getWebPushConfig(keys.publicKey, otherKeys.privateKey)).toEqual({ configured: false, publicKey: null, reason: 'key_mismatch' })
  })

  it('normalizes copied whitespace and standard base64 into the public base64url form', async () => {
    const { getWebPushConfig } = await import('../server/pushConfig')
    const publicKey = Buffer.from(keys.publicKey, 'base64url').toString('base64')
    const privateKey = Buffer.from(keys.privateKey, 'base64url').toString('base64')
    expect(getWebPushConfig(` ${publicKey}\n`, ` ${privateKey}\n`)).toEqual({ configured: true, publicKey: keys.publicKey, reason: null })
  })

  it('reports absent runtime defaults as missing configuration', async () => {
    vi.doMock('../server/config', () => ({ config: {} }))
    const { getWebPushConfig } = await import('../server/pushConfig')
    expect(getWebPushConfig()).toEqual({ configured: false, publicKey: null, reason: 'missing_public_key' })
  })

  it('accepts copied standard-base64 runtime keys when initializing web-push', async () => {
    mockConfig(Buffer.from(keys.publicKey, 'base64url').toString('base64'), Buffer.from(keys.privateKey, 'base64url').toString('base64'))
    await expect(import('../server/push')).resolves.toHaveProperty('sendPushPayload')
  })

  it('refuses to send using a mismatched runtime pair before reading subscriptions', async () => {
    mockConfig(keys.publicKey, otherKeys.privateKey)
    const { sendPushPayload } = await import('../server/push')
    await expect(sendPushPayload({ title: '提醒', body: '内容', url: '/', tag: 'test' })).rejects.toThrow('VAPID 公私钥不匹配')
    expect(read).not.toHaveBeenCalled()
  })
})
