import { randomUUID } from 'node:crypto'
import type { AsyncEventSender } from './scheduler.js'

const MIN_DELAY_MS = 60_000
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const ROOT_EVENTS = new Set(['todo.reminder', 'daily.summary'])

interface Runtime {
  Netlify?: {
    context?: { url?: string }
    env?: { get(name: string): string | undefined; toObject?(): Record<string, string> }
  }
}

function apiKey(runtime: Runtime) {
  const values = { ...process.env, ...runtime.Netlify?.env?.toObject?.() }
  const names = [...new Set(['AWL_API_KEY', 'AWL_API_KEY_P0', ...Object.keys(values)])]
    .filter(name => /^AWL_API_KEY(?:_P\d+)?$/.test(name))
    .sort((left, right) => {
      const priority = (name: string) => Number(/_P(\d+)$/.exec(name)?.[1] ?? -1)
      return priority(right) - priority(left)
    })
  for (const name of names) {
    const value = runtime.Netlify?.env?.get(name) ?? values[name]
    // Async Workloads authenticates the unmodified value as a Bearer token.
    if (value && !/\s/.test(value)) return value
  }
  throw new Error('未配置后续提醒调度凭据')
}

/** Send future reminder occurrences through the documented router API as new
 * root events. Creating another SDK client inside a workload inherits its event
 * chain, which eventually reaches the SDK's finite loop-protection limit. */
export function createRootEventSender(): AsyncEventSender {
  return {
    async send(eventName, options) {
      if (!ROOT_EVENTS.has(eventName)) throw new Error('不支持的后续提醒事件')
      const now = Date.now()
      const requested = options?.delayUntil
      if (typeof requested !== 'number' || !Number.isFinite(requested) || requested >= now + MAX_DELAY_MS) throw new Error('后续提醒时间无效')
      const delayUntil = Math.max(requested, now + MIN_DELAY_MS)
      const runtime = globalThis as typeof globalThis & Runtime
      let url: URL
      let key: string
      try {
        url = new URL(runtime.Netlify?.context?.url ?? '')
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
        key = apiKey(runtime)
      } catch {
        throw new Error('后续提醒调度配置无效')
      }
      url = new URL('/.netlify/functions/async-workloads-router', url.origin)
      url.searchParams.set('events', JSON.stringify([eventName]))
      const eventId = randomUUID()
      try {
        const response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          // Omit eventChain deliberately: each validated future occurrence is a
          // new root. Never pass caller-supplied SDK metadata through this seam.
          body: JSON.stringify({ eventName, eventId, data: options?.data, delayUntil })
        })
        // The router streams an early acknowledgement. Wait for it to close
        // before publishing the event ID in storage, within the same timeout.
        // The SDK can acknowledge a failed persistence attempt; maintenance
        // remains necessary to recover an event that never reaches its handler.
        await response.text()
        if (!response.ok || response.redirected || response.headers.has('x-awl-reason')) throw new Error()
      } catch {
        // Fetch errors and upstream bodies may contain headers or credentials.
        throw new Error('创建后续提醒事件失败')
      }
      return { sendStatus: 'succeeded', eventId }
    }
  }
}
