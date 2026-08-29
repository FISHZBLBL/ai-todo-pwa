import { AsyncWorkloadsClient } from '@netlify/async-workloads'
import { cloudStore, type DailySummarySchedule } from '../storage.js'

export const DAILY_SUMMARY_EVENT = 'daily.summary' as const

export interface DailySummaryEventSender {
  send(eventName: string, options?: { data?: unknown; delayUntil?: number | string; priority?: number }): Promise<{ sendStatus: 'succeeded' | 'failed'; eventId: string }>
}

interface DailySummarySettings { dailySummaryTime: string; timezone: string }
interface EnsureOptions { skipCancellationForEventId?: string }

const defaultSender = () => new AsyncWorkloadsClient() as DailySummaryEventSender

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
  const { settings, schedule } = await cloudStore.getDailySummaryScheduleState()
  const scheduledFor = new Date(nextDailySummaryAt(settings, now)).toISOString()
  if (schedule && schedule.scheduledFor === scheduledFor && schedule.dailySummaryTime === settings.dailySummaryTime && schedule.timezone === settings.timezone) return { scheduled: false as const, schedule }
  if (schedule && schedule.eventId !== options.skipCancellationForEventId) await cancel(schedule.eventId, sender)
  const result = await sender.send(DAILY_SUMMARY_EVENT, { data: { scheduledFor }, delayUntil: Date.parse(scheduledFor) })
  if (result.sendStatus !== 'succeeded') throw new Error('创建每日汇总事件失败')
  const next: DailySummarySchedule = { eventId: result.eventId, scheduledFor, dailySummaryTime: settings.dailySummaryTime, timezone: settings.timezone }
  await cloudStore.setDailySummarySchedule(next)
  return { scheduled: true as const, schedule: next }
}

export async function isCurrentDailySummaryEvent(eventId: string, scheduledFor: string) {
  const { schedule } = await cloudStore.getDailySummaryScheduleState()
  return Boolean(schedule && schedule.eventId === eventId && schedule.scheduledFor === scheduledFor)
}
