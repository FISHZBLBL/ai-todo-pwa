// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { ReminderAlarm, type Env } from '../src/index'

const secret = 'test-only-scheduler-secret-at-least-32-bytes'
const databases: DatabaseSync[] = []
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { for (const database of databases.splice(0)) database.close(); vi.unstubAllGlobals() })

function instance() {
  const database = new DatabaseSync(':memory:'); databases.push(database)
  let alarm: number | null = null, wakes = 0
  const storage = {
    sql: {
      exec<T>(query: string, ...bindings: (string | number | null)[]) {
        let rows: T[] = []
        if (/^\s*(CREATE|INSERT|UPDATE|DELETE)/i.test(query)) {
          if (bindings.length) database.prepare(query).run(...bindings)
          else database.exec(query)
        } else rows = database.prepare(query).all(...bindings) as T[]
        return { toArray: () => rows }
      },
    },
    async transaction<T>(action: () => T | Promise<T>): Promise<T> {
      database.exec('BEGIN')
      const previous = alarm
      try { const result = await action(); database.exec('COMMIT'); return result }
      catch (error) { database.exec('ROLLBACK'); alarm = previous; throw error }
    },
    async setAlarm(at: number) { alarm = at },
    async deleteAlarm() { alarm = null },
  }
  const env: Env = {
    REMINDER_SCHEDULER_SECRET: secret,
    REMINDER_CALLBACK_URL: 'https://ai-todo-pwa.netlify.app/api/reminders/deliver',
    REMINDER_ALARM: { idFromName: () => { wakes++; return 'single-user' }, get: () => object },
  }
  const object = new ReminderAlarm({ storage }, env)
  const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => new Request(`https://scheduler.example${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  })
  const event = (id = 'old-event') => ({ eventId: id, eventName: 'todo.reminder', data: { todoId: 'todo-1' }, delayUntil: Date.now() - 1 })
  return { env, object, request, event, alarm: () => alarm, wakes: () => wakes }
}

describe('Cloudflare Alarm HTTP boundary and SQLite persistence', () => {
  it('rejects unauthenticated requests before waking the Durable Object', async () => {
    const h = instance()
    expect((await worker.fetch(new Request('https://scheduler.example/status'), h.env)).status).toBe(401)
    expect((await worker.fetch(h.request('/status', 'GET', undefined, { Authorization: 'Bearer wrong' }), h.env)).status).toBe(401)
    expect(h.wakes()).toBe(0)
    expect(await (await worker.fetch(new Request('https://scheduler.example/health'), h.env)).json()).toEqual({ ready: true })
    expect(h.wakes()).toBe(0)
    expect((await worker.fetch(h.request('/status'), h.env)).status).toBe(200)
    expect(h.wakes()).toBe(1)
  })

  it('rejects missing secrets and non-HTTPS or unexpected callback destinations', async () => {
    const h = instance()
    for (const callback of ['http://example.com/api/reminders/deliver', 'https://example.com/other', 'https://user:pass@example.com/api/reminders/deliver', 'https://example.com/api/reminders/deliver?key=secret']) {
      expect((await worker.fetch(h.request('/health'), { ...h.env, REMINDER_CALLBACK_URL: callback })).status).toBe(503)
    }
    expect((await worker.fetch(h.request('/status'), { ...h.env, REMINDER_SCHEDULER_SECRET: '' })).status).toBe(503)
    expect(h.wakes()).toBe(0)
  })

  it('persists idempotent jobs and atomic imports using the actual SQL queries', async () => {
    const h = instance(), event = h.event()
    expect((await h.object.fetch(h.request('/events', 'POST', event))).status).toBe(200)
    expect((await h.object.fetch(h.request('/events', 'POST', event))).status).toBe(200)
    expect((await h.object.fetch(h.request('/events/import', 'POST', { events: [h.event('new'), { ...event, data: { different: true } }] }))).status).toBe(409)
    expect(await (await h.object.fetch(h.request('/status'))).json()).toMatchObject({ active: 1, dead: 0 })
    await h.object.fetch(h.request('/events', 'DELETE', { eventIds: ['old-event', 'not-registered-yet'] }))
    expect(h.alarm()).toBeNull()
    expect(await (await h.object.fetch(h.request('/events', 'POST', h.event('not-registered-yet')))).json()).toMatchObject({ events: [{ eventId: 'not-registered-yet', status: 'cancelled' }] })
  })

  it('supports callback reentry for persistent steps without holding a transaction over fetch', async () => {
    const h = instance(), event = h.event()
    const fetchCallback = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe(h.env.REMINDER_CALLBACK_URL)
      expect(init?.redirect).toBe('manual')
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${secret}`)
      const delivery = JSON.parse(String(init?.body)) as { deliveryToken: string; eventId: string }
      const stepPath = `/events/${delivery.eventId}/steps/${encodeURIComponent('send-push:1')}`
      const headers = { 'X-Reminder-Delivery-Token': delivery.deliveryToken }
      expect(await (await h.object.fetch(h.request(stepPath, 'GET', undefined, headers))).json()).toEqual({ found: false })
      expect(await (await h.object.fetch(h.request(stepPath, 'PUT', { value: { sent: 1 } }, headers))).json()).toEqual({ found: true, value: { sent: 1 } })
      expect(await (await h.object.fetch(h.request(stepPath, 'PUT', { value: { sent: 9 } }, headers))).json()).toEqual({ found: true, value: { sent: 1 } })
      expect(await (await h.object.fetch(h.request(stepPath, 'GET', undefined, headers))).json()).toEqual({ found: true, value: { sent: 1 } })
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchCallback)
    await h.object.fetch(h.request('/events', 'POST', event))
    await h.object.alarm()
    expect(fetchCallback).toHaveBeenCalledOnce()
    expect(await (await h.object.fetch(h.request('/status'))).json()).toEqual({ active: 0, dead: 0, completed: 1, cancelled: 0, nextAlarm: null })
    expect(h.alarm()).toBeNull()
    expect((await h.object.fetch(h.request('/events/old-event/steps/send', 'PUT', { value: true }, { 'X-Reminder-Delivery-Token': 'old' }))).status).toBe(409)
  })

  it('validates malformed request bodies without disclosing storage errors', async () => {
    const h = instance()
    expect((await h.object.fetch(h.request('/events', 'DELETE', { eventIds: [null] }))).status).toBe(400)
    expect((await h.object.fetch(h.request('/events/import', 'POST', { events: null }))).status).toBe(400)
    expect((await h.object.fetch(h.request('/events', 'POST', { ...h.event(), data: { huge: 'x'.repeat(33_000) } }))).status).toBe(413)
    expect((await h.object.fetch(new Request('https://scheduler.example/events', { method: 'POST', body: '{broken', headers: { Authorization: `Bearer ${secret}` } }))).status).toBe(400)
    expect((await h.object.fetch(h.request('/events/%/steps/a'))).status).toBe(400)
  })
})
