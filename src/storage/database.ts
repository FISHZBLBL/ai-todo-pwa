import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Draft, ProfileEntry, Settings, SyncChange, Task } from '../types'

interface TodoDB extends DBSchema {
  tasks: { key: string; value: Task; indexes: { updatedAt: string } }
  drafts: { key: string; value: Draft; indexes: { updatedAt: string } }
  profiles: { key: string; value: ProfileEntry; indexes: { updatedAt: string } }
  syncQueue: { key: number; value: SyncChange }
  meta: { key: string; value: unknown }
}

const DB_NAME = 'ai-todo'
export const SCHEMA_VERSION = 3
let database: Promise<IDBPDatabase<TodoDB>> | undefined

export function db() {
  database ??= openDB<TodoDB>(DB_NAME, SCHEMA_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('tasks')) {
        const tasks = database.createObjectStore('tasks', { keyPath: 'id' })
        tasks.createIndex('updatedAt', 'updatedAt')
      }
      if (!database.objectStoreNames.contains('drafts')) {
        const drafts = database.createObjectStore('drafts', { keyPath: 'id' })
        drafts.createIndex('updatedAt', 'updatedAt')
      }
      if (!database.objectStoreNames.contains('profiles')) {
        const profiles = database.createObjectStore('profiles', { keyPath: 'id' })
        profiles.createIndex('updatedAt', 'updatedAt')
      }
      if (!database.objectStoreNames.contains('syncQueue')) database.createObjectStore('syncQueue', { autoIncrement: true })
      if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta')
    }
  })
  return database
}

export const defaultSettings: Settings = {
  id: 'settings',
  dailySummaryTime: '08:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  schemaVersion: SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  lastSyncAt: null
}

export async function getSettings(): Promise<Settings> {
  return { ...defaultSettings, ...((await (await db()).get('meta', 'settings')) as Partial<Settings> | undefined) }
}

export async function saveSettings(settings: Settings, shouldQueue = false) {
  const database = await db()
  await database.put('meta', settings, 'settings')
  if (shouldQueue) await database.add('syncQueue', { entity: 'settings', value: settings, queuedAt: new Date().toISOString() } satisfies SyncChange)
}
export async function resetDatabaseForTests() {
  if (database) (await database).close()
  database = undefined
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB reset blocked'))
  })
}
