import { timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { handleTodoReminder } from '../../netlify/functions/todo-reminder.js'
import { handleDailySummary } from '../../netlify/functions/daily-summary.js'
import { alarmConfiguration, alarmRequest, AlarmRequestError } from './alarmClient.js'
import { registerUnboundDailySummaryEvent } from './dailySummaryScheduler.js'
import { ErrorDoNotRetry, ErrorRetryAfterDelay, type WorkflowEvent } from './workflow.js'

const common = { eventId: z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/), attempt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), deliveryToken: z.string().min(16).max(160), stepResults: z.record(z.string(), z.unknown()).optional() }
const payloadSchema = z.discriminatedUnion('eventName', [
  z.object({ ...common, eventName: z.literal('todo.reminder'), eventData: z.object({ todoId: z.string().min(1).max(160), reminderId: z.string().min(1).max(160).optional(), expectedAt: z.iso.datetime({ offset: true }).optional(), expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(), previousEventId: z.string().min(1).max(160).optional() }).strict() }).strict(),
  z.object({ ...common, eventName: z.literal('daily.summary'), eventData: z.object({ scheduledFor: z.iso.datetime({ offset: true }), dailySummaryTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), timezone: z.string().min(1).max(100).optional(), settingsUpdatedAt: z.iso.datetime({ offset: true }).nullable().optional(), previousEventId: z.string().min(1).max(160).nullable().optional() }).strict() }).strict()
])

export function isSchedulerRequest(request: Request) {
  const configured = alarmConfiguration()
  const header = request.get('Authorization')
  if (!configured || !header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7)), expected = Buffer.from(configured.secret)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function persistentSteps(eventId: string, deliveryToken: string): WorkflowEvent['step'] {
  const decode = (value: unknown) => {
    const parsed = z.object({ defined: z.boolean(), data: z.unknown().optional() }).safeParse(value)
    if (!parsed.success) throw new Error('提醒步骤缓存格式无效')
    return parsed.data.defined ? parsed.data.data : undefined
  }
  return { async run<Result>(name: string, callback: () => Result | Promise<Result>): Promise<Result> {
    const path = `/events/${encodeURIComponent(eventId)}/steps/${encodeURIComponent(name)}`
    try {
      const stored = await alarmRequest<{ found: boolean; value?: unknown }>(path, 'GET', undefined, deliveryToken)
      if (stored.found) return decode(stored.value) as Result
      const value = await callback()
      const result = await alarmRequest<{ found: boolean; value?: unknown }>(path, 'PUT', { value: { defined: value !== undefined, ...(value === undefined ? {} : { data: value }) } }, deliveryToken)
      if (!result.found) throw new Error('提醒步骤未持久保存')
      return decode(result.value) as Result
    } catch (error) {
      if (error instanceof AlarmRequestError && [404, 409].includes(error.status)) throw new ErrorDoNotRetry('提醒已取消或本次投递已过期')
      throw error
    }
  } }
}

export async function deliverReminder(request: Request, response: Response) {
  response.setHeader('Cache-Control', 'no-store')
  if (!isSchedulerRequest(request)) return response.status(401).json({ error: 'Unauthorized' })
  const parsed = payloadSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ error: '提醒事件格式无效' })
  const value = parsed.data
  const step = persistentSteps(value.eventId, value.deliveryToken)
  try {
    // Validate the current lease before any self-registration can write an ID
    // back to cloud storage. A delayed callback may already be cancelled.
    await alarmRequest(`/events/${encodeURIComponent(value.eventId)}/steps/lease-check`, 'GET', undefined, value.deliveryToken)
    if (value.eventName === 'todo.reminder') await handleTodoReminder({ ...value, step })
    else {
      await registerUnboundDailySummaryEvent(value.eventId, value.eventData)
      await handleDailySummary({ ...value, step })
    }
    return response.status(200).json({ ok: true })
  } catch (error) {
    if (error instanceof ErrorDoNotRetry || (error instanceof AlarmRequestError && [404, 409].includes(error.status))) return response.status(200).json({ ok: true, skipped: true })
    return response.status(503).json({ error: '提醒执行暂未完成', ...(error instanceof ErrorRetryAfterDelay ? { retryAfterMs: error.retryDelayMs } : {}) })
  }
}
