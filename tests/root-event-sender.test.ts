// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootEventSender } from '../server/reminders/rootEventSender'
import { createAlarmEventSender } from '../server/reminders/alarmClient'

const fetchMock = vi.fn()
const secret = 'synthetic-shared-scheduler-secret-at-least-32-bytes'

describe('后续提醒使用 Cloudflare Alarm', () => {
  beforeEach(() => {
    vi.stubGlobal('Netlify', undefined)
    vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.test')
    vi.stubEnv('REMINDER_SCHEDULER_SECRET', secret)
    fetchMock.mockReset().mockImplementation(async (_url: URL, request: RequestInit) => {
      const event = JSON.parse(String(request.body))
      return Response.json({ events: [{ eventId: event.eventId, status: 'scheduled' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('后续发送器直接复用 Alarm 客户端，不依赖 SDK 链元数据', async () => {
    expect(createRootEventSender).toBe(createAlarmEventSender)
    const options = { data: { todoId: 'todo-1', reminderId: 'r1' }, delayUntil: Date.now() + 86_400_000 }
    const result = await createRootEventSender().send('todo.reminder', options)
    expect(result).toEqual({ sendStatus: 'succeeded', eventId: expect.stringMatching(/^cf:/) })
    const [url, request] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('https://reminders.example.test/events')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${secret}` } })
    expect(JSON.parse(request.body)).toEqual({ eventId: result.eventId, eventName: 'todo.reminder', ...options })
    expect(request.body).not.toContain('eventChain')
    expect(request.body).not.toContain(secret)
    expect(url.toString()).not.toContain(secret)
  })

  it('无需 Netlify 上下文即可登记一年后的重复提醒', async () => {
    const delayUntil = Date.now() + 500 * 86_400_000
    await createRootEventSender().send('todo.reminder', { data: { todoId: 'later' }, delayUntil })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).delayUntil).toBe(delayUntil)
  })

  it('Cloudflare 配置缺失时立即失败，不回退到 Netlify 轮询', async () => {
    vi.stubEnv('REMINDER_SCHEDULER_URL', undefined)
    await expect(createRootEventSender().send('daily.summary', { delayUntil: Date.now() + 60_000 })).rejects.toThrow('尚未配置 Cloudflare 提醒定时服务')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
