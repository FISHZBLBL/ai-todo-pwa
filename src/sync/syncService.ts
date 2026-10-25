import { db, defaultSettings, getSettings } from '../storage/database'
import { normalizeTask } from '../repositories/taskRepository'
import { api, type SyncResponse } from '../services/api'
import type { Settings, SyncChange } from '../types'
import { syncChangeSchema, validationMessage } from '../../shared/syncSchema'
import { jsonBytes, MAX_SYNC_BATCH_BYTES, MAX_SYNC_CHANGES } from '../../shared/limits'

export interface SyncIssue { entity: string; id: string; reason: string; retainedAt: string; change: unknown }
const issuesKey = 'syncRejectedChanges'
let activeSync: Promise<boolean> | undefined

export async function getSyncIssues(): Promise<SyncIssue[]> {
  return (await (await db()).get('meta', issuesKey) as SyncIssue[] | undefined) ?? []
}

/** Keep the version comparison, writes and queue acknowledgement atomic. */
export async function applySyncResponse(response: SyncResponse, acknowledgedKeys: number[]) {
  const database = await db()
  const transaction = database.transaction(['tasks', 'drafts', 'profiles', 'meta', 'syncQueue'], 'readwrite')
  for (const incoming of response.tasks) {
    const remote = normalizeTask(incoming)
    const local = await transaction.objectStore('tasks').get(remote.id)
    if (!local || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)) await transaction.objectStore('tasks').put(remote)
    else if (Date.parse(remote.updatedAt) === Date.parse(local.updatedAt)) {
      await transaction.objectStore('tasks').put({ ...local, reminders: remote.reminders })
    }
  }
  for (const remote of response.drafts) {
    const local = await transaction.objectStore('drafts').get(remote.id)
    if (!local || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)) await transaction.objectStore('drafts').put(remote)
  }
  for (const remote of response.profiles ?? []) {
    const local = await transaction.objectStore('profiles').get(remote.id)
    if (!local || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)) await transaction.objectStore('profiles').put(remote)
  }
  for (const deletion of response.deletions ?? []) {
    const store = transaction.objectStore(deletion.entity === 'task' ? 'tasks' : deletion.entity === 'draft' ? 'drafts' : 'profiles')
    const local = await store.get(deletion.id)
    if (local && Date.parse(local.updatedAt) <= Date.parse(deletion.updatedAt)) {
      await store.put({ ...local, updatedAt: deletion.updatedAt, deletedAt: deletion.deletedAt } as never)
    }
  }
  const localSettings = { ...defaultSettings, ...await transaction.objectStore('meta').get('settings') as Partial<Settings> | undefined }
  const settings = response.settings && Date.parse(response.settings.updatedAt) > Date.parse(localSettings.updatedAt) ? response.settings : localSettings
  await transaction.objectStore('meta').put({ ...settings, lastSyncAt: new Date().toISOString() }, 'settings')
  for (const key of acknowledgedKeys) await transaction.objectStore('syncQueue').delete(key)
  await transaction.done
}

async function performSync() {
  const database = await db()
  const snapshot = database.transaction('syncQueue', 'readonly')
  const keys = await snapshot.store.getAllKeys()
  const changes = await snapshot.store.getAll()
  await snapshot.done
  const groups = new Map<string, { change: SyncChange; keys: number[] }>()
  changes.forEach((change, index) => {
    const id = (change.value as { id?: string } | undefined)?.id ?? `invalid-${keys[index]}`
    const identity = `${change.entity}:${id}`
    const previous = groups.get(identity)
    const newer = !previous || !(Date.parse(previous.change.value?.updatedAt) > Date.parse(change.value?.updatedAt))
    groups.set(identity, { change: newer ? change : previous.change, keys: [...previous?.keys ?? [], keys[index]] })
  })
  const accepted: Array<{ change: SyncChange; keys: number[] }> = []
  const rejected: Array<{ issue: SyncIssue; keys: number[] }> = []
  for (const group of groups.values()) {
    const parsed = syncChangeSchema.safeParse(group.change)
    if (parsed.success) accepted.push({ change: { ...parsed.data, queuedAt: group.change.queuedAt } as SyncChange, keys: group.keys })
    else rejected.push({ issue: { entity: group.change.entity, id: (group.change.value as { id?: string })?.id ?? '', reason: validationMessage(parsed.error), retainedAt: new Date().toISOString(), change: group.change }, keys: group.keys })
  }
  if (groups.size) {
    const quarantine = database.transaction(['meta', 'syncQueue'], 'readwrite')
    const old = await quarantine.objectStore('meta').get(issuesKey) as SyncIssue[] | undefined
    const resolved = new Set(accepted.map(({ change }) => `${change.entity}:${change.value.id}`))
    const issues = (old ?? []).filter(issue => !resolved.has(`${issue.entity}:${issue.id}`) && !rejected.some(item => item.issue.entity === issue.entity && item.issue.id === issue.id))
    for (const rejectedGroup of rejected) {
      issues.push(rejectedGroup.issue)
      for (const key of rejectedGroup.keys) await quarantine.objectStore('syncQueue').delete(key)
    }
    await quarantine.objectStore('meta').put(issues, issuesKey)
    await quarantine.done
  }
  const settings = await getSettings()
  if (settings.updatedAt === defaultSettings.updatedAt && !accepted.some(entry => entry.change.entity === 'settings')) {
    // Epoch defaults may initialize an empty account, but can never outrank
    // settings edited on another device. They are not a local user edit.
    const parsed = syncChangeSchema.safeParse({ entity: 'settings', value: settings })
    if (parsed.success) accepted.push({ change: { ...parsed.data, queuedAt: new Date().toISOString() } as SyncChange, keys: [] })
  }
  const batches: Array<typeof accepted> = []
  let batch: typeof accepted = []
  let batchBytes = jsonBytes({ changes: [] })
  for (const entry of accepted) {
    const entryBytes = jsonBytes(entry.change)
    if (batch.length && (batch.length >= MAX_SYNC_CHANGES || batchBytes + entryBytes + 1 > MAX_SYNC_BATCH_BYTES)) {
      batches.push(batch); batch = []; batchBytes = jsonBytes({ changes: [] })
    }
    batchBytes += entryBytes + (batch.length ? 1 : 0)
    batch.push(entry)
  }
  if (batch.length || !batches.length) batches.push(batch)
  for (const current of batches) {
    const response = await api.sync(current.map(entry => entry.change))
    await applySyncResponse(response, current.flatMap(entry => entry.keys))
  }
  return true
}

export function syncNow(): Promise<boolean> {
  if (activeSync) return activeSync
  if (!navigator.onLine || !api.hasSession()) return Promise.resolve(false)
  activeSync = performSync().finally(() => { activeSync = undefined })
  return activeSync
}

export function installAutoSync(onChange?: () => void) {
  let disposed = false
  const handler = () => {
    if (disposed) return
    void syncNow().then(() => { if (!disposed) onChange?.() }).catch(() => undefined)
  }
  const poll = async () => {
    if (disposed || !navigator.onLine || !api.hasSession()) return
    // A hidden tab still uploads queued edits, but does not repeatedly fetch
    // unchanged cloud state. Returning to the app refreshes it immediately.
    if (document.visibilityState === 'hidden' && !await (await db()).count('syncQueue')) return
    handler()
  }
  const onVisibilityChange = () => { if (document.visibilityState === 'visible') handler() }
  window.addEventListener('online', handler)
  document.addEventListener('visibilitychange', onVisibilityChange)
  const timer = window.setInterval(() => void poll().catch(() => undefined), 60000)
  return () => {
    disposed = true
    window.removeEventListener('online', handler)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.clearInterval(timer)
  }
}
