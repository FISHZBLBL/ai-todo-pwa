/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
clientsClaim()
self.skipWaiting()
registerRoute(({ request }) => ['document', 'script', 'style', 'font'].includes(request.destination), new StaleWhileRevalidate({ cacheName: 'todo-app-shell' }))
self.addEventListener('push', event => {
  const data = event.data?.json() ?? { title: 'Todo', body: '你有新的任务提醒', url: '/' }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: 'icons/icon.svg', badge: 'icons/icon.svg', data: { url: data.url ?? '/' }, tag: data.tag ?? 'todo-reminder' }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows[0] as WindowClient | undefined
    if (existing) { await existing.focus(); return existing.navigate(target) }
    return self.clients.openWindow(target)
  })())
})
