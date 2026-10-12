import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear(); sessionStorage.clear() })

describe('API base URL', () => {
  it('blank example configuration uses the local API proxy', async () => {
    vi.stubEnv('VITE_API_URL', '')
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'test-session' }) })
    vi.stubGlobal('fetch', fetch)
    const { api } = await import('../src/services/api')
    await api.login('test-password')
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/login')
  })
  it('trailing slash in a separate backend URL does not duplicate separators', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com/api/')
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetch)
    const { api } = await import('../src/services/api')
    await api.health()
    expect(fetch.mock.calls[0][0]).toBe('https://api.example.com/api/health')
  })
  it('fetches runtime Push configuration through the authenticated API', async () => {
    vi.stubEnv('VITE_API_URL', '')
    localStorage.setItem('todo-session', 'test-session')
    const config = { configured: true, publicKey: 'test-public-key', reason: null, schedulingAvailable: true }
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => config })
    vi.stubGlobal('fetch', fetch)
    const { api } = await import('../src/services/api')
    expect(await api.getPushConfig()).toEqual(config)
    expect(fetch.mock.calls[0][0]).toBe('/api/push/config')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-session')
  })
})
