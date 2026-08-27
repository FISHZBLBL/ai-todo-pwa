import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import { config } from './config.js'

interface StoredEntity { id: string; updatedAt: string; deletedAt?: string | null }
interface PushRecord { endpoint: string; keys?: { auth?: string; p256dh?: string }; appUrl?: string }
interface StoredSettings extends StoredEntity { dailySummaryTime: string; timezone: string; schemaVersion: number }
interface CloudData { tasks: StoredEntity[]; drafts: StoredEntity[]; settings: StoredSettings | null; subscriptions: PushRecord[]; notificationClaims: Record<string, string> }
const empty = (): CloudData => ({ tasks: [], drafts: [], settings: null, subscriptions: [], notificationClaims: {} })
let lock = Promise.resolve()

const cloudDataSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional() }).passthrough()).default([]),
  drafts: z.array(z.object({ id: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional() }).passthrough()).default([]),
  settings: z.object({ id: z.string(), updatedAt: z.string(), dailySummaryTime: z.string(), timezone: z.string(), schemaVersion: z.number() }).passthrough().nullable().default(null),
  subscriptions: z.array(z.object({ endpoint: z.string(), keys: z.object({ auth: z.string().optional(), p256dh: z.string().optional() }).optional(), appUrl: z.string().optional() })).default([]),
  notificationClaims: z.record(z.string(), z.string()).default({})
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
      const lockAge = await stat(lockPath).then(value => Date.now() - value.mtimeMs).catch(() => 0)
      if (lockAge > 30_000) { await unlink(lockPath).catch(() => undefined); continue }
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
  cloudbaseDatabase ??= import('@cloudbase/js-sdk').then(({ default: cloudbase }) => cloudbase.init({ env: config.CLOUDBASE_ENV_ID, region: config.CLOUDBASE_REGION }).database())
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
const read = () => config.STORAGE_ADAPTER === 'cloudbase' ? readCloudbaseData() : readFileData()
const mutate = <T>(fn: (data: CloudData) => T | Promise<T>) => config.STORAGE_ADAPTER === 'cloudbase' ? mutateCloudbase(fn) : mutateFile(fn)

export const cloudStore = {
  read,
  async merge(changes: Array<{ entity: 'task'|'draft'|'settings'; value: StoredEntity }>) {
    return mutate(data => { for (const change of changes) { if (change.entity === 'settings') { if (!data.settings || change.value.updatedAt > data.settings.updatedAt) data.settings = change.value as StoredSettings; continue } const collection = change.entity === 'task' ? data.tasks : data.drafts; const index = collection.findIndex(item => item.id === change.value.id); if (index < 0) collection.push(change.value); else if (change.value.updatedAt > collection[index].updatedAt) collection[index] = change.value } return { tasks: data.tasks, drafts: data.drafts, settings: data.settings } })
  },
  async addSubscription(subscription: PushRecord) { return mutate(data => { const index = data.subscriptions.findIndex(item => item.endpoint === subscription.endpoint); if (index < 0) data.subscriptions.push(subscription); else data.subscriptions[index] = subscription }) },
  async removeSubscription(endpoint: string) { return mutate(data => { data.subscriptions = data.subscriptions.filter(item => item.endpoint !== endpoint) }) },
  async claimNotification(key: string, now = new Date()) { return mutate(data => { const cutoff = now.getTime() - 2 * 86400000; data.notificationClaims = Object.fromEntries(Object.entries(data.notificationClaims).filter(([, value]) => Date.parse(value) >= cutoff)); if (data.notificationClaims[key]) return false; data.notificationClaims[key] = now.toISOString(); return true }) },
  async releaseNotification(key: string) { return mutate(data => { delete data.notificationClaims[key] }) },
  async purgeExpiredTombstones(now = new Date()) { const cutoff = now.getTime() - 30 * 86400000; return mutate(data => { data.tasks = data.tasks.filter(task => !task.deletedAt || Date.parse(task.deletedAt) >= cutoff); data.drafts = data.drafts.filter(draft => !draft.deletedAt || Date.parse(draft.deletedAt) >= cutoff) }) }
}
