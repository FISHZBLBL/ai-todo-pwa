// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AlarmQueue, DELIVERY_LEASE_MS, type Delivery, type DeliveryResult, type QueueStore, type QueueTransaction, type StoredEvent } from '../src/queue'

class MemoryStore implements QueueStore {
  events = new Map<string, StoredEvent>()
  steps = new Map<string, Record<string, unknown>>()
  alarm: number | null = null
  private tail: Promise<unknown> = Promise.resolve()

  transaction<T>(action: (tx: QueueTransaction) => T | Promise<T>): Promise<T> {
    const execute = async () => {
      const original = structuredClone({ events: this.events, steps: this.steps, alarm: this.alarm })
      try {
        return await action({
          get: id => structuredClone(this.events.get(id)),
          put: event => { this.events.set(event.eventId, structuredClone(event)) },
          nextDue: now => [...this.events.values()].filter(event => event.wakeAt !== null && event.wakeAt <= now).sort((a, b) => a.wakeAt! - b.wakeAt!)[0],
          nextWakeAt: () => [...this.events.values()].reduce<number | null>((next, event) => event.wakeAt !== null && (next === null || event.wakeAt < next) ? event.wakeAt : next, null),
          getSteps: id => structuredClone(this.steps.get(id) ?? {}),
          putStep: (id, key, value) => { this.steps.set(id, { ...this.steps.get(id), [key]: structuredClone(value) }) },
          counts: () => {
            const result = { active: 0, dead: 0, completed: 0, cancelled: 0 }
            for (const event of this.events.values()) {
              if (event.status === 'running' || event.status === 'scheduled') result.active++
              else result[event.status]++
            }
            return result
          },
          setAlarm: async at => { this.alarm = at },
        })
      } catch (error) {
        this.events = original.events; this.steps = original.steps; this.alarm = original.alarm
        throw error
      }
    }
    const result = this.tail.then(execute)
    this.tail = result.catch(() => {})
    return result
  }
}

function harness(deliver: (event: Delivery) => Promise<DeliveryResult> = async () => ({ status: 200 })) {
  const store = new MemoryStore()
  let now = 1_000_000, sequence = 0
  const queue = new AlarmQueue(store, deliver, () => now, () => `token-${++sequence}`)
  const event = (eventId = 'event-1', at = now + 60_000) => ({ eventId, eventName: 'todo.reminder' as const, data: { todoId: 'todo-1', reminderId: 'reminder-1' }, delayUntil: at })
  return { queue, store, event, now: () => now, advance: (ms: number) => { now += ms } }
}

describe('Durable Alarm queue', () => {
  it('keeps no alarm while empty, then registers only the earliest reminder', async () => {
    const { queue, store, event, advance } = harness()
    await queue.runDue()
    expect(store.alarm).toBeNull()
    await queue.add([event('later', 1_120_000), event('earlier', 1_060_000)])
    expect(store.alarm).toBe(1_060_000)
    advance(59_999)
    await queue.runDue()
    expect((await queue.status()).active).toBe(2)
    expect(store.alarm).toBe(1_060_000)
    await queue.cancel(['earlier'])
    expect(store.alarm).toBe(1_120_000)
    await queue.cancel(['later'])
    expect(store.alarm).toBeNull()
  })

  it('accepts replayed requests without changing their deadline or attempts', async () => {
    const { queue, store, event } = harness()
    await queue.add([event()])
    await queue.add([{ ...event(), data: { reminderId: 'reminder-1', todoId: 'todo-1' } }])
    expect(store.events.size).toBe(1)
    expect(store.events.get('event-1')).toMatchObject({ status: 'scheduled', attempt: 0, wakeAt: 1_060_000 })
    await expect(queue.add([{ ...event(), delayUntil: 1_060_001 }])).rejects.toMatchObject({ status: 409 })
  })

  it('imports all-or-nothing and rejects conflicting IDs within the same batch', async () => {
    const { queue, store, event } = harness()
    await queue.add([event('old')])
    await expect(queue.add([event('new'), { ...event('old'), data: { changed: true } }])).rejects.toMatchObject({ status: 409 })
    expect(store.events.has('new')).toBe(false)
    await expect(queue.add([event('duplicate'), { ...event('duplicate'), delayUntil: 42 }])).rejects.toMatchObject({ status: 409 })
    expect(store.events.has('duplicate')).toBe(false)
  })

  it('rejects unsupported jobs, malformed times and unbounded batches', async () => {
    const { queue, event } = harness()
    for (const invalid of [{ ...event(), eventName: 'other' }, { ...event(), delayUntil: NaN }, { ...event(), delayUntil: -1 }, { ...event(), data: null }, { ...event(), eventId: '../secret' }]) await expect(queue.add([invalid])).rejects.toMatchObject({ status: 400 })
    await expect(queue.add(Array(501).fill(event()))).rejects.toMatchObject({ status: 400 })
    await expect(queue.add([])).rejects.toMatchObject({ status: 400 })
  })

  it('delivers at the deadline and preserves a completion receipt against duplicate enqueue', async () => {
    const deliveries: Delivery[] = []
    const { queue, store, event, advance } = harness(async value => { deliveries.push(value); return { status: 200 } })
    await queue.add([event()]); advance(60_000); await queue.runDue()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ eventId: 'event-1', eventName: 'todo.reminder', attempt: 0, deliveryToken: 'token-1', eventData: event().data, stepResults: {} })
    expect(store.events.get('event-1')?.status).toBe('completed')
    expect(store.alarm).toBeNull()
    expect(await queue.add([event('event-1', 1_060_000)])).toEqual([{ eventId: 'event-1', status: 'completed' }])
    await queue.runDue()
    expect(deliveries).toHaveLength(1)
  })

  it('cancellation arriving before registration leaves a tombstone and cannot revive', async () => {
    const { queue, store, event } = harness()
    await queue.cancel(['event-1'])
    expect(await queue.add([event()])).toEqual([{ eventId: 'event-1', status: 'cancelled' }])
    expect(store.alarm).toBeNull()
  })

  it('never resurrects a cancellation while its callback is in flight', async () => {
    let finish!: (value: DeliveryResult) => void
    let started!: () => void
    const isStarted = new Promise<void>(resolve => { started = resolve })
    const { queue, store, event, advance } = harness(async () => { started(); return new Promise(resolve => { finish = resolve }) })
    await queue.add([event()]); advance(60_000)
    const running = queue.runDue(); await isStarted
    await queue.cancel(['event-1'])
    expect(store.alarm).toBeNull()
    finish({ status: 503 }); await running
    expect(store.events.get('event-1')?.status).toBe('cancelled')
    expect(store.alarm).toBeNull()
    await expect(queue.putStep('event-1', 'send', true, 'token-1')).rejects.toMatchObject({ status: 404 })
  })

  it('persists successful callback steps, first writer wins, and carries them into retries', async () => {
    const seen: Delivery[] = []
    let h!: ReturnType<typeof harness>
    h = harness(async delivery => {
      seen.push(delivery)
      expect(await h.queue.getStep(delivery.eventId, 'push', delivery.deliveryToken)).toEqual(seen.length === 1 ? { found: false } : { found: true, value: { sent: 1 } })
      expect(await h.queue.putStep(delivery.eventId, 'push', { sent: 1 }, delivery.deliveryToken)).toEqual({ found: true, value: { sent: 1 } })
      expect(await h.queue.putStep(delivery.eventId, 'push', { sent: 999 }, delivery.deliveryToken)).toEqual({ found: true, value: { sent: 1 } })
      return { status: seen.length === 1 ? 503 : 200, retryAfterMs: 10_000 }
    })
    await h.queue.add([h.event()]); h.advance(60_000); await h.queue.runDue()
    expect(h.store.alarm).toBe(h.now() + 10_000)
    h.advance(10_000); await h.queue.runDue()
    expect(seen[1].stepResults).toEqual({ push: { sent: 1 } })
    expect(seen[1].attempt).toBe(1)
    expect(h.store.alarm).toBeNull()
    await expect(h.queue.putStep('event-1', 'push', 1, seen[0].deliveryToken)).rejects.toMatchObject({ status: 409 })
  })

  it.each([401, 403, 400, 404, 302])('parks permanent callback HTTP %s without another alarm', async status => {
    const { queue, store, event, advance } = harness(async () => ({ status }))
    await queue.add([event()]); advance(60_000); await queue.runDue()
    expect(store.events.get('event-1')?.status).toBe('dead')
    expect(store.alarm).toBeNull()
    expect(await queue.status()).toMatchObject({ active: 0, dead: 1, nextAlarm: null })
  })

  it('keeps real failed work through long outages with backoff capped at one hour, then completes', async () => {
    let calls = 0
    let available = false
    const h = harness(async () => { calls++; if (!available) throw new Error('network'); return { status: 200 } })
    await h.queue.add([h.event()]); h.advance(60_000)
    for (let attempt = 0; attempt < 15; attempt++) {
      await h.queue.runDue()
      const wait = h.store.alarm! - h.now()
      expect(wait).toBe(Math.min(60_000 * 2 ** attempt, 3_600_000))
      expect(h.store.events.get('event-1')?.status).toBe('scheduled')
      h.advance(wait - 1)
      await h.queue.runDue()
      expect(calls).toBe(attempt + 1)
      h.advance(1)
    }
    available = true
    await h.queue.runDue()
    expect(calls).toBe(16)
    expect(h.store.events.get('event-1')?.status).toBe('completed')
    expect(h.store.alarm).toBeNull()
    h.advance(3_600_000)
    await h.queue.runDue()
    expect(calls).toBe(16)
    expect(h.store.alarm).toBeNull()
  })

  it('caps callback-requested transient retries at one hour and never retries immediately', async () => {
    let retryAfterMs = 86_400_000
    const h = harness(async () => ({ status: 429, retryAfterMs }))
    await h.queue.add([h.event()]); h.advance(60_000); await h.queue.runDue()
    expect(h.store.alarm).toBe(h.now() + 3_600_000)
    retryAfterMs = -1
    h.advance(3_600_000); await h.queue.runDue()
    expect(h.store.alarm).toBe(h.now() + 1_000)
  })

  it('recovers a crashed lease and rejects an earlier delivery token', async () => {
    let firstFinish!: (value: DeliveryResult) => void
    let firstStarted!: () => void
    const started = new Promise<void>(resolve => { firstStarted = resolve })
    let count = 0
    const h = harness(async () => {
      if (++count === 1) { firstStarted(); return new Promise(resolve => { firstFinish = resolve }) }
      await expect(h.queue.getStep('event-1', 'push', 'token-1')).rejects.toMatchObject({ status: 409 })
      return { status: 200 }
    })
    await h.queue.add([h.event()]); h.advance(60_000)
    const oldExecution = h.queue.runDue(); await started
    expect(h.store.alarm).toBe(h.now() + DELIVERY_LEASE_MS)
    h.advance(DELIVERY_LEASE_MS); await h.queue.runDue()
    firstFinish({ status: 503 }); await oldExecution
    expect(h.store.events.get('event-1')).toMatchObject({ status: 'completed', attempt: 2 })
    expect(h.store.alarm).toBeNull()
  })

  it('processes at most four jobs per alarm and arms the remaining real work', async () => {
    let calls = 0
    const h = harness(async () => { calls++; return { status: 200 } })
    await h.queue.add(Array.from({ length: 9 }, (_, index) => h.event(`event-${index}`)))
    h.advance(60_000); await h.queue.runDue()
    expect(calls).toBe(4)
    expect((await h.queue.status()).active).toBe(5)
    expect(h.store.alarm).toBe(h.now() + 1)
    h.advance(1); await h.queue.runDue(); h.advance(1); await h.queue.runDue()
    expect(calls).toBe(9)
    expect(h.store.alarm).toBeNull()
  })
})
