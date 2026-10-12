import { createECDH, ECDH, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

export type WebPushConfigReason = 'missing_public_key' | 'missing_private_key' | 'invalid_keys' | 'key_mismatch'
export interface WebPushConfig { configured: boolean; publicKey: string | null; reason: WebPushConfigReason | null }

function decodeKey(value: string) {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(value)) throw new Error('invalid encoding')
  const normalized = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const decoded = Buffer.from(normalized, 'base64url')
  if (decoded.toString('base64url') !== normalized) throw new Error('invalid encoding')
  return decoded
}

export function getWebPushConfig(publicKey = config.VAPID_PUBLIC_KEY, privateKey = config.VAPID_PRIVATE_KEY): WebPushConfig {
  const publicValue = publicKey?.trim(), privateValue = privateKey?.trim()
  const unavailable = (reason: WebPushConfigReason): WebPushConfig => ({ configured: false, publicKey: null, reason })
  if (!publicValue) return unavailable('missing_public_key')
  if (!privateValue) return unavailable('missing_private_key')
  try {
    const publicBytes = decodeKey(publicValue), privateBytes = decodeKey(privateValue)
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) return unavailable('invalid_keys')
    // Validate the public point as well as the private scalar before comparing.
    ECDH.convertKey(publicBytes, 'prime256v1')
    const curve = createECDH('prime256v1')
    curve.setPrivateKey(privateBytes)
    if (!timingSafeEqual(publicBytes, curve.getPublicKey())) return unavailable('key_mismatch')
    return { configured: true, publicKey: publicBytes.toString('base64url'), reason: null }
  } catch {
    return unavailable('invalid_keys')
  }
}
