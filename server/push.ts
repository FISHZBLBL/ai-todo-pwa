import webpush from 'web-push'
import { config } from './config.js'
import { cloudStore } from './storage.js'

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY)
}

export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface DailyDigest { date: string; title: string; body: string; taskCount: number }
export interface DailyDigestTask { id: string; title?: string; dueDate?: string | null; dateRange?: { start: string; end: string } | null; completed?: boolean; deletedAt?: string | null }
export interface DailyDigestData { tasks: DailyDigestTask[]; settings?: { timezone?: string } | null }

function localDate(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export async function sendPushPayload(payload: PushPayload) {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) throw new Error('VAPID 未配置')
  const data = await cloudStore.read()
  let sent = 0
  let failed = 0
  for (const subscription of data.subscriptions) {
    if (!subscription.keys?.auth || !subscription.keys.p256dh) { failed += 1; continue }
    const url = subscription.appUrl ? new URL(payload.url, subscription.appUrl).href : payload.url
    try {
      await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify({ ...payload, url }))
      sent += 1
    } catch (error: any) {
      failed += 1
      console.error('[web-push]', subscription.endpoint, error?.statusCode ?? '', error instanceof Error ? error.message : String(error))
      if (error?.statusCode === 404 || error?.statusCode === 410) await cloudStore.removeSubscription(subscription.endpoint)
    }
  }
  return { sent, failed, subscriptions: data.subscriptions.length }
}

export function buildDailyDigest(data: DailyDigestData, now = new Date()): DailyDigest | null {
  const timezone = data.settings?.timezone ?? config.APP_TIMEZONE
  const date = localDate(now, timezone)
  const overdue = data.tasks.filter(task => !task.completed && !task.deletedAt && Boolean((task.dueDate && task.dueDate < date) || (task.dateRange?.end && task.dateRange.end < date)))
  const today = data.tasks.filter(task => !task.completed && !task.deletedAt && (task.dueDate === date || (task.dateRange?.start && task.dateRange.start <= date && task.dateRange.end >= date)))
  const tasks = [...overdue, ...today.filter(task => !overdue.some(overdueTask => overdueTask.id === task.id))]
  if (!tasks.length) return null
  const sections = [
    overdue.length ? ['逾期：', ...overdue.map(task => `• ${task.title ?? '未命名任务'}`)] : [],
    today.length ? ['今天：', ...today.map(task => `• ${task.title ?? '未命名任务'}`)] : []
  ].filter(section => section.length)
  return { date, title: overdue.length ? `今天有 ${today.length} 项任务，${overdue.length} 项逾期` : `今天有 ${today.length} 项任务`, body: sections.flat().join('\n'), taskCount: tasks.length }
}

export async function sendDailySummary(now = new Date(), sender: (payload: PushPayload) => ReturnType<typeof sendPushPayload> = sendPushPayload) {
  await cloudStore.purgeExpiredTombstones(now)
  const digest = buildDailyDigest(await cloudStore.read(), now)
  if (!digest) return { date: localDate(now, config.APP_TIMEZONE), sent: 0, skipped: 'empty' as const }
  const { date } = digest
  if (!(await cloudStore.claimDailySummary(date))) return { date, sent: 0, skipped: 'duplicate' as const }
  const result = await sender({ title: digest.title, body: digest.body, url: '/', tag: `summary-${date}` })
  if (!result.sent) await cloudStore.releaseDailySummary(date)
  return { date, ...result, taskCount: digest.taskCount }
}
