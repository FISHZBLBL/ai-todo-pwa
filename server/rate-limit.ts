import type { Request } from 'express'

/**
 * Netlify's Lambda adapter does not always populate Express's `request.ip`.
 * Derive a stable limiter key from its forwarding headers and retain a safe
 * fallback so authentication never fails before reaching the login handler.
 */
export function rateLimitKey(request: Request): string {
  const forwardedFor = request.headers['x-forwarded-for']
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0]?.trim()
  const netlifyIpHeader = request.headers['x-nf-client-connection-ip']
  const netlifyIp = Array.isArray(netlifyIpHeader) ? netlifyIpHeader[0] : netlifyIpHeader
  const fallbackIp = typeof request.ip === 'string' ? request.ip : undefined

  return forwardedIp || netlifyIp || fallbackIp || 'netlify-unknown-client'
}
