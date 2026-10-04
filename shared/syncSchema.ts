import { z } from 'zod'
import { INPUT_LIMITS as limits, jsonBytes, MAX_SYNC_ENTITY_BYTES } from './limits.js'

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
}, '日期无效')
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString())
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, '时区无效')
const recurrence = z.object({
  unit: z.enum(['day', 'week']), interval: z.number().int().min(1).max(365),
  end: z.enum(['never', 'count', 'date']), count: z.number().int().min(1).max(365).nullable(),
  until: isoDateSchema.nullable(), occurrence: z.number().int().min(1), timezone, countdown: z.boolean()
}).refine(value => value.end !== 'count' || value.count != null, '请填写重复次数')
  .refine(value => value.end !== 'date' || value.until != null, '请填写结束日期')
const reminder = z.object({
  id: z.string().min(1).max(100), at: timestamp, eventId: z.string().nullable().default(null),
  sentAt: timestamp.nullable().default(null), source: z.enum(['auto', 'explicit']), recurrence: recurrence.nullable().optional()
})
const checklist = z.object({ sections: z.array(z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(limits.checklistSectionTitle),
  note: z.string().max(limits.checklistNote).nullable().optional(),
  items: z.array(z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(limits.checklistText),
    completed: z.boolean(), completedAt: timestamp.nullable().optional() })).max(limits.checklistItems)
})).max(limits.checklistSections) })

function withinSize<T extends z.ZodType>(schema: T) {
  return schema.refine(value => jsonBytes(value) <= MAX_SYNC_ENTITY_BYTES, '内容过大，请拆分为较小的记录')
}

export const taskValueSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value
  const raw = value as Record<string, unknown>
  const dueDate = raw.dueDate ?? raw.date ?? null
  const startTime = raw.startTime ?? raw.time ?? null
  const automaticAt = typeof dueDate === 'string' && typeof startTime === 'string' ? new Date(`${dueDate}T${startTime}:00`).getTime() : NaN
  const legacyMode = raw.reminderEnabled === true && typeof raw.reminderAt === 'string'
    ? (Number.isFinite(automaticAt) && automaticAt === Date.parse(raw.reminderAt) ? 'auto' : 'explicit') : 'off'
  const legacyReminders = raw.reminderEnabled === true && typeof raw.reminderAt === 'string'
    ? [{ id: 'legacy', at: raw.reminderAt, eventId: raw.reminderEventId ?? null, sentAt: raw.reminderSentAt ?? null, source: (raw.reminderMode ?? legacyMode) === 'auto' ? 'auto' : 'explicit' }] : []
  const reminders = Array.isArray(raw.reminders) ? raw.reminders : legacyReminders
  return { ...raw, dueDate, startTime, reminderMode: raw.reminderMode ?? (Array.isArray(raw.reminders) ? (reminders.length ? (reminders[0]?.source === 'auto' ? 'auto' : 'explicit') : 'off') : legacyMode), reminders }
}, withinSize(z.object({
  id: z.string().uuid(), kind: z.enum(['task', 'checklist']).optional(), title: z.string().trim().min(1).max(limits.taskTitle),
  note: z.string().max(limits.taskNote).nullable().optional(), url: z.string().url().max(4000).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(), dateRange: z.object({ start: isoDateSchema, end: isoDateSchema }).nullable().optional(),
  startTime: clockTimeSchema.nullable().optional(), endTime: clockTimeSchema.nullable().optional(),
  reminderMode: z.enum(['auto', 'explicit', 'off']), reminders: z.array(reminder).max(limits.reminders).default([]),
  pinned: z.boolean(), sortOrder: z.number().finite().nullable().optional(), completed: z.boolean(),
  completedAt: timestamp.nullable().optional(), createdAt: timestamp, updatedAt: timestamp,
  deletedAt: timestamp.nullable().optional(), recurrence: z.null().optional(), source: z.enum(['manual', 'ai']),
  checklist: checklist.nullable().optional()
}).refine(value => !value.dateRange || value.dateRange.start <= value.dateRange.end, '日期范围无效')
  .refine(value => !(value.dueDate && value.dateRange), '日期与范围不能同时设置')
  .refine(value => !value.startTime || Boolean(value.dueDate), '开始时间需要日期')
  .refine(value => !value.endTime || Boolean(value.startTime), '结束时间需要开始时间')))

export const draftValueSchema = withinSize(z.object({
  id: z.string().uuid(), content: z.string().max(limits.draftContent), createdAt: timestamp, updatedAt: timestamp,
  aiParseStatus: z.enum(['idle', 'parsing', 'failed', 'parsed']), lastError: z.string().nullable().optional(), deletedAt: timestamp.nullable().optional()
}))
export const profileValueSchema = withinSize(z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(limits.profileTitle).nullable(),
  content: z.string().min(1).max(limits.profileContent), createdAt: timestamp, updatedAt: timestamp, deletedAt: timestamp.nullable().optional()
}))
export const settingsValueSchema = withinSize(z.object({
  id: z.literal('settings'), dailySummaryTime: clockTimeSchema, timezone, schemaVersion: z.number().int().positive(),
  updatedAt: timestamp, lastSyncAt: timestamp.nullable().optional(),
  notificationPermission: z.enum(['default', 'denied', 'granted', 'unsupported']).optional()
}))
export const syncChangeSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('task'), value: taskValueSchema }),
  z.object({ entity: z.literal('draft'), value: draftValueSchema }),
  z.object({ entity: z.literal('profile'), value: profileValueSchema }),
  z.object({ entity: z.literal('settings'), value: settingsValueSchema })
])

export function validationMessage(error: z.ZodError) {
  const issue = error.issues[0]
  return issue ? `内容无法保存：${issue.path.join('.') || '记录'} ${issue.message}` : '内容格式无效'
}
