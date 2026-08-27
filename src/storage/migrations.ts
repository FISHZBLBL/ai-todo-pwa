import { z } from 'zod'
import type { TodoExport } from '../types'
import { SCHEMA_VERSION } from './database'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const taskSchema = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(240), note: z.string().nullable().optional(), url: z.string().url().nullable().optional(),
  date: date.nullable().optional(), dateRange: z.object({ start: date, end: date }).nullable().optional(), time: time.nullable().optional(), endTime: time.nullable().optional(),
  pinned: z.boolean(), completed: z.boolean(), completedAt: z.string().nullable().optional(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional(), source: z.enum(['manual','ai'])
}).passthrough()
const draftSchema = z.object({ id: z.string().uuid(), content: z.string(), createdAt: z.string(), updatedAt: z.string(), aiParseStatus: z.enum(['idle','parsing','failed','parsed']), lastError: z.string().nullable().optional(), deletedAt: z.string().nullable().optional() }).passthrough()
const envelopeSchema = z.object({ schemaVersion: z.number().int().positive(), exportedAt: z.string().optional(), tasks: z.array(z.unknown()).default([]), drafts: z.array(z.unknown()).default([]), settings: z.record(z.string(), z.unknown()).optional() })

type Migration = (value: z.infer<typeof envelopeSchema>) => TodoExport
const migrations: Record<number, Migration> = {
  1(value) {
    const now = new Date().toISOString(), rawSettings = value.settings ?? {}
    return {
      schemaVersion: 1,
      exportedAt: value.exportedAt ?? now,
      tasks: z.array(taskSchema).parse(value.tasks) as TodoExport['tasks'],
      drafts: z.array(draftSchema).parse(value.drafts) as TodoExport['drafts'],
      settings: {
        id: 'settings',
        dailySummaryTime: typeof rawSettings.dailySummaryTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawSettings.dailySummaryTime) ? rawSettings.dailySummaryTime : '08:00',
        timezone: typeof rawSettings.timezone === 'string' ? rawSettings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
        schemaVersion: 1,
        updatedAt: typeof rawSettings.updatedAt === 'string' ? rawSettings.updatedAt : now,
        lastSyncAt: typeof rawSettings.lastSyncAt === 'string' ? rawSettings.lastSyncAt : null
      }
    }
  }
}

export function migrateExport(input: unknown): TodoExport {
  const envelope = envelopeSchema.parse(input)
  if (envelope.schemaVersion > SCHEMA_VERSION || !migrations[envelope.schemaVersion]) throw new Error('不支持的备份版本')
  let migrated = migrations[envelope.schemaVersion](envelope)
  while (migrated.schemaVersion < SCHEMA_VERSION) {
    const next = migrations[migrated.schemaVersion + 1]
    if (!next) throw new Error(`缺少 v${migrated.schemaVersion + 1} migration`)
    migrated = next(envelope)
  }
  return migrated
}
