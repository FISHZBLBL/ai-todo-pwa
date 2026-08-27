import webpush from 'web-push'
import { config } from './config.js'
import { cloudStore } from './storage.js'

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY)
export async function sendDueNotifications(now = new Date()) {
  await cloudStore.purgeExpiredTombstones(now)
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) throw new Error('VAPID 未配置')
  const data = await cloudStore.read()
  const timezone = data.settings?.timezone ?? config.APP_TIMEZONE
  const summaryTime = data.settings?.dailySummaryTime ?? '08:00'
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  const localDate = `${part('year')}-${part('month')}-${part('day')}`, localTime = `${part('hour')}:${part('minute')}`
  const active = (data.tasks as any[]).filter(item => !item.completed && !item.deletedAt)
  const timed = active.filter((item: any) => item.date === localDate && item.time === localTime)
  const summary = localTime === summaryTime ? active.filter((item: any) => item.date === localDate || (item.dateRange?.start <= localDate && item.dateRange?.end >= localDate)) : []
  const notifications = [
    ...(summary.length ? [{ key: `summary:${localDate}:${localTime}`, payload: { title: `今天有 ${summary.length} 项任务`, body: summary.slice(0, 4).map((item: any) => item.title).join('\n'), url: '/', tag: `summary-${localDate}` } }] : []),
    ...(timed.length ? [{ key: `timed:${localDate}:${localTime}`, payload: { title: `${localTime} · ${timed[0].title}`, body: timed.length > 1 ? `另有 ${timed.length - 1} 项任务` : '该做这件事了', url: '/', tag: `timed-${localDate}-${localTime}` } }] : [])
  ]
  let sent = 0
  for (const notification of notifications) {
    if (!(await cloudStore.claimNotification(notification.key, now))) continue
    let notificationSent = 0
    for (const subscription of data.subscriptions) { try { await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify({ ...notification.payload, url: subscription.appUrl ?? notification.payload.url })); sent++; notificationSent++ } catch (error: any) { if (error.statusCode === 404 || error.statusCode === 410) await cloudStore.removeSubscription(subscription.endpoint) } }
    if (!notificationSent) await cloudStore.releaseNotification(notification.key)
  }
  return { sent }
}
