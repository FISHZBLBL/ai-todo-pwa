import type { ParsedTask, SyncChange } from '../types'

const base = import.meta.env.VITE_API_URL ?? '/api'
const tokenKey = 'todo-session'
function localIsoWithOffset(date = new Date()) {
  const offset = -date.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-'
  const pad = (value: number) => `${Math.abs(value)}`.padStart(2, '0')
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem(tokenKey) ?? localStorage.getItem(tokenKey)
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`)
  return body as T
}

export const api = {
  hasSession: () => Boolean(sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey)),
  async login(password: string, remember = true) {
    const result = await request<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
    ;(remember ? localStorage : sessionStorage).setItem(tokenKey, result.token)
  },
  logout() { localStorage.removeItem(tokenKey); sessionStorage.removeItem(tokenKey) },
  parse(content: string, signal?: AbortSignal) {
    return request<{ tasks: ParsedTask[] }>('/ai/parse', { method: 'POST', signal, body: JSON.stringify({ content, currentLocalDateTime: localIsoWithOffset(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language }) })
  },
  sync(changes: SyncChange[]) { return request<{ tasks: unknown[]; drafts: unknown[]; settings: unknown | null }>('/sync', { method: 'POST', body: JSON.stringify({ changes }) }) },
  health() { return request<{ ok: boolean; ai: { provider: string; model: string; configured: boolean } }>('/health') },
  savePush(subscription: PushSubscriptionJSON & { appUrl: string }) { return request('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }) }
}
