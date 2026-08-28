import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('DeepSeek API Key 服务端加密', () => {
  beforeEach(() => { vi.resetModules(); process.env.JWT_SECRET = 'test-secret-that-is-long-enough' })
  afterEach(() => { delete process.env.JWT_SECRET; vi.resetModules() })

  it('只保存密文并能在服务端还原', async () => {
    const { encryptDeepseekApiKey, decryptDeepseekApiKey, maskedDeepseekKey } = await import('../server/secrets')
    const apiKey = 'sk-1234567890abcdefghijklmnop'
    const encrypted = encryptDeepseekApiKey(apiKey)
    expect(encrypted.ciphertext).not.toContain(apiKey)
    expect(encrypted.algorithm).toBe('aes-256-gcm')
    expect(maskedDeepseekKey(encrypted)).toBe('sk-••••mnop')
    expect(decryptDeepseekApiKey(encrypted)).toBe(apiKey)
  })

  it('拒绝非 DeepSeek Key 格式', async () => {
    const { validateDeepseekApiKey } = await import('../server/secrets')
    expect(() => validateDeepseekApiKey('not-a-key')).toThrow('格式不正确')
  })
})
