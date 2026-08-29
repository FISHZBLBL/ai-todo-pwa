import { db, getSettings, saveSettings } from '../storage/database'
import { draftRepository } from '../repositories/draftRepository'
import { taskRepository } from '../repositories/taskRepository'
import { api } from '../services/api'
import type { Draft, Settings, Task } from '../types'

let syncing = false
export async function syncNow() {
  if (syncing || !navigator.onLine || !api.hasSession()) return false
  syncing = true
  try {
    const database = await db()
    const transaction = database.transaction('syncQueue', 'readonly')
    const keys = await transaction.store.getAllKeys()
    const changes = await transaction.store.getAll()
    await transaction.done
    const response = await api.sync(changes)
    const cleanup = database.transaction('syncQueue', 'readwrite')
    for (const key of keys) await cleanup.store.delete(key)
    await cleanup.done
    for (const task of response.tasks as Task[]) {
      const local = await taskRepository.get(task.id)
      if (!local || task.updatedAt > local.updatedAt) await taskRepository.save(task, false)
      else if (task.updatedAt === local.updatedAt && JSON.stringify(task.reminders) !== JSON.stringify(local.reminders)) {
        await taskRepository.save({ ...local, reminders: task.reminders ?? [] }, false)
      }
    }
    for (const draft of response.drafts as Draft[]) {
      const local = await draftRepository.get(draft.id)
      if (!local || draft.updatedAt > local.updatedAt) await draftRepository.save(draft, false)
    }
    if (response.settings) {
      const local = await getSettings()
      const remote = response.settings as Settings
      if (remote.updatedAt > local.updatedAt) await saveSettings({ ...remote, lastSyncAt: local.lastSyncAt })
    }
    const settings = await getSettings(); settings.lastSyncAt = new Date().toISOString(); await saveSettings(settings)
    return true
  } finally { syncing = false }
}

export function installAutoSync(onChange?: () => void) {
  const handler = () => void syncNow().then(() => onChange?.()).catch(() => undefined)
  window.addEventListener('online', handler)
  const timer = window.setInterval(handler, 60000)
  return () => { window.removeEventListener('online', handler); window.clearInterval(timer) }
}
