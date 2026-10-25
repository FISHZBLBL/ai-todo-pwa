// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootEventSender } from '../server/reminders/rootEventSender'

const fetchMock = vi.fn()
const syntheticKey = 'synthetic-key:raw/format_123'
const options = () => ({ data: { todoId: 'synthetic-todo', reminderId: 'r1' }, delayUntil: Date.now() + 86_400_000 })

describe('独立后续提醒事件传输', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('ack'))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Netlify', { context: { url: 'https://reminders.example.test/.netlify/functions/todo-reminder?private=ignored' }, env: { get: (name: string) => name === 'AWL_API_KEY' ? syntheticKey : undefined } })
    for (const name of Object.keys(process.env).filter(name => name.startsWith('AWL_API_KEY'))) vi.stubEnv(name, undefined)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('仅发送当前站点的认证根事件，不继承链元数据或改写凭据格式', async () => {
    const input = options()
    const result = await createRootEventSender().send('todo.reminder', input)
    expect(result).toEqual({ sendStatus: 'succeeded', eventId: expect.any(String) })
    const [url, request] = fetchMock.mock.calls[0]
    expect(url.origin).toBe('https://reminders.example.test')
    expect(url.pathname).toBe('/.netlify/functions/async-workloads-router')
    expect(url.searchParams.get('events')).toBe('["todo.reminder"]')
    expect(url.toString()).not.toContain(syntheticKey)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${syntheticKey}`, 'Content-Type': 'application/json' } })
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(request.body)).toEqual({ eventName: 'todo.reminder', eventId: result.eventId, ...input })
    expect(request.body).not.toContain('eventChain')
    expect(request.body).not.toContain(syntheticKey)
  })

  it('运行时优先级凭据兼容 SDK 支持的 AWL_API_KEY_Pn 命名', async () => {
    vi.stubGlobal('Netlify', { context: { url: 'https://reminders.example.test' }, env: { get: (name: string) => ({ AWL_API_KEY: syntheticKey, AWL_API_KEY_P0: 'zero', AWL_API_KEY_P3: 'priority-three', AWL_API_KEY_P9: 'priority-nine' })[name], toObject: () => ({ AWL_API_KEY_P3: 'priority-three', AWL_API_KEY_P9: 'priority-nine' }) } })
    await createRootEventSender().send('daily.summary', options())
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer priority-nine')
  })

  it('只允许两类提醒事件，将已到期时间推迟至少 60 秒以保留登记窗口', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await createRootEventSender().send('daily.summary', { delayUntil: now - 1_000 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).delayUntil).toBe(now + 60_000)
    await expect(createRootEventSender().send('awl:delete-events', options())).rejects.toThrow('不支持的后续提醒事件')
    await expect(createRootEventSender().send('unrelated.event', options())).rejects.toThrow('不支持的后续提醒事件')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('缺失或过远的时间不会发送请求', async () => {
    for (const delayUntil of [undefined, NaN, Infinity, '1 day', Date.now() + 366 * 86_400_000]) {
      await expect(createRootEventSender().send('todo.reminder', { delayUntil })).rejects.toThrow('后续提醒时间无效')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 错误、无处理器和重定向不会被当作调度成功', async () => {
    for (const response of [new Response(syntheticKey, { status: 401 }), new Response(syntheticKey, { status: 500 }), new Response('', { headers: { 'x-awl-reason': `no workloads ${syntheticKey}` } }), new Response('', { status: 302, headers: { location: 'https://untrusted.example.test' } })]) {
      fetchMock.mockResolvedValueOnce(response)
      await expect(createRootEventSender().send('todo.reminder', options())).rejects.toThrow(/^创建后续提醒事件失败$/)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('等待 ACK 响应流结束才返回成功，传输超时错误不会泄漏凭据', async () => {
    let close!: () => void
    const consumed = new Promise<void>(resolve => { close = resolve })
    const text = vi.fn(async () => { await consumed; return 'ack' })
    fetchMock.mockResolvedValueOnce({ ok: true, redirected: false, headers: new Headers(), text })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    let done = false
    const sending = createRootEventSender().send('todo.reminder', options()).then(result => { done = true; return result })
    await Promise.resolve()
    await Promise.resolve()
    expect(text).toHaveBeenCalledOnce()
    expect(done).toBe(false)
    expect(timeout).toHaveBeenCalledWith(10_000)
    close()
    await expect(sending).resolves.toMatchObject({ sendStatus: 'succeeded' })
    fetchMock.mockRejectedValueOnce(new Error(`timeout; Authorization: Bearer ${syntheticKey}`))
    await expect(createRootEventSender().send('todo.reminder', options())).rejects.toThrow(/^创建后续提醒事件失败$/)
    fetchMock.mockResolvedValueOnce({ ok: true, headers: new Headers(), text: async () => { throw new Error(`stream timeout ${syntheticKey}`) } })
    await expect(createRootEventSender().send('todo.reminder', options())).rejects.toThrow(/^创建后续提醒事件失败$/)
  })

  it('配置不完整或 URL 含凭据时不发送、不暴露配置值', async () => {
    vi.stubGlobal('Netlify', { context: { url: `https://user:${syntheticKey}@example.test` } })
    await expect(createRootEventSender().send('todo.reminder', options())).rejects.toThrow(/^后续提醒调度配置无效$/)
    vi.stubGlobal('Netlify', { context: { url: 'https://reminders.example.test' } })
    await expect(createRootEventSender().send('todo.reminder', options())).rejects.toThrow(/^后续提醒调度配置无效$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
