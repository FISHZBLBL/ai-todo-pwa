import type { Draft, ParsedInboxItem, ProfileEntry, Settings, SyncChange, Task } from '../types'

export interface SyncResponse {
  tasks: Task[]
  drafts: Draft[]
  profiles?: ProfileEntry[]
  settings: Settings | null
  deletions?: Array<{ entity: 'task' | 'draft' | 'profile'; id: string; updatedAt: string; deletedAt: string }>
  reminderSchedulingPending?: boolean
}

export interface PushConfig {
  configured: boolean
  publicKey: string | null
  reason: null | 'missing_public_key' | 'missing_private_key' | 'invalid_keys' | 'key_mismatch'
  schedulingAvailable: boolean
}

const base = (import.meta.env.VITE_API_URL?.trim() || '/api').replace(/\/+$/, '')
const tokenKey = 'todo-session'
export const authExpiredEvent = 'todo-auth-expired'
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
  if (response.status === 401 && path !== '/auth/login') {
    localStorage.removeItem(tokenKey); sessionStorage.removeItem(tokenKey)
    window.dispatchEvent(new Event(authExpiredEvent))
  }
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
  parse(content: string, dailySummaryTime = '08:00', signal?: AbortSignal) {
    return request<{ tasks: ParsedInboxItem[] }>('/ai/parse', { method: 'POST', signal, body: JSON.stringify({ content, currentLocalDateTime: localIsoWithOffset(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language, dailySummaryTime }) })
  },
  sync(changes: SyncChange[]) { return request<SyncResponse>('/sync', { method: 'POST', body: JSON.stringify({ changes }) }) },
  health() { return request<{ ok: boolean; ai: { provider: string; model: string; configured: boolean } }>('/health') },
  getDeepseekSettings() { return request<{ deepseek: { configured: boolean; maskedKey: string | null; updatedAt: string | null } }>('/ai-settings/deepseek') },
  saveDeepseekKey(apiKey: string) { return request<{ deepseek: { configured: boolean; maskedKey: string | null; updatedAt: string | null } }>('/ai-settings/deepseek', { method: 'PUT', body: JSON.stringify({ apiKey }) }) },
  deleteDeepseekKey() { return request<{ deepseek: { configured: boolean; maskedKey: string | null; updatedAt: string | null } }>('/ai-settings/deepseek', { method: 'DELETE' }) },
  getPushConfig() { return request<PushConfig>('/push/config') },
  savePush(subscription: PushSubscriptionJSON & { appUrl: string }) { return request('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }) },
  pushStatus(endpoint: string) { return request<{ registered: boolean }>(`/push/subscription?endpoint=${encodeURIComponent(endpoint)}`) },
  deletePush(endpoint: string) { return request('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }) }
}
