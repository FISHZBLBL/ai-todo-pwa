import { describe, expect, it } from 'vitest'
import { rateLimitKey } from '../server/rate-limit'

describe('Netlify 限流客户端标识', () => {
  it('在 Lambda 未提供 request.ip 时仍生成稳定的限流键', () => {
    const request = { headers: {}, ip: undefined } as never
    expect(rateLimitKey(request)).toBe('netlify-unknown-client')
  })

  it('优先使用 Netlify 转发的客户端 IP', () => {
    const request = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, ip: undefined } as never
    expect(rateLimitKey(request)).toBe('203.0.113.9')
  })
})
