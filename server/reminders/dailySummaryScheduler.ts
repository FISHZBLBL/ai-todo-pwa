import { ErrorRetryAfterDelay } from './workflow.js'
import { createAlarmEventSender } from './alarmClient.js'
import { cloudStore, type DailySummarySchedule } from '../storage.js'

export const DAILY_SUMMARY_EVENT = 'daily.summary' as const

export interface DailySummaryEventSender {
  send(eventName: string, options?: { data?: unknown; delayUntil?: number | string; priority?: number }): Promise<{ sendStatus: 'succeeded' | 'failed'; eventId: string }>
}

interface DailySummarySettings { dailySummaryTime: string; timezone: string }
export interface DailySummaryEventData {
  scheduledFor: string
  dailySummaryTime?: string
  timezone?: string
  settingsUpdatedAt?: string | null
  previousEventId?: string | null
}
interface EnsureOptions { skipCancellationForEventId?: string; recoverOverdueAfterMs?: number }

const defaultSender = () => createAlarmEventSender() as DailySummaryEventSender

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value ?? 0)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

function dateKey({ year, month, day }: { year: number; month: number; day: number }) {
  return `${year}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`
}

function plusOneLocalDay(local: { year: number; month: number; day: number }) {
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
  return dateKey({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() })
}

function zonedDateTimeToTimestamp(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = wanted
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(new Date(timestamp), timezone)
    timestamp += wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
  }
  return timestamp
}

export function nextDailySummaryAt(settings: DailySummarySettings, now = new Date()) {
  const local = localParts(now, settings.timezone)
  const [hour, minute] = settings.dailySummaryTime.split(':').map(Number)
  const today = dateKey(local)
  const targetDate = local.hour * 60 + local.minute >= hour * 60 + minute ? plusOneLocalDay(local) : today
  return zonedDateTimeToTimestamp(targetDate, settings.dailySummaryTime, settings.timezone)
}

async function cancel(eventId: string, sender: DailySummaryEventSender) {
  const result = await sender.send('awl:delete-events', { data: { eventIds: [eventId] } })
  if (result.sendStatus !== 'succeeded') throw new Error('取消旧每日汇总事件失败')
}

export async function ensureDailySummarySchedule(sender: DailySummaryEventSender = defaultSender(), now = new Date(), options: EnsureOptions = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { settings, schedule, eligible } = await cloudStore.getDailySummaryScheduleState()
    if (eligible === false) {
      if (!schedule) return { scheduled: false as const, schedule: null }
      if (!await cloudStore.setDailySummaryScheduleIfCurrent(null, schedule, settings, false)) continue
      if (schedule.eventId !== options.skipCancellationForEventId) await cancel(schedule.eventId, sender)
      return { scheduled: false as const, schedule: null }
    }
    const sameSettings = schedule?.dailySummaryTime === settings.dailySummaryTime && schedule.timezone === settings.timezone
    const recovering = Boolean(schedule && options.recoverOverdueAfterMs != null && now.getTime() - Date.parse(schedule.scheduledFor) >= options.recoverOverdueAfterMs)
    // Reaching the clock time does not mean delivery has completed. Preserve
    // delayed/retrying events during ordinary sync, even after their due time.
    if (schedule && sameSettings && schedule.eventId !== options.skipCancellationForEventId && !recovering) return { scheduled: false as const, schedule }
    // A replacement gets a fresh due timestamp so subsequent sync requests
    // leave its retry window intact.
    const scheduledFor = recovering && sameSettings ? now.toISOString() : new Date(nextDailySummaryAt(settings, now)).toISOString()
    const data: DailySummaryEventData = { scheduledFor, dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone, settingsUpdatedAt: 'updatedAt' in settings ? settings.updatedAt ?? null : null, previousEventId: schedule?.eventId ?? null }
    const result = await sender.send(DAILY_SUMMARY_EVENT, { data, delayUntil: recovering && sameSettings ? now.getTime() + 60_000 : Date.parse(scheduledFor) })
    if (result.sendStatus !== 'succeeded') throw new Error('创建每日汇总事件失败')
    const next: DailySummarySchedule = { eventId: result.eventId, scheduledFor, dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone }
    const stored = eligible === undefined
      ? await cloudStore.setDailySummaryScheduleIfCurrent(next, schedule, settings)
      : await cloudStore.setDailySummaryScheduleIfCurrent(next, schedule, settings, eligible)
    if (!stored) {
      await cancel(result.eventId, sender)
      continue
    }
    // Publish the new pointer before cancelling the old event. A slow request
    // cannot cancel a newer schedule created after the state it read.
    if (schedule && schedule.eventId !== options.skipCancellationForEventId) await cancel(schedule.eventId, sender)
    return { scheduled: true as const, schedule: next }
  }
  throw new Error('每日汇总设置正在更新，请稍后重试')
}

/** Recover an accepted alarm if its creator stopped before binding the pointer. */
export async function registerUnboundDailySummaryEvent(eventId: string, data: DailySummaryEventData) {
  if (typeof data.dailySummaryTime !== 'string' || typeof data.timezone !== 'string'
    || (data.settingsUpdatedAt !== null && typeof data.settingsUpdatedAt !== 'string')
    || (data.previousEventId !== null && typeof data.previousEventId !== 'string')) return false
  const { settings, schedule, eligible } = await cloudStore.getDailySummaryScheduleState()
  if (schedule?.eventId === eventId) return schedule.scheduledFor === data.scheduledFor
  if (!eligible || settings.dailySummaryTime !== data.dailySummaryTime || settings.timezone !== data.timezone
    || ('updatedAt' in settings ? settings.updatedAt ?? null : null) !== data.settingsUpdatedAt
    || (schedule?.eventId ?? null) !== data.previousEventId) return false
  const next: DailySummarySchedule = { eventId, scheduledFor: data.scheduledFor, dailySummaryTime: data.dailySummaryTime, timezone: data.timezone }
  return cloudStore.setDailySummaryScheduleIfCurrent(next, schedule, settings, true)
}

export async function completeDailySummaryEvent(eventId: string, scheduledFor: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { settings, schedule } = await cloudStore.getDailySummaryScheduleState()
    if (!schedule || schedule.eventId !== eventId || schedule.scheduledFor !== scheduledFor) return
    if (await cloudStore.setDailySummaryScheduleIfCurrent(null, schedule, settings)) return
  }
  throw new Error('每日汇总完成状态保存失败')
}

export async function isCurrentDailySummaryEvent(eventId: string, scheduledFor: string, options: { waitForRegistration?: boolean } = {}) {
  const { schedule } = await cloudStore.getDailySummaryScheduleState()
  const current = Boolean(schedule && schedule.eventId === eventId && schedule.scheduledFor === scheduledFor)
  if (!current && options.waitForRegistration && Date.now() <= Date.parse(scheduledFor) + 5 * 60_000) throw new ErrorRetryAfterDelay({ message: '每日汇总事件等待登记', retryDelay: '1m' })
  return current
}
