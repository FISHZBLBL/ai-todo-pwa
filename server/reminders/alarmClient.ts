import { randomUUID } from 'node:crypto'
import type { AsyncEventSender } from './scheduler.js'

export interface AlarmEvent { eventId: string; eventName: 'todo.reminder' | 'daily.summary'; data: Record<string, unknown>; delayUntil: number }
export class AlarmRequestError extends Error {
  constructor(readonly status: number) { super('提醒定时服务请求失败'); this.name = 'AlarmRequestError' }
}

function environment(name: string) {
  const runtime = globalThis as typeof globalThis & { Netlify?: { env?: { get(name: string): string | undefined } } }
  return runtime.Netlify?.env?.get(name) ?? process.env[name]
}

export function alarmConfiguration() {
  const secret = environment('REMINDER_SCHEDULER_SECRET')
  try {
    const url = new URL(environment('REMINDER_SCHEDULER_URL') ?? '')
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !secret || secret.length < 32 || /\s/.test(secret)) return null
    return { url, secret }
  } catch { return null }
}

export async function alarmRequest<Result>(path: string, method = 'GET', body?: unknown, deliveryToken?: string): Promise<Result> {
  const configured = alarmConfiguration()
  if (!configured) throw new Error('尚未配置 Cloudflare 提醒定时服务')
  let response: Response
  try {
    response = await fetch(new URL(path, configured.url), {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${configured.secret}`, 'Content-Type': 'application/json', ...(deliveryToken ? { 'X-Reminder-Delivery-Token': deliveryToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw new AlarmRequestError(response.status) }
    return await response.json() as Result
  } catch (error) {
    if (error instanceof AlarmRequestError) throw error
    throw new Error('无法连接提醒定时服务，请稍后重试')
  }
}

export function createAlarmEventSender(): AsyncEventSender {
  return { async send(eventName, options) {
    if (eventName === 'awl:delete-events') {
      const ids = (options?.data as { eventIds?: unknown } | undefined)?.eventIds
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('取消提醒参数无效')
      const eventIds = [...new Set(ids)] as string[]
      for (let index = 0; index < eventIds.length; index += 100) await alarmRequest('/events', 'DELETE', { eventIds: eventIds.slice(index, index + 100) })
      return { sendStatus: 'succeeded', eventId: `cf:${randomUUID()}` }
    }
    if (eventName !== 'todo.reminder' && eventName !== 'daily.summary') throw new Error('不支持的提醒事件')
    const delayUntil = options?.delayUntil
    if (typeof delayUntil !== 'number' || !Number.isSafeInteger(delayUntil) || delayUntil < 0 || delayUntil > 8_640_000_000_000_000) throw new Error('提醒时间无效')
    const eventId = `cf:${randomUUID()}`
    const result = await alarmRequest<{ events: Array<{ eventId: string; status: string }> }>('/events', 'POST', { eventId, eventName, data: options?.data ?? {}, delayUntil })
    if (result.events?.[0]?.eventId !== eventId || !['scheduled', 'running'].includes(result.events[0].status)) throw new Error('提醒未成功登记')
    return { sendStatus: 'succeeded', eventId }
  } }
}

export async function importAlarmEvents(events: AlarmEvent[]) {
  for (let index = 0; index < events.length; index += 100) {
    const batch = events.slice(index, index + 100)
    const result = await alarmRequest<{ events: Array<{ eventId: string; status: string }> }>('/events/import', 'POST', { events: batch })
    if (result.events?.length !== batch.length || result.events.some((item, offset) => item.eventId !== batch[offset].eventId || !['scheduled', 'running'].includes(item.status))) throw new Error('旧提醒迁移未完整确认，请检查定时服务状态后重试')
  }
}
