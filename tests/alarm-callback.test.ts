// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { deliverReminder, persistentSteps } from '../server/reminders/callback'
import { ErrorDoNotRetry, ErrorRetryAfterDelay } from '../server/reminders/workflow'

const handlers = vi.hoisted(() => ({ todo: vi.fn(), daily: vi.fn(), registerDaily: vi.fn() }))
vi.mock('../netlify/functions/todo-reminder', () => ({ handleTodoReminder: handlers.todo }))
vi.mock('../netlify/functions/daily-summary', () => ({ handleDailySummary: handlers.daily }))
vi.mock('../server/reminders/dailySummaryScheduler', () => ({ registerUnboundDailySummaryEvent: handlers.registerDaily }))
const secret = 'synthetic-secret-that-is-longer-than-thirty-two'
const token = 'synthetic-delivery-token-1234'
const fetchMock = vi.fn()
const payload = () => ({ eventId: 'cf:event-1', eventName: 'todo.reminder', eventData: { todoId: 'todo-1', reminderId: 'r1', expectedAt: '2026-10-25T01:00:00.000Z', expectedUpdatedAt: '2026-10-25T00:00:00.000Z' }, attempt: 0, deliveryToken: token })
async function invoke(body: unknown = payload(), authorization: string | undefined = `Bearer ${secret}`) {
  let status = 200, result: unknown
  const response = { setHeader: vi.fn(), status(code: number) { status = code; return this }, json(value: unknown) { result = value; return this } }
  await deliverReminder({ body, get: () => authorization } as unknown as Request, response as unknown as Response)
  return { status, body: result }
}

describe('authenticated Alarm callback and durable steps', () => {
  beforeEach(() => {
    handlers.todo.mockReset().mockResolvedValue(undefined); handlers.daily.mockReset().mockResolvedValue(undefined)
    handlers.registerDaily.mockReset().mockResolvedValue(true)
    fetchMock.mockReset().mockImplementation(async () => Response.json({ found: false })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('Netlify', undefined)
    vi.stubEnv('REMINDER_SCHEDULER_URL', 'https://reminders.example.test'); vi.stubEnv('REMINDER_SCHEDULER_SECRET', secret)
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('rejects missing or incorrect service credentials before executing anything', async () => {
    expect((await invoke(payload(), '')).status).toBe(401)
    expect((await invoke(payload(), 'Bearer wrong')).status).toBe(401)
    expect(handlers.todo).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the first attempt numbered zero and validated self-registration metadata', async () => {
    expect((await invoke()).status).toBe(200)
    expect(handlers.todo).toHaveBeenCalledWith(expect.objectContaining(payload()))
    const changed = { ...payload(), eventData: { ...payload().eventData, callbackUrl: 'https://untrusted.example.test' } }
    expect((await invoke(changed)).status).toBe(400)
    expect(handlers.todo).toHaveBeenCalledOnce()
  })

  it('only exposes bounded retry metadata, never upstream error details', async () => {
    handlers.todo.mockRejectedValueOnce(new ErrorRetryAfterDelay({ message: secret, retryDelay: '1m' }))
    expect(await invoke()).toEqual({ status: 503, body: { error: '提醒执行暂未完成', retryAfterMs: 60_000 } })
    handlers.todo.mockRejectedValueOnce(new Error(secret))
    expect(await invoke()).toEqual({ status: 503, body: { error: '提醒执行暂未完成' } })
    handlers.todo.mockRejectedValueOnce(new ErrorDoNotRetry(secret))
    expect(await invoke()).toEqual({ status: 200, body: { ok: true, skipped: true } })
  })

  it('recovers the daily pointer before running its current-event check', async () => {
    const eventData = { scheduledFor: '2026-10-25T01:00:00.000Z', dailySummaryTime: '09:00', timezone: 'Asia/Shanghai', settingsUpdatedAt: null, previousEventId: null }
    handlers.daily.mockImplementation(async () => expect(handlers.registerDaily).toHaveBeenCalledWith('cf:event-1', eventData))
    expect((await invoke({ ...payload(), eventName: 'daily.summary', eventData })).status).toBe(200)
    expect(handlers.daily).toHaveBeenCalledOnce()
    handlers.registerDaily.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await invoke({ ...payload(), eventName: 'daily.summary', eventData })).status).toBe(503)
    expect(handlers.daily).toHaveBeenCalledOnce()
  })

  it('retries a failed state write without repeating an already persisted successful Push', async () => {
    const cache = new Map<string, unknown>()
    fetchMock.mockImplementation(async (url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get('X-Reminder-Delivery-Token')).toBe(token)
      const key = url.pathname
      if (init.method === 'PUT' && !cache.has(key)) cache.set(key, JSON.parse(String(init.body)).value)
      return Response.json(cache.has(key) ? { found: true, value: cache.get(key) } : { found: false })
    })
    const push = vi.fn().mockResolvedValue({ sent: 1 }), mark = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(true)
    handlers.todo.mockImplementation(async event => {
      await event.step.run('send-push:event-1', push)
      await event.step.run('mark:event-1', mark)
    })
    expect((await invoke()).status).toBe(503)
    expect((await invoke({ ...payload(), attempt: 1 })).status).toBe(200)
    expect(push).toHaveBeenCalledOnce(); expect(mark).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(2)
  })

  it.each([404, 409])('an expired or cancelled delivery (%s) cannot run another step', async status => {
    fetchMock.mockResolvedValue(new Response('', { status }))
    const work = vi.fn()
    await expect(persistentSteps('cf:event-1', token).run('push', work)).rejects.toBeInstanceOf(ErrorDoNotRetry)
    expect(work).not.toHaveBeenCalled()
  })

  it.each([404, 409])('a cancelled or expired callback (%s) cannot bind an event or invoke a handler', async status => {
    fetchMock.mockImplementation(async () => new Response('', { status }))
    const eventData = { scheduledFor: '2026-10-25T01:00:00.000Z', dailySummaryTime: '09:00', timezone: 'Asia/Shanghai', settingsUpdatedAt: null, previousEventId: null }
    expect(await invoke({ ...payload(), eventName: 'daily.summary', eventData })).toEqual({ status: 200, body: { ok: true, skipped: true } })
    expect(await invoke()).toEqual({ status: 200, body: { ok: true, skipped: true } })
    expect(handlers.registerDaily).not.toHaveBeenCalled()
    expect(handlers.daily).not.toHaveBeenCalled()
    expect(handlers.todo).not.toHaveBeenCalled()
  })

  it('never caches a failed callback result', async () => {
    fetchMock.mockResolvedValue(Response.json({ found: false }))
    await expect(persistentSteps('cf:event-1', token).run('push', () => { throw new Error('push unavailable') })).rejects.toThrow('push unavailable')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
  })
})
