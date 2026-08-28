import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { config } from './config.js'

export interface EncryptedSecret {
  version: 1
  algorithm: 'aes-256-gcm'
  ciphertext: string
  iv: string
  authTag: string
  lastFour: string
  createdAt: string
  updatedAt: string
}

function encryptionKey() {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(config.JWT_SECRET, 'utf8'),
    Buffer.from('ai-todo-pwa', 'utf8'),
    Buffer.from('single-user-deepseek-api-key:v1', 'utf8'),
    32
  ))
}

const aad = () => Buffer.from('ai-todo:single-user:deepseek', 'utf8')

export function validateDeepseekApiKey(value: unknown) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!/^sk-[A-Za-z0-9_-]{16,252}$/.test(key)) {
    const error = new Error('DeepSeek API Key 格式不正确，应以 sk- 开头')
    ;(error as Error & { status: number }).status = 400
    throw error
  }
  return key
}

export function encryptDeepseekApiKey(apiKey: string, existingCreatedAt?: string): EncryptedSecret {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(aad())
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const now = new Date().toISOString()
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    lastFour: apiKey.slice(-4),
    createdAt: existingCreatedAt ?? now,
    updatedAt: now
  }
}

export function decryptDeepseekApiKey(secret: EncryptedSecret) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(secret.iv, 'base64'))
    decipher.setAAD(aad())
    decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    const error = new Error('已保存的 DeepSeek API Key 无法解密，请删除后重新配置')
    ;(error as Error & { status: number }).status = 409
    throw error
  }
}

export const maskedDeepseekKey = (secret: EncryptedSecret) => `sk-••••${secret.lastFour}`
