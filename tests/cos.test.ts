import { afterEach, describe, expect, it, vi } from 'vitest'
import { CosObjectStore, CosOperationError } from '../server/cos'

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

  it.each([409, 412])('把锁对象 HTTP %s 冲突转换为未获取锁', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
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

  it.each(['object-read', 'object-write', 'object-delete', 'bucket-versioning'] as const)('HTTP 拒绝权限保留 %s 操作和安全错误码，不泄露响应正文', async operation => {
    const sensitive = 'private-object-state secret-test-value AKIDTEST'
    const xml = `<Error><Code>AccessDenied</Code><Message>${sensitive}</Message><Resource>ai-todo/private-object-state.json</Resource></Error>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 403 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    const request = operation === 'object-read' ? storage.getText('ai-todo/private-object-state.json')
      : operation === 'object-write' ? storage.putText('ai-todo/private-object-state.json', sensitive)
        : operation === 'object-delete' ? storage.delete('ai-todo/private-object-state.json')
          : storage.assertSafeLocking()
    const error = await request.catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(CosOperationError)
    expect(error).toMatchObject({ name: 'CosOperationError', operation, httpStatus: 403, serviceCode: 'AccessDenied' })
    if (!(error instanceof CosOperationError)) throw new Error('Expected structured COS failure')
    expect(error.message).toBe('腾讯 COS 请求失败：HTTP 403')
    for (const detail of [xml, '<Error>', 'AccessDenied', 'private-object-state', 'secret-test-value', 'AKIDTEST']) expect(error.message).not.toContain(detail)
  })

  it.each(['', '1AccessDenied', 'Access Denied', 'AccessDenied\nsecret', 'AccessDenied\n', 'AccessDenied\r', 'A'.repeat(81), '<SecretKey>secret-test-value</SecretKey>'])('非法 Code 不作为服务端错误码返回：%s', async code => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<Error><Code>${code}</Code><Message>secret-test-value</Message></Error>`, { status: 403 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.getText('ai-todo/state.json')).rejects.toMatchObject({ operation: 'object-read', httpStatus: 403, serviceCode: null, message: '腾讯 COS 请求失败：HTTP 403' })
  })

  it('对象不存在仍返回 null，不抛出结构化权限错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })))
    const storage = new CosObjectStore('ai-todo-1323797631', 'ap-shanghai', 'AKIDTEST', 'secret-test-value')
    await expect(storage.getText('ai-todo/missing.json')).resolves.toBeNull()
  })
})
