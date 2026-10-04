import type { Request } from 'express'
import { isIP } from 'node:net'
import { ipKeyGenerator } from 'express-rate-limit'

/**
 * Netlify's Lambda adapter does not always populate Express's `request.ip`.
 * Read the platform-provided context or direct peer. Forwarding headers are
 * user controlled on a direct server and must not bypass authentication limits.
 */
export function rateLimitKey(request: Request): string {
  const platform = (globalThis as typeof globalThis & { Netlify?: { context?: { ip?: string } } }).Netlify?.context?.ip
  const peer = request.socket?.remoteAddress
  const ip = [platform, peer, request.ip].find(value => typeof value === 'string' && isIP(value))
  return ip ? ipKeyGenerator(ip) : 'netlify-unknown-client'
}
