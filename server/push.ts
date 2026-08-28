import webpush from 'web-push'
import { config } from './config.js'
import { cloudStore } from './storage.js'

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY)
}

export interface PushPayload { title: string; body: string; url: string; tag: string }

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

export async function sendDailySummary(now = new Date()) {
  await cloudStore.purgeExpiredTombstones(now)
  const data = await cloudStore.read()
  const timezone = data.settings?.timezone ?? config.APP_TIMEZONE
  const date = localDate(now, timezone)
  const tasks = data.tasks.filter(task => !task.completed && !task.deletedAt && (task.dueDate === date || (task.dateRange?.start && task.dateRange.start <= date && task.dateRange.end >= date)))
  if (!tasks.length) return { date, sent: 0, skipped: 'empty' as const }
  if (!(await cloudStore.claimDailySummary(date))) return { date, sent: 0, skipped: 'duplicate' as const }
  const result = await sendPushPayload({ title: `今天有 ${tasks.length} 项任务`, body: tasks.slice(0, 4).map(task => task.title).join('\n'), url: '/', tag: `summary-${date}` })
  if (!result.sent) await cloudStore.releaseDailySummary(date)
  return { date, ...result }
}
