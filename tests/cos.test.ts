import { afterEach, describe, expect, it, vi } from 'vitest'
import { CosObjectStore } from '../server/cos'

describe('腾讯 COS 对象存储客户端', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('使用签名请求私有对象且不把 SecretKey 放进请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.getText('ai-todo/state.json')).resolves.toBe('{"ok":true}')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ai-todo-1323797631.cos.ap-shanghai.myqcloud.com/ai-todo/state.json')
    expect((init.headers as Headers).get('Authorization')).toContain('q-ak=AKIDTEST')
    expect((init.headers as Headers).get('Authorization')).not.toContain('secret-test-value')
  })

  it('把锁对象冲突转换为未获取锁', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 409 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.putText('ai-todo/state.json.lock', '{}', { forbidOverwrite: true })).resolves.toBe(false)
  })

  it('查询并签名桶版本配置后才允许使用防覆盖锁', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<VersioningConfiguration/>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.assertSafeLocking()).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-todo-1323797631.cos.ap-shanghai.myqcloud.com/?versioning=')
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toContain('q-url-param-list=versioning')
  })

  it.each(['Enabled', 'Suspended'])('拒绝在%s版本控制桶中使用防覆盖锁', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`, { status: 200 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.assertSafeLocking()).rejects.toThrow('从未开启版本控制')
  })

  it('版本配置查询无权限时停止写入', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<Error>AccessDenied</Error>', { status: 403 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.assertSafeLocking()).rejects.toThrow('403')
  })
})
