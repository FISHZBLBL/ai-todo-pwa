import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'
import { CosObjectStore } from './cos.js'
import type { EncryptedSecret } from './secrets.js'

interface StoredEntity { id: string; updatedAt: string; deletedAt?: string | null }
interface StoredRecurrence { unit: 'day'|'week'; interval: number; end: 'never'|'count'|'date'; count: number | null; until: string | null; occurrence: number; timezone: string; countdown: boolean }
interface StoredReminder { id: string; at: string; eventId?: string | null; sentAt?: string | null; source?: 'auto'|'explicit'; recurrence?: StoredRecurrence | null }
interface StoredTask extends StoredEntity { title?: string; dueDate?: string | null; dateRange?: { start: string; end: string } | null; startTime?: string | null; completed?: boolean; reminderMode?: 'auto' | 'explicit' | 'off'; reminders?: StoredReminder[]; reminderEnabled?: boolean; reminderAt?: string | null; reminderEventId?: string | null; reminderSentAt?: string | null }
interface PushRecord { endpoint: string; keys?: { auth?: string; p256dh?: string }; appUrl?: string }
interface StoredSettings extends StoredEntity { dailySummaryTime: string; timezone: string; schemaVersion: number }
export interface DailySummarySchedule { eventId: string; scheduledFor: string; dailySummaryTime: string; timezone: string }
interface StoredProfile extends StoredEntity { title: string | null; content: string; createdAt: string }
interface DeletionVersion { entity: 'task'|'draft'|'profile'; id: string; updatedAt: string; deletedAt: string }
interface CloudData { tasks: StoredTask[]; drafts: StoredEntity[]; profiles: StoredProfile[]; settings: StoredSettings | null; subscriptions: PushRecord[]; dailySummarySentDates: string[]; dailySummarySchedule: DailySummarySchedule | null; deepseekSecret: EncryptedSecret | null; deletionVersions: DeletionVersion[] }
export interface ReminderTransition { todoId: string; oldEventIds: string[] }
const remindersOf = (task?: StoredTask) => task?.reminders ?? (task?.reminderEnabled && task.reminderAt ? [{ id: 'legacy', at: task.reminderAt, eventId: task.reminderEventId ?? null, sentAt: task.reminderSentAt ?? null, source: task.reminderMode === 'auto' ? 'auto' as const : 'explicit' as const }] : [])
const empty = (): CloudData => ({ tasks: [], drafts: [], profiles: [], settings: null, subscriptions: [], dailySummarySentDates: [], dailySummarySchedule: null, deepseekSecret: null, deletionVersions: [] })
let lock = Promise.resolve()

function isNewerTimestamp(incoming: string, current: string) {
  const incomingTime = Date.parse(incoming), currentTime = Date.parse(current)
  // Old cloud records can retain an offset while the shared schema emits UTC.
  // Preserve the old ordering for invalid legacy values instead of dropping them.
  return Number.isFinite(incomingTime) && Number.isFinite(currentTime) ? incomingTime > currentTime : incoming > current
}

const cloudDataSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional() }).passthrough()).default([]),
  drafts: z.array(z.object({ id: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional() }).passthrough()).default([]),
  profiles: z.array(z.object({ id: z.string(), title: z.string().nullable(), content: z.string(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional() })).default([]),
  settings: z.object({ id: z.string(), updatedAt: z.string(), dailySummaryTime: z.string(), timezone: z.string(), schemaVersion: z.number() }).passthrough().nullable().default(null),
  subscriptions: z.array(z.object({ endpoint: z.string(), keys: z.object({ auth: z.string().optional(), p256dh: z.string().optional() }).optional(), appUrl: z.string().optional() })).default([]),
  dailySummarySentDates: z.array(z.string()).default([]),
  dailySummarySchedule: z.object({ eventId: z.string(), scheduledFor: z.string().datetime({ offset: true }), dailySummaryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1) }).nullable().default(null),
  deepseekSecret: z.object({ version: z.literal(1), algorithm: z.literal('aes-256-gcm'), ciphertext: z.string(), iv: z.string(), authTag: z.string(), lastFour: z.string(), createdAt: z.string(), updatedAt: z.string() }).nullable().default(null),
  deletionVersions: z.array(z.object({ entity: z.enum(['task', 'draft', 'profile']), id: z.string(), updatedAt: z.string(), deletedAt: z.string() })).default([])
})

async function readFileData(): Promise<CloudData> {
  try { return cloudDataSchema.parse(JSON.parse(await readFile(config.DATA_FILE, 'utf8'))) as CloudData }
  catch (error: any) {
    if (error?.code === 'ENOENT') return empty()
    throw new Error(`云端数据文件无法读取：${error instanceof Error ? error.message : '未知错误'}`)
  }
}
async function write(data: CloudData) { await mkdir(dirname(config.DATA_FILE), { recursive: true }); const temp = `${config.DATA_FILE}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(data)); await rename(temp, config.DATA_FILE) }
async function withFileLock<T>(fn: () => Promise<T>) {
  await mkdir(dirname(config.DATA_FILE), { recursive: true })
  const lockPath = `${config.DATA_FILE}.lock`
  const deadline = Date.now() + 5000
  let handle
  while (!handle) {
    try { handle = await open(lockPath, 'wx') }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      // Age is not proof that the previous writer stopped. Never steal a lock.
      if (Date.now() >= deadline) throw new Error('云端数据正忙，请稍后重试')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try { return await fn() } finally { await handle.close(); await unlink(lockPath).catch(() => undefined) }
}
async function mutateFile<T>(fn: (data: CloudData) => T | Promise<T>) {
  let result!: T
  const operation = lock.catch(() => undefined).then(() => withFileLock(async () => { const data = await readFileData(); result = await fn(data); await write(data) }))
  lock = operation.then(() => undefined, () => undefined)
  await operation
  return result
}

let cloudbaseDatabase: Promise<any> | undefined
async function getCloudbaseDatabase() {
  cloudbaseDatabase ??= import('@cloudbase/node-sdk').then(async cloudbase => {
    const database = cloudbase.init({ env: config.CLOUDBASE_ENV_ID }).database()
    try { await database.createCollection(config.CLOUDBASE_COLLECTION) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/already exists|collection.*exist|集合.*存在/i.test(message)) throw error
    }
    return database
  })
  return cloudbaseDatabase
}
function parseCloudbaseSnapshot(snapshot: any): CloudData {
  const record = Array.isArray(snapshot?.data) ? snapshot.data[0] : snapshot?.data
  if (!record) return empty()
  const { _id: _ignored, ...state } = record
  return cloudDataSchema.parse(state) as CloudData
}
async function readCloudbaseData(): Promise<CloudData> {
  const db = await getCloudbaseDatabase()
  return parseCloudbaseSnapshot(await db.collection(config.CLOUDBASE_COLLECTION).doc(config.CLOUDBASE_DOCUMENT_ID).get())
}
async function mutateCloudbase<T>(fn: (data: CloudData) => T | Promise<T>) {
  const db = await getCloudbaseDatabase()
  let result!: T
  await db.runTransaction(async (transaction: any) => {
    const document = transaction.collection(config.CLOUDBASE_COLLECTION).doc(config.CLOUDBASE_DOCUMENT_ID)
    const data = parseCloudbaseSnapshot(await document.get())
    result = await fn(data)
    await document.set(data)
  })
  return result
}

let cloudbaseStorageApp: Promise<any> | undefined
async function getCloudbaseStorageApp() {
  cloudbaseStorageApp ??= import('@cloudbase/node-sdk').then(cloudbase => cloudbase.init({ env: config.CLOUDBASE_ENV_ID }))
  return cloudbaseStorageApp
}
async function cloudbaseStorageFileId(app: any) {
  const metadata = await app.getUploadMetadata({ cloudPath: config.CLOUDBASE_STATE_PATH })
  const fileId = metadata?.data?.fileId
  if (typeof fileId !== 'string' || !fileId) throw new Error('CloudBase 存储未返回有效的文件标识')
  return fileId
}
const missingCloudbaseFile = (value: any) => ['NOT_FOUND', 'RESOURCE_NOT_FOUND', 'STORAGE_FILE_NONEXIST', 'STORAGE_RESOURCE_NOT_FOUND', '404'].includes(String(value?.code ?? value?.statusCode ?? ''))
async function readCloudbaseStorageData(): Promise<CloudData> {
  const app = await getCloudbaseStorageApp()
  const fileID = await cloudbaseStorageFileId(app)
  const lookup = await app.getTempFileURL({ fileList: [{ fileID, maxAge: 60 }] })
  const entry = lookup?.fileList?.[0]
  if (missingCloudbaseFile(entry)) return empty()
  if (!entry?.tempFileURL || (entry.code != null && !['SUCCESS', '0'].includes(String(entry.code)))) throw new Error('CloudBase 存储读取失败：无法获取状态文件，请检查权限和文件状态')
  try {
    const result = await app.downloadFile({ fileID })
    if (result.fileContent == null) throw new Error('CloudBase 存储下载未返回状态文件内容')
    return cloudDataSchema.parse(JSON.parse(Buffer.isBuffer(result.fileContent) ? result.fileContent.toString('utf8') : result.fileContent)) as CloudData
  } catch (error) {
    if (missingCloudbaseFile(error)) return empty()
    throw error
  }
}
async function mutateCloudbaseStorage<T>(_fn: (data: CloudData) => T | Promise<T>): Promise<T> {
  throw new Error('cloudbase-storage 仅支持只读：对象存储无法保证多实例原子写入，请改用支持事务的 STORAGE_ADAPTER=cloudbase')
}

let postgresDatabase: Promise<any> | undefined
async function getPostgresDatabase() {
  postgresDatabase ??= import('@cloudbase/js-sdk').then(({ default: cloudbase }) => cloudbase.init({
    env: config.CLOUDBASE_ENV_ID,
    region: config.CLOUDBASE_REGION,
    accessKey: config.CLOUDBASE_APIKEY
  }).rdb())
  return postgresDatabase
}
function parsePostgresState(state: unknown): CloudData {
  if (!state) return empty()
  return cloudDataSchema.parse(typeof state === 'string' ? JSON.parse(state) : state) as CloudData
}
async function readPostgresData(): Promise<CloudData> {
  const db = await getPostgresDatabase()
  const { data, error } = await db.from(config.CLOUDBASE_COLLECTION).select('state').eq('id', config.CLOUDBASE_DOCUMENT_ID).limit(1)
  if (error) throw new Error(`CloudBase PostgreSQL 读取失败：${error.message ?? String(error)}`)
  return parsePostgresState(data?.[0]?.state)
}
async function mutatePostgres<T>(fn: (data: CloudData) => T | Promise<T>) {
  const db = await getPostgresDatabase()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await db.from(config.CLOUDBASE_COLLECTION).select('state,version').eq('id', config.CLOUDBASE_DOCUMENT_ID).limit(1)
    if (current.error) throw new Error(`CloudBase PostgreSQL 读取失败：${current.error.message ?? String(current.error)}`)
    const row = current.data?.[0]
    const data = parsePostgresState(row?.state)
    const result = await fn(data)
    if (!row) {
      const inserted = await db.from(config.CLOUDBASE_COLLECTION).insert({ id: config.CLOUDBASE_DOCUMENT_ID, state: data, version: 1, updated_at: new Date().toISOString() })
      if (!inserted.error) return result
      if (/^(?:DATABASE_)?23505$/.test(String(inserted.error.code))) continue
      throw new Error(`CloudBase PostgreSQL 初始化失败：${inserted.error.message ?? String(inserted.error)}`)
    }
    const version = Number(row?.version ?? 0)
    const updated = await db.from(config.CLOUDBASE_COLLECTION)
      .update({ state: data, version: version + 1, updated_at: new Date().toISOString() })
      .eq('id', config.CLOUDBASE_DOCUMENT_ID)
      .eq('version', version)
      .select('version')
    if (updated.error) throw new Error(`CloudBase PostgreSQL 写入失败：${updated.error.message ?? String(updated.error)}`)
    if (updated.data?.length) return result
  }
  throw new Error('CloudBase PostgreSQL 数据正忙，请稍后重试')
}

let cosStorage: CosObjectStore | undefined
function getCosStorage() {
  cosStorage ??= new CosObjectStore(config.COS_BUCKET!, config.COS_REGION, config.COS_SECRET_ID!, config.COS_SECRET_KEY!)
  return cosStorage
}
async function readCosData(): Promise<CloudData> {
  const content = await getCosStorage().getText(config.COS_STATE_KEY)
  return content ? cloudDataSchema.parse(JSON.parse(content)) as CloudData : empty()
}
async function mutateCos<T>(fn: (data: CloudData) => T | Promise<T>) {
  const storage = getCosStorage()
  await storage.assertSafeLocking()
  const lockKey = `${config.COS_STATE_KEY}.lock`
  const owner = randomUUID()
  const deadline = Date.now() + 8000
  let acquired = false
  while (!acquired) {
    acquired = await storage.putText(lockKey, JSON.stringify({ owner, acquiredAt: new Date().toISOString() }), { forbidOverwrite: true })
    if (acquired) break
    if (Date.now() >= deadline) throw new Error('COS 状态文件已被锁定，已停止写入；若上次请求中断，请先停止所有写入，再由管理员恢复锁，或改用支持事务的 cloudbase 存储')
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  let commitStarted = false
  let committed = false
  try {
    const data = await readCosData()
    const result = await fn(data)
    commitStarted = true
    await storage.putText(config.COS_STATE_KEY, JSON.stringify(data))
    committed = true
    return result
  } finally {
    // A timed-out PUT may still finish remotely. Releasing its lock would let a
    // later writer commit first and then be overwritten by that uncertain PUT.
    if (!commitStarted || committed) {
      const current = await storage.getText(lockKey).catch(() => null)
      let owned = false
      try { owned = Boolean(current && (JSON.parse(current) as { owner?: string }).owner === owner) } catch { /* Unreadable locks stay closed. */ }
      if (owned) await storage.delete(lockKey).catch(() => undefined)
    }
  }
}

const read = () => config.STORAGE_ADAPTER === 'cloudbase'
  ? readCloudbaseData()
  : config.STORAGE_ADAPTER === 'cloudbase-storage'
    ? readCloudbaseStorageData()
  : config.STORAGE_ADAPTER === 'cloudbase-postgres'
    ? readPostgresData()
    : config.STORAGE_ADAPTER === 'cos'
      ? readCosData()
      : readFileData()
const mutate = <T>(fn: (data: CloudData) => T | Promise<T>) => config.STORAGE_ADAPTER === 'cloudbase'
  ? mutateCloudbase(fn)
  : config.STORAGE_ADAPTER === 'cloudbase-storage'
    ? mutateCloudbaseStorage(fn)
  : config.STORAGE_ADAPTER === 'cloudbase-postgres'
    ? mutatePostgres(fn)
    : config.STORAGE_ADAPTER === 'cos'
      ? mutateCos(fn)
      : mutateFile(fn)

export const cloudStore = {
  read,
  async merge(changes: Array<{ entity: 'task'|'draft'|'profile'|'settings'; value: StoredEntity }>) {
    return mutate(data => {
      const transitions = new Map<string, Set<string>>()
      const touch = (todoId: string, oldEventId?: string | null) => {
        const events = transitions.get(todoId) ?? new Set<string>()
        if (oldEventId) events.add(oldEventId)
        transitions.set(todoId, events)
      }
      for (const change of changes) {
        if (change.entity === 'settings') { if (!data.settings || isNewerTimestamp(change.value.updatedAt, data.settings.updatedAt)) data.settings = change.value as StoredSettings; continue }
        const deletion = data.deletionVersions.find(item => item.entity === change.entity && item.id === change.value.id)
        if (deletion && !isNewerTimestamp(change.value.updatedAt, deletion.updatedAt)) continue
        const collection = change.entity === 'task' ? data.tasks : change.entity === 'draft' ? data.drafts : data.profiles
        const index = collection.findIndex(item => item.id === change.value.id)
        if (index >= 0 && !isNewerTimestamp(change.value.updatedAt, collection[index].updatedAt)) {
          if (change.entity === 'task') touch(change.value.id)
          continue
        }
        if (change.entity === 'task') {
          const previous = index >= 0 ? data.tasks[index] : undefined
          const incoming = change.value as StoredTask
          const previousReminders = remindersOf(previous)
          const nextReminders = remindersOf(incoming).map(reminder => {
            const old = previousReminders.find(value => value.id === reminder.id && value.at === reminder.at)
            return { ...reminder, eventId: old?.eventId ?? null, sentAt: old?.sentAt ?? null }
          })
          for (const old of previousReminders) if (!nextReminders.some(value => value.id === old.id && value.at === old.at) && old.eventId) touch(incoming.id, old.eventId)
          const { reminderEnabled: _enabled, reminderAt: _at, reminderEventId: _event, reminderSentAt: _sent, ...clean } = incoming
          const next: StoredTask = { ...clean, reminders: nextReminders }
          touch(incoming.id)
          if (index < 0) data.tasks.push(next); else data.tasks[index] = next
          continue
        }
        if (change.entity === 'draft') {
          if (index < 0) data.drafts.push(change.value); else data.drafts[index] = change.value
        } else {
          const profile = change.value as StoredProfile
          if (index < 0) data.profiles.push(profile); else data.profiles[index] = profile
        }
      }
      return { tasks: data.tasks, drafts: data.drafts, profiles: data.profiles, settings: data.settings, deletions: data.deletionVersions, reminderTransitions: [...transitions].map(([todoId, eventIds]) => ({ todoId, oldEventIds: [...eventIds] })) satisfies ReminderTransition[] }
    })
  },
  async addSubscription(subscription: PushRecord, now = Date.now()) {
    return mutate(data => {
      const firstSubscription = data.subscriptions.length === 0
      const index = data.subscriptions.findIndex(item => item.endpoint === subscription.endpoint)
      if (index < 0) data.subscriptions.push(subscription); else data.subscriptions[index] = subscription
      const reminderTransitions: ReminderTransition[] = []
      if (firstSubscription) {
        for (const task of data.tasks) {
          if (task.completed || task.deletedAt) continue
          const oldEventIds = new Set<string>()
          let recover = false
          for (const reminder of remindersOf(task)) {
            const at = Date.parse(reminder.at)
            if (reminder.sentAt || !Number.isFinite(at) || at > now) continue
            recover = true
            if (reminder.eventId) oldEventIds.add(reminder.eventId)
            reminder.eventId = null
            if (!task.reminders) task.reminderEventId = null
          }
          if (recover) reminderTransitions.push({ todoId: task.id, oldEventIds: [...oldEventIds] })
        }
      }
      return { reminderTransitions, firstSubscription }
    })
  },
  async removeSubscription(endpoint: string) { return mutate(data => { data.subscriptions = data.subscriptions.filter(item => item.endpoint !== endpoint) }) },
  async hasSubscription(endpoint: string) { return (await read()).subscriptions.some(item => item.endpoint === endpoint) },
  async getTask(todoId: string) { return (await read()).tasks.find(task => task.id === todoId) ?? null },
  async setReminderEvent(todoId: string, reminderIdOrAt: string, atOrEventId: string, eventId?: string) { return mutate(data => { const task = data.tasks.find(item => item.id === todoId); if (!task) return false; if (!eventId) { if (!task.reminderEnabled || task.reminderAt !== reminderIdOrAt || task.completed || task.deletedAt || task.reminderEventId) return false; task.reminderEventId = atOrEventId; task.reminderSentAt = null; return true } const reminder = remindersOf(task).find(item => item.id === reminderIdOrAt); if (!reminder || reminder.at !== atOrEventId || task.completed || task.deletedAt || reminder.eventId) return false; reminder.eventId = eventId; reminder.sentAt = null; task.reminders = remindersOf(task); return true }) },
  async clearReminderEventIfCurrent(todoId: string, reminderId: string, eventId: string) {
    return mutate(data => {
      const task = data.tasks.find(item => item.id === todoId)
      if (!task || task.completed || task.deletedAt) return false
      const reminder = remindersOf(task).find(item => item.id === reminderId)
      if (!reminder || reminder.eventId !== eventId || reminder.sentAt) return false
      reminder.eventId = null
      if (!task.reminders) task.reminderEventId = null
      return true
    })
  },
  async markReminderSent(todoId: string, reminderIdOrEventId: string, eventIdOrSentAt?: string, sentAt = new Date().toISOString()) { return mutate(data => { const task = data.tasks.find(item => item.id === todoId); if (!task) return false; if (!eventIdOrSentAt) { if (!task.reminderEnabled || task.reminderEventId !== reminderIdOrEventId || task.reminderSentAt) return false; task.reminderSentAt = sentAt; return true } const reminder = remindersOf(task).find(item => item.id === reminderIdOrEventId); if (!reminder || reminder.eventId !== eventIdOrSentAt || reminder.sentAt) return false; reminder.sentAt = sentAt; task.reminders = remindersOf(task); return true }) },
  async advanceReminderOccurrence(todoId: string, reminderId: string, eventId: string, next: { at: string; recurrence: StoredRecurrence } | null, nextEventId: string | null, sentAt = new Date().toISOString()) {
    return mutate(data => {
      const task = data.tasks.find(item => item.id === todoId)
      if (!task || task.completed || task.deletedAt) return false
      const reminders = remindersOf(task)
      const reminder = reminders.find(item => item.id === reminderId)
      if (!reminder || reminder.eventId !== eventId || reminder.sentAt || !reminder.recurrence) return false
      if (next) {
        reminder.at = next.at
        reminder.recurrence = next.recurrence
        reminder.eventId = nextEventId
        reminder.sentAt = null
      } else {
        reminder.sentAt = sentAt
        const otherPending = reminders.some(item => item.id !== reminderId && !item.sentAt)
        if (!task.dueDate && !task.dateRange && !otherPending) {
          task.completed = true
          ;(task as StoredTask & { completedAt?: string | null }).completedAt = sentAt
        }
      }
      task.updatedAt = sentAt
      task.reminders = reminders
      return true
    })
  },
  async getDailySummaryScheduleState() { const data = await read(); return { settings: data.settings ?? { dailySummaryTime: '08:00', timezone: config.APP_TIMEZONE }, schedule: data.dailySummarySchedule } },
  async setDailySummarySchedule(schedule: DailySummarySchedule | null) { return mutate(data => { data.dailySummarySchedule = schedule }) },
  async setDailySummaryScheduleIfCurrent(schedule: DailySummarySchedule | null, expectedSchedule: DailySummarySchedule | null, expectedSettings: { dailySummaryTime: string; timezone: string; updatedAt?: string }) {
    return mutate(data => {
      const settings = data.settings ?? { dailySummaryTime: '08:00', timezone: config.APP_TIMEZONE }
      const current = data.dailySummarySchedule
      if (settings.dailySummaryTime !== expectedSettings.dailySummaryTime || settings.timezone !== expectedSettings.timezone || data.settings?.updatedAt !== expectedSettings.updatedAt) return false
      if (current?.eventId !== expectedSchedule?.eventId || current?.scheduledFor !== expectedSchedule?.scheduledFor) return false
      data.dailySummarySchedule = schedule
      return true
    })
  },
  async claimDailySummary(date: string) { return mutate(data => { data.dailySummarySentDates = data.dailySummarySentDates.filter(value => value >= date); if (data.dailySummarySentDates.includes(date)) return false; data.dailySummarySentDates.push(date); return true }) },
  async releaseDailySummary(date: string) { return mutate(data => { data.dailySummarySentDates = data.dailySummarySentDates.filter(value => value !== date) }) },
  async purgeExpiredTombstones(now = new Date()) {
    const cutoff = now.getTime() - 30 * 86400000
    return mutate(data => {
      const keep = (entity: DeletionVersion['entity'], value: StoredEntity) => {
        if (!value.deletedAt || Date.parse(value.deletedAt) >= cutoff) return true
        const index = data.deletionVersions.findIndex(item => item.entity === entity && item.id === value.id)
        const deletion = { entity, id: value.id, updatedAt: value.updatedAt, deletedAt: value.deletedAt }
        if (index < 0) data.deletionVersions.push(deletion)
        else if (isNewerTimestamp(deletion.updatedAt, data.deletionVersions[index].updatedAt)) data.deletionVersions[index] = deletion
        return false
      }
      data.tasks = data.tasks.filter(value => keep('task', value))
      data.drafts = data.drafts.filter(value => keep('draft', value))
      data.profiles = data.profiles.filter(value => keep('profile', value))
    })
  },
  async getDeepseekSecret() { return (await read()).deepseekSecret },
  async saveDeepseekSecret(secret: EncryptedSecret) { return mutate(data => { data.deepseekSecret = secret }) },
  async deleteDeepseekSecret() { return mutate(data => { data.deepseekSecret = null }) }
}
