import { afterEach, describe, expect, it, vi } from 'vitest'
import { rateLimitKey } from '../server/rate-limit'

describe('Netlify 限流客户端标识', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('在 Lambda 未提供 request.ip 时仍生成稳定的限流键', () => {
    const request = { headers: {}, ip: undefined } as never
    expect(rateLimitKey(request)).toBe('netlify-unknown-client')
  })

  it('忽略伪造转发头，使用真实连接IP', () => {
    const request = { headers: { 'x-forwarded-for': '203.0.113.9', 'x-nf-client-connection-ip': '203.0.113.10' }, ip: '203.0.113.11', socket: { remoteAddress: '192.0.2.1' } } as never
    expect(rateLimitKey(request)).toBe('192.0.2.1')
  })
  it('使用运行时提供的Netlify上下文IP', () => {
    vi.stubGlobal('Netlify', { context: { ip: '203.0.113.9' } })
    expect(rateLimitKey({ headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never)).toBe('203.0.113.9')
  })
  it('IPv6同一子网的不同地址使用同一限流键', () => {
    const key = (ip: string) => rateLimitKey({ headers: {}, socket: { remoteAddress: ip } } as never)
    expect(key('2001:db8:1234:5600::1')).toBe(key('2001:db8:1234:56ff::abcd'))
  })
})
