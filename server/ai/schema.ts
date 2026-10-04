import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const parsedRecurrenceSchema = z.object({
  unit: z.enum(['day', 'week']),
  interval: z.number().int().min(1).max(365),
  end: z.enum(['never', 'count', 'date']),
  count: z.number().int().min(1).max(365).nullable().default(null),
  until: isoDate.nullable().default(null),
  countdown: z.boolean().default(false)
}).superRefine((value, context) => {
  if (value.end === 'count' && value.count == null) context.addIssue({ code: 'custom', message: '按次数结束必须提供 count', path: ['count'] })
  if (value.end === 'date' && value.until == null) context.addIssue({ code: 'custom', message: '按日期结束必须提供 until', path: ['until'] })
})
export const parsedReminderSchema = z.object({
  requested: z.literal(true),
  date: isoDate.nullable().default(null),
  time: clockTime.nullable().default(null),
  period: z.enum(['morning', 'noon', 'afternoon', 'evening', 'night']).nullable().default(null),
  recurrence: parsedRecurrenceSchema.nullable().default(null)
}).superRefine((value, context) => {
  if (value.date && value.recurrence?.end === 'date' && value.recurrence.until && value.recurrence.until < value.date) {
    context.addIssue({ code: 'custom', message: '结束日期不能早于首次提醒日期', path: ['recurrence', 'until'] })
  }
})

export const parsedTaskSchema = z.object({
  kind: z.literal('task').optional(),
  title: z.string().min(1).max(240),
  dueDate: isoDate.nullable().default(null),
  dateRange: z.object({ start: isoDate, end: isoDate }).nullable().default(null),
  startTime: clockTime.nullable().default(null),
  endTime: clockTime.nullable().default(null),
  url: z.string().url().nullable().default(null),
  reminders: z.array(parsedReminderSchema).max(8).default([])
}).refine(value => !(value.dueDate && value.dateRange), 'dueDate 与 dateRange 不能同时存在').refine(value => !value.startTime || Boolean(value.dueDate), '明确时间必须有明确日期').refine(value => !value.endTime || Boolean(value.startTime), '结束时间必须有开始时间')
export const parsedChecklistSchema = z.object({
  kind: z.literal('checklist'),
  title: z.string().min(1).max(240),
  dueDate: z.null().default(null),
  dateRange: z.null().default(null),
  startTime: z.null().default(null),
  endTime: z.null().default(null),
  url: z.null().default(null),
  reminders: z.array(parsedReminderSchema).max(0).default([]),
  sections: z.array(z.object({
    title: z.string().min(1).max(120),
    note: z.string().max(2000).nullable().default(null),
    items: z.array(z.object({ text: z.string().min(1).max(500) })).min(1).max(200)
  })).min(1).max(30)
})
export const parsedInboxItemSchema = z.union([parsedChecklistSchema, parsedTaskSchema])
export const aiResultSchema = z.object({ tasks: z.array(parsedInboxItemSchema).min(1).max(50) })
export type AIResult = z.infer<typeof aiResultSchema>
