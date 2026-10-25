import { AlarmQueue, MAX_BATCH, QueueError, type QueueStore, type QueueTransaction, type StoredEvent } from './queue'

interface SqlCursor<T> { toArray(): T[] }
interface SqlStorage { exec<T = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): SqlCursor<T> }
interface AlarmStorage {
  sql: SqlStorage
  transaction<T>(closure: () => T | Promise<T>): Promise<T>
  setAlarm(timestamp: number): Promise<void>
  deleteAlarm(): Promise<void>
}
interface ObjectState { storage: AlarmStorage }
interface ObjectStub { fetch(request: Request): Promise<Response> }
interface ObjectNamespace { idFromName(name: string): unknown; get(id: unknown): ObjectStub }

export interface Env {
  REMINDER_ALARM: ObjectNamespace
  REMINDER_SCHEDULER_SECRET: string
  REMINDER_CALLBACK_URL: string
}

class SqlQueueStore implements QueueStore {
  constructor(private readonly storage: AlarmStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS reminder_events (
      id TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      wake_at REAL
    );
    CREATE INDEX IF NOT EXISTS reminder_wake_at ON reminder_events(wake_at) WHERE wake_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS reminder_steps (
      event_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY(event_id, step_key)
    );`)
  }

  transaction<T>(action: (tx: QueueTransaction) => T | Promise<T>): Promise<T> {
    const sql = this.storage.sql
    return this.storage.transaction(() => action({
      get: eventId => {
        const row = sql.exec<{ event_json: string }>('SELECT event_json FROM reminder_events WHERE id = ?', eventId).toArray()[0]
        return row ? JSON.parse(row.event_json) as StoredEvent : undefined
      },
      put: event => { sql.exec('INSERT INTO reminder_events(id,event_json,wake_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET event_json=excluded.event_json,wake_at=excluded.wake_at', event.eventId, JSON.stringify(event), event.wakeAt) },
      nextDue: now => {
        const row = sql.exec<{ event_json: string }>('SELECT event_json FROM reminder_events WHERE wake_at <= ? ORDER BY wake_at,id LIMIT 1', now).toArray()[0]
        return row ? JSON.parse(row.event_json) as StoredEvent : undefined
      },
      nextWakeAt: () => sql.exec<{ wake_at: number }>('SELECT wake_at FROM reminder_events WHERE wake_at IS NOT NULL ORDER BY wake_at LIMIT 1').toArray()[0]?.wake_at ?? null,
      getSteps: eventId => {
        const steps: Record<string, unknown> = Object.create(null)
        for (const row of sql.exec<{ step_key: string; value_json: string }>('SELECT step_key,value_json FROM reminder_steps WHERE event_id = ?', eventId).toArray()) steps[row.step_key] = JSON.parse(row.value_json)
        return steps
      },
      putStep: (eventId, key, value) => { sql.exec('INSERT OR IGNORE INTO reminder_steps(event_id,step_key,value_json) VALUES(?,?,?)', eventId, key, JSON.stringify(value)) },
      counts: () => {
        const result = { active: 0, dead: 0, completed: 0, cancelled: 0 }
        for (const row of sql.exec<{ status: string; count: number }>("SELECT json_extract(event_json,'$.status') AS status,COUNT(*) AS count FROM reminder_events GROUP BY status").toArray()) {
          if (row.status === 'running' || row.status === 'scheduled') result.active += row.count
          else if (row.status === 'dead' || row.status === 'completed' || row.status === 'cancelled') result[row.status] = row.count
        }
        return result
      },
      setAlarm: at => at === null ? this.storage.deleteAlarm() : this.storage.setAlarm(at),
    }))
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

function configured(env: Env): boolean {
  if (typeof env.REMINDER_SCHEDULER_SECRET !== 'string' || env.REMINDER_SCHEDULER_SECRET.length < 32) return false
  try {
    const callback = new URL(env.REMINDER_CALLBACK_URL)
    return callback.protocol === 'https:' && callback.pathname === '/api/reminders/deliver' && !callback.username && !callback.password && !callback.search && !callback.hash
  } catch { return false }
}

async function authenticated(request: Request, env: Env): Promise<boolean> {
  const value = request.headers.get('Authorization')
  if (!value || !value.startsWith('Bearer ')) return false
  // Compare fixed length digests rather than returning at the first differing character.
  const encoder = new TextEncoder()
  const [actual, expected] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(value.slice(7))), crypto.subtle.digest('SHA-256', encoder.encode(env.REMINDER_SCHEDULER_SECRET))])
  const left = new Uint8Array(actual), right = new Uint8Array(expected)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

async function body(request: Request): Promise<unknown> {
  const limit = 1_048_576
  if (Number(request.headers.get('Content-Length')) > limit) throw new QueueError(413, 'Request body is too large')
  if (!request.body) throw new QueueError(400, 'JSON body required')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new QueueError(413, 'Request body is too large') }
      chunks.push(value)
    }
    const buffer = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(buffer))
  } catch (error) {
    if (error instanceof QueueError) throw error
    throw new QueueError(400, 'Invalid JSON body')
  }
}

export class ReminderAlarm {
  private readonly queue: AlarmQueue

  constructor(state: ObjectState, private readonly env: Env) {
    this.queue = new AlarmQueue(new SqlQueueStore(state.storage), async event => {
      const response = await fetch(this.env.REMINDER_CALLBACK_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.REMINDER_SCHEDULER_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(70_000),
        redirect: 'manual',
      })
      let retryAfterMs: number | undefined
      if (response.status === 429 || response.status >= 500) {
        try {
          const value = await response.json() as { retryAfterMs?: unknown }
          if (typeof value.retryAfterMs === 'number') retryAfterMs = value.retryAfterMs
        } catch { /* Use bounded exponential backoff for malformed error bodies. */ }
      } else await response.body?.cancel()
      return { status: response.status, retryAfterMs }
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (!configured(this.env)) return json({ error: 'Scheduler is not configured' }, 503)
    if (!await authenticated(request, this.env)) return json({ error: 'Unauthorized' }, 401)
    try {
      const path = new URL(request.url).pathname
      if (path === '/status' && request.method === 'GET') return json(await this.queue.status())
      if (path === '/events' && request.method === 'POST') return json({ events: await this.queue.add([await body(request)]) })
      if (path === '/events/import' && request.method === 'POST') {
        const value = await body(request) as { events?: unknown }
        if (!value || !Array.isArray(value.events)) throw new QueueError(400, 'Expected events array')
        return json({ events: await this.queue.add(value.events) })
      }
      if (path === '/events' && request.method === 'DELETE') {
        const value = await body(request) as { eventIds?: unknown }
        if (!value || !Array.isArray(value.eventIds) || value.eventIds.length > MAX_BATCH || value.eventIds.some(id => typeof id !== 'string')) throw new QueueError(400, 'Expected eventIds array')
        await this.queue.cancel(value.eventIds)
        return json({ cancelled: value.eventIds.length })
      }
      const stepPath = /^\/events\/([^/]+)\/steps\/([^/]+)$/.exec(path)
      if (stepPath && (request.method === 'GET' || request.method === 'PUT')) {
        const eventId = decodeURIComponent(stepPath[1]), key = decodeURIComponent(stepPath[2])
        const token = request.headers.get('X-Reminder-Delivery-Token') ?? ''
        if (request.method === 'GET') return json(await this.queue.getStep(eventId, key, token))
        const value = await body(request)
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'value')) throw new QueueError(400, 'Step value required')
        return json(await this.queue.putStep(eventId, key, (value as { value: unknown }).value, token))
      }
      return json({ error: 'Not found' }, 404)
    } catch (error) {
      if (error instanceof QueueError) return json({ error: error.message }, error.status)
      if (error instanceof URIError) return json({ error: 'Invalid path encoding' }, 400)
      // Do not return callback responses, event data or storage exceptions to API callers.
      return json({ error: 'Scheduler storage error' }, 503)
    }
  }

  async alarm(): Promise<void> {
    await this.queue.runDue()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/health' && request.method === 'GET') return json({ ready: configured(env) }, configured(env) ? 200 : 503)
    if (!configured(env)) return json({ error: 'Scheduler is not configured' }, 503)
    // Unauthorized probes never instantiate or wake the Durable Object.
    if (!await authenticated(request, env)) return json({ error: 'Unauthorized' }, 401)
    return env.REMINDER_ALARM.get(env.REMINDER_ALARM.idFromName('single-user')).fetch(request)
  },
}
