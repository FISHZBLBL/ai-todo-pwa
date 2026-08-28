import { z } from 'zod'
import type { TodoExport } from '../types'
import { SCHEMA_VERSION } from './database'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const taskSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object') return input
  const { date: legacyDate, time: legacyTime, ...rest } = input as Record<string, unknown>
  return {
    ...rest,
    dueDate: rest.dueDate ?? legacyDate ?? null,
    startTime: rest.startTime ?? legacyTime ?? null,
    reminderEnabled: rest.reminderEnabled ?? false,
    reminderAt: rest.reminderAt ?? null,
    reminderEventId: rest.reminderEventId ?? null,
    reminderSentAt: rest.reminderSentAt ?? null
  }
}, z.object({
  id: z.string().uuid(), title: z.string().min(1).max(240), note: z.string().nullable().optional(), url: z.string().url().nullable().optional(),
  dueDate: date.nullable().optional(), dateRange: z.object({ start: date, end: date }).nullable().optional(), startTime: time.nullable().optional(), endTime: time.nullable().optional(),
  reminderEnabled: z.boolean().default(false), reminderAt: z.string().datetime({ offset: true }).nullable().optional(), reminderEventId: z.string().nullable().optional(), reminderSentAt: z.string().datetime({ offset: true }).nullable().optional(),
  pinned: z.boolean(), completed: z.boolean(), completedAt: z.string().nullable().optional(), createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable().optional(), recurrence: z.null().optional(), source: z.enum(['manual','ai'])
}).passthrough())
const draftSchema = z.object({ id: z.string().uuid(), content: z.string(), createdAt: z.string(), updatedAt: z.string(), aiParseStatus: z.enum(['idle','parsing','failed','parsed']), lastError: z.string().nullable().optional(), deletedAt: z.string().nullable().optional() }).passthrough()
const envelopeSchema = z.object({ schemaVersion: z.number().int().positive(), exportedAt: z.string().optional(), tasks: z.array(z.unknown()).default([]), drafts: z.array(z.unknown()).default([]), settings: z.record(z.string(), z.unknown()).optional() })

function normalizeEnvelope(value: z.infer<typeof envelopeSchema>): TodoExport {
    const now = new Date().toISOString(), rawSettings = value.settings ?? {}
    return {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: value.exportedAt ?? now,
      tasks: z.array(taskSchema).parse(value.tasks) as TodoExport['tasks'],
      drafts: z.array(draftSchema).parse(value.drafts) as TodoExport['drafts'],
      settings: {
        id: 'settings',
        dailySummaryTime: typeof rawSettings.dailySummaryTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(rawSettings.dailySummaryTime) ? rawSettings.dailySummaryTime : '08:00',
        timezone: typeof rawSettings.timezone === 'string' ? rawSettings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: typeof rawSettings.updatedAt === 'string' ? rawSettings.updatedAt : now,
        lastSyncAt: typeof rawSettings.lastSyncAt === 'string' ? rawSettings.lastSyncAt : null
      }
    }
}

export function migrateExport(input: unknown): TodoExport {
  const envelope = envelopeSchema.parse(input)
  if (envelope.schemaVersion < 1 || envelope.schemaVersion > SCHEMA_VERSION) throw new Error('不支持的备份版本')
  return normalizeEnvelope(envelope)
}
