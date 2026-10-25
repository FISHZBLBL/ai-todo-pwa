export type EventName = 'todo.reminder' | 'daily.summary'

export interface ScheduledEvent {
  eventId: string
  eventName: EventName
  data: Record<string, unknown>
  delayUntil: number
}

export interface StoredEvent extends ScheduledEvent {
  identity: string
  status: 'scheduled' | 'running' | 'completed' | 'dead' | 'cancelled'
  attempt: number
  wakeAt: number | null
  deliveryToken: string | null
  terminalAt: number | null
  failure: string | null
}

export interface QueueTransaction {
  get(eventId: string): StoredEvent | undefined
  put(event: StoredEvent): void
  nextDue(now: number): StoredEvent | undefined
  nextWakeAt(): number | null
  getSteps(eventId: string): Record<string, unknown>
  putStep(eventId: string, key: string, value: unknown): void
  counts(): { active: number; dead: number; completed: number; cancelled: number }
  setAlarm(at: number | null): Promise<void>
}

export interface QueueStore {
  transaction<T>(action: (tx: QueueTransaction) => T | Promise<T>): Promise<T>
}

export interface Delivery {
  eventId: string
  eventName: EventName
  eventData: Record<string, unknown>
  attempt: number
  deliveryToken: string
  stepResults: Record<string, unknown>
}

export interface DeliveryResult {
  status: number
  retryAfterMs?: number
}

export class QueueError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

export const MAX_BATCH = 500
export const DELIVERY_LEASE_MS = 90_000
const MAX_RETRY_MS = 3_600_000
const MAX_EVENT_BYTES = 32_768
const MAX_STEPS = 32

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function validateEvent(value: unknown): ScheduledEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QueueError(400, 'Invalid event')
  const event = value as Partial<ScheduledEvent>
  if (typeof event.eventId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(event.eventId)) throw new QueueError(400, 'Invalid eventId')
  if (event.eventName !== 'todo.reminder' && event.eventName !== 'daily.summary') throw new QueueError(400, 'Invalid eventName')
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new QueueError(400, 'Invalid event data')
  if (!Number.isSafeInteger(event.delayUntil) || event.delayUntil! < 0 || event.delayUntil! > 8_640_000_000_000_000) throw new QueueError(400, 'Invalid delayUntil')
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_BYTES) throw new QueueError(413, 'Event is too large')
  return { eventId: event.eventId, eventName: event.eventName, data: event.data, delayUntil: event.delayUntil! }
}

const identity = (event: ScheduledEvent) => canonical({ eventName: event.eventName, data: event.data, delayUntil: event.delayUntil })

/** A storage transaction never includes delivery I/O; callback step writes can enter concurrently. */
export class AlarmQueue {
  constructor(
    private readonly store: QueueStore,
    private readonly deliver: (event: Delivery) => Promise<DeliveryResult>,
    private readonly now = () => Date.now(),
    private readonly token = () => crypto.randomUUID(),
  ) {}

  async add(values: unknown[]): Promise<{ eventId: string; status: StoredEvent['status'] }[]> {
    if (values.length < 1 || values.length > MAX_BATCH) throw new QueueError(400, `Expected 1-${MAX_BATCH} events`)
    const events = values.map(validateEvent)
    return this.store.transaction(async tx => {
      // Validate the whole batch before making any changes, including duplicate IDs in this batch.
      const unique = new Map<string, ScheduledEvent>()
      for (const event of events) {
        const previous = unique.get(event.eventId)
        if (previous && identity(previous) !== identity(event)) throw new QueueError(409, 'Event ID is already used')
        unique.set(event.eventId, event)
        const existing = tx.get(event.eventId)
        if (existing && existing.status !== 'cancelled' && existing.identity !== identity(event)) throw new QueueError(409, 'Event ID is already used')
      }
      const result = events.map(event => {
        const existing = tx.get(event.eventId)
        if (existing) return { eventId: event.eventId, status: existing.status }
        tx.put({ ...event, identity: identity(event), status: 'scheduled', attempt: 0, wakeAt: event.delayUntil, deliveryToken: null, terminalAt: null, failure: null })
        return { eventId: event.eventId, status: 'scheduled' as const }
      })
      await this.schedule(tx)
      return result
    })
  }

  async cancel(eventIds: string[]): Promise<void> {
    if (eventIds.length > MAX_BATCH || eventIds.some(id => !/^[a-zA-Z0-9:_-]{1,160}$/.test(id))) throw new QueueError(400, 'Invalid eventIds')
    await this.store.transaction(async tx => {
      for (const eventId of new Set(eventIds)) {
        const previous = tx.get(eventId)
        // A cancellation arriving before registration is also durable; delayed HTTP retries cannot revive it.
        tx.put({ eventId, eventName: previous?.eventName ?? 'todo.reminder', data: previous?.data ?? {}, delayUntil: previous?.delayUntil ?? 0, identity: previous?.identity ?? '', status: 'cancelled', attempt: previous?.attempt ?? 0, wakeAt: null, deliveryToken: null, terminalAt: this.now(), failure: null })
      }
      await this.schedule(tx)
    })
  }

  async getStep(eventId: string, key: string, deliveryToken: string): Promise<{ found: boolean; value?: unknown }> {
    return this.store.transaction(tx => {
      this.authorizeStep(tx, eventId, key, deliveryToken)
      const steps = tx.getSteps(eventId)
      return Object.hasOwn(steps, key) ? { found: true, value: steps[key] } : { found: false }
    })
  }

  async putStep(eventId: string, key: string, value: unknown, deliveryToken: string): Promise<{ found: true; value: unknown }> {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_EVENT_BYTES) throw new QueueError(413, 'Step value is too large')
    return this.store.transaction(tx => {
      this.authorizeStep(tx, eventId, key, deliveryToken)
      const steps = tx.getSteps(eventId)
      if (Object.hasOwn(steps, key)) return { found: true, value: steps[key] }
      if (Object.keys(steps).length >= MAX_STEPS) throw new QueueError(413, 'Too many event steps')
      tx.putStep(eventId, key, value)
      return { found: true, value }
    })
  }

  private authorizeStep(tx: QueueTransaction, eventId: string, key: string, deliveryToken: string): StoredEvent {
    if (!key || key.length > 240) throw new QueueError(400, 'Invalid step key')
    const event = tx.get(eventId)
    if (!event || event.status === 'cancelled') throw new QueueError(404, 'Event was cancelled or does not exist')
    if (event.status !== 'running' || !deliveryToken || event.deliveryToken !== deliveryToken || event.wakeAt! <= this.now()) throw new QueueError(409, 'Delivery lease is no longer current')
    return event
  }

  async status() {
    return this.store.transaction(tx => ({ ...tx.counts(), nextAlarm: tx.nextWakeAt() }))
  }

  async runDue(): Promise<void> {
    // A bounded batch keeps alarms short. Remaining due jobs cause another immediate alarm.
    const jobs: Delivery[] = []
    await this.store.transaction(async tx => {
      for (let index = 0; index < 4; index++) {
        const event = tx.nextDue(this.now())
        if (!event) break
        const deliveryToken = this.token()
        const claimed = { ...event, status: 'running' as const, attempt: Math.min(event.attempt + 1, Number.MAX_SAFE_INTEGER), wakeAt: this.now() + DELIVERY_LEASE_MS, deliveryToken }
        tx.put(claimed)
        jobs.push({ eventId: event.eventId, eventName: event.eventName, eventData: event.data, attempt: event.attempt, deliveryToken, stepResults: tx.getSteps(event.eventId) })
      }
      await this.schedule(tx)
    })
    await Promise.all(jobs.map(job => this.deliverClaim(job)))
  }

  private async deliverClaim(job: Delivery): Promise<void> {
    let result: DeliveryResult
    try { result = await this.deliver(job) } catch { result = { status: 503 } }
    await this.store.transaction(async tx => {
      const current = tx.get(job.eventId)
      // A concurrent cancellation or a new lease wins over the older callback result.
      if (!current || current.status !== 'running' || current.deliveryToken !== job.deliveryToken) return
      if (result.status >= 200 && result.status < 300) {
        tx.put({ ...current, status: 'completed', wakeAt: null, deliveryToken: null, terminalAt: this.now(), failure: null })
      } else {
        const retryable = result.status === 429 || result.status >= 500
        if (!retryable) {
          tx.put({ ...current, status: 'dead', wakeAt: null, deliveryToken: null, terminalAt: this.now(), failure: `Callback HTTP ${result.status}` })
        } else {
          const defaultRetry = Math.min(60_000 * 2 ** Math.min(current.attempt - 1, 6), MAX_RETRY_MS)
          const requested = result.retryAfterMs
          const retryMs = Number.isFinite(requested) ? Math.max(1_000, Math.min(requested!, MAX_RETRY_MS)) : defaultRetry
          tx.put({ ...current, status: 'scheduled', wakeAt: this.now() + retryMs, deliveryToken: null, failure: `Callback HTTP ${result.status}` })
        }
      }
      await this.schedule(tx)
    })
  }

  private async schedule(tx: QueueTransaction): Promise<void> {
    const at = tx.nextWakeAt()
    await tx.setAlarm(at === null ? null : Math.max(at, this.now() + 1))
  }
}
