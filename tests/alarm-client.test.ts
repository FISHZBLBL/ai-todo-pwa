// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alarmConfiguration, alarmRequest, createAlarmEventSender, importAlarmEvents, type AlarmEvent } from '../server/reminders/alarmClient'

const secret = 'synthetic-shared-scheduler-secret-at-least-32-bytes'
const fetchMock = vi.fn()
const eventOptions = () => ({ data: { todoId: 'todo-1', reminderId: 'r1' }, delayUntil: Date.now() + 60_000 })
const migrationEvents = (length: number): AlarmEvent[] => Array.from({ length }, (_, index) => ({ eventId: `old-${index}`, eventName: 'todo.reminder', data: { todoId: `todo-${index}` }, delayUntil: Date.now() + 60_000 }))

describe('Cloudflare Alarm 客户端', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', undefined)
    vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.test')
    vi.stubEnv('REMINDER_SCHEDULER_SECRET', secret)
    fetchMock.mockReset().mockImplementation(async (_url: URL, request: RequestInit) => {
      const value = JSON.parse(String(request.body))
      if (request.method === 'DELETE') return Response.json({ cancelled: value.eventIds.length })
      if (value.events) return Response.json({ events: value.events.map((event: AlarmEvent) => ({ eventId: event.eventId, status: 'scheduled' })) })
      return Response.json({ events: [{ eventId: value.eventId, status: 'scheduled' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('支持 HTTPS 和本地 HTTP，运行时环境优先于进程环境', () => {
    expect(alarmConfiguration()?.url.toString()).toBe('https://reminders.example.test/')
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      vi.stubEnv('REMINDER_SCHEDULER_URL', url)
      expect(alarmConfiguration()?.url.origin).toBe(url)
    }
    const runtime: Record<string, string> = { REMINDER_SCHEDULER_URL: 'https://runtime.example.test', REMINDER_SCHEDULER_SECRET: `${secret}-runtime` }
    vi.stubGlobal('Netlify', { env: { get: (name: string) => runtime[name] } })
    expect(alarmConfiguration()?.url.origin).toBe('https://runtime.example.test')
    expect(alarmConfiguration()?.secret).toBe(`${secret}-runtime`)
  })

  it('拒绝缺失配置、外部 HTTP、URL 凭据及非法 secret，且不发送请求', async () => {
    for (const url of [undefined, '', 'not-a-url', 'http://external.example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?secret=private', 'https://example.test/#secret']) {
      vi.stubEnv('REMINDER_SCHEDULER_URL', url)
      expect(alarmConfiguration()).toBeNull()
      await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow('尚未配置 Cloudflare 提醒定时服务')
    }
    vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.test')
    for (const value of [undefined, '', 'short', `${secret} whitespace`]) {
      vi.stubEnv('REMINDER_SCHEDULER_SECRET', value)
      expect(alarmConfiguration()).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST 只将共享 secret 放在认证头，并等待匹配的 durable ACK', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const options = eventOptions()
    const result = await createAlarmEventSender().send('todo.reminder', options)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('https://reminders.example.test/events')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } })
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(timeout).toHaveBeenCalledWith(10_000)
    expect(JSON.parse(request.body)).toEqual({ eventId: result.eventId, eventName: 'todo.reminder', ...options })
    expect(request.body).not.toContain(secret)
    expect(url.toString()).not.toContain(secret)
  })

  it('取消重复 ID 去重后每 100 条一批，空取消不请求', async () => {
    const sender = createAlarmEventSender()
    await sender.send('awl:delete-events', { data: { eventIds: [] } })
    expect(fetchMock).not.toHaveBeenCalled()
    const ids = Array.from({ length: 201 }, (_, index) => `old-${index}`)
    await sender.send('awl:delete-events', { data: { eventIds: [...ids, 'old-0'] } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([url, request]) => ({ path: url.pathname, method: request.method, ids: JSON.parse(request.body).eventIds }))).toEqual([
      { path: '/events', method: 'DELETE', ids: ids.slice(0, 100) },
      { path: '/events', method: 'DELETE', ids: ids.slice(100, 200) },
      { path: '/events', method: 'DELETE', ids: ids.slice(200) },
    ])
  })

  it('不接受无效事件、时间和取消参数', async () => {
    const sender = createAlarmEventSender()
    for (const delayUntil of [undefined, NaN, Infinity, -1, 1.1, '1 day', 8_640_000_000_000_001]) await expect(sender.send('todo.reminder', { delayUntil })).rejects.toThrow('提醒时间无效')
    await expect(sender.send('unknown', eventOptions())).rejects.toThrow('不支持的提醒事件')
    for (const data of [undefined, {}, { eventIds: null }, { eventIds: [1] }]) await expect(sender.send('awl:delete-events', { data })).rejects.toThrow('取消提醒参数无效')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 错误和重定向不会被误认为已登记，也不泄漏服务端正文', async () => {
    for (const status of [401, 403, 500, 302]) {
      fetchMock.mockResolvedValueOnce(new Response(`private ${secret}`, { status }))
      await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow(/^提醒定时服务请求失败$/)
    }
    fetchMock.mockResolvedValueOnce({ ok: true, redirected: true, status: 200, body: { cancel: vi.fn() } })
    await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow(/^提醒定时服务请求失败$/)
  })

  it('网络超时、响应流失败和非 JSON ACK 均不会成功或泄漏 secret', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`timeout Authorization: Bearer ${secret}`))
    await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow(/^无法连接提醒定时服务，请稍后重试$/)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error(`private stream ${secret}`) } })
    await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow(/^无法连接提醒定时服务，请稍后重试$/)
    fetchMock.mockResolvedValueOnce(new Response('ack'))
    await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow(/^无法连接提醒定时服务，请稍后重试$/)
  })

  it('发送成功前必须消费完整 JSON ACK', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    fetchMock.mockImplementationOnce(async (_url: URL, request: RequestInit) => ({
      ok: true,
      async json() { await pending; return { events: [{ eventId: JSON.parse(String(request.body)).eventId, status: 'scheduled' }] } },
    }))
    let done = false
    const sending = createAlarmEventSender().send('daily.summary', eventOptions()).then(value => { done = true; return value })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await expect(sending).resolves.toMatchObject({ sendStatus: 'succeeded' })
  })

  it('登记 ACK 必须匹配当前 ID 和可执行状态', async () => {
    for (const status of ['cancelled', 'dead', 'completed', 'unknown']) {
      fetchMock.mockImplementationOnce(async (_url: URL, request: RequestInit) => Response.json({ events: [{ eventId: JSON.parse(String(request.body)).eventId, status }] }))
      await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow('提醒未成功登记')
    }
    for (const value of [{ events: [] }, { events: [{ eventId: 'other', status: 'scheduled' }] }, {}]) {
      fetchMock.mockResolvedValueOnce(Response.json(value))
      await expect(createAlarmEventSender().send('todo.reminder', eventOptions())).rejects.toThrow('提醒未成功登记')
    }
  })

  it('迁移按 100 条分批，保留旧 ID，重复导入仍可确认', async () => {
    const events = migrationEvents(201)
    await importAlarmEvents([])
    expect(fetchMock).not.toHaveBeenCalled()
    await importAlarmEvents(events)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([url, request]) => ({ path: url.pathname, events: JSON.parse(request.body).events }))).toEqual([
      { path: '/events/import', events: events.slice(0, 100) },
      { path: '/events/import', events: events.slice(100, 200) },
      { path: '/events/import', events: events.slice(200) },
    ])
    await expect(importAlarmEvents(events)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('迁移 ACK 少条目、错误 ID 或 dead/cancelled 状态不能被当作完成', async () => {
    const events = migrationEvents(1)
    for (const value of [{ events: [] }, { events: [{ eventId: 'different', status: 'scheduled' }] }, { events: [{ eventId: 'old-0', status: 'dead' }] }, { events: [{ eventId: 'old-0', status: 'cancelled' }] }]) {
      fetchMock.mockResolvedValueOnce(Response.json(value))
      await expect(importAlarmEvents(events)).rejects.toThrow('旧提醒迁移未完整确认')
    }
  })

  it('step 请求保留 delivery token 认证头，路径和正文不包含共享 secret', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ found: true, value: { sent: 1 } }))
    await expect(alarmRequest('/events/cf%3Aevent/steps/send%3Apush', 'PUT', { value: { sent: 1 } }, 'delivery-token')).resolves.toEqual({ found: true, value: { sent: 1 } })
    const [url, request] = fetchMock.mock.calls[0]
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${secret}`, 'X-Reminder-Delivery-Token': 'delivery-token' })
    expect(url.toString()).not.toContain(secret)
    expect(request.body).not.toContain(secret)
  })
})
