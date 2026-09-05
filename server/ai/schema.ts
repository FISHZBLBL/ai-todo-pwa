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
  title: z.string().min(1).max(240),
  dueDate: isoDate.nullable().default(null),
  dateRange: z.object({ start: isoDate, end: isoDate }).nullable().default(null),
  startTime: clockTime.nullable().default(null),
  endTime: clockTime.nullable().default(null),
  url: z.string().url().nullable().default(null),
  reminders: z.array(parsedReminderSchema).max(8).default([])
}).refine(value => !(value.dueDate && value.dateRange), 'dueDate 与 dateRange 不能同时存在').refine(value => !value.startTime || Boolean(value.dueDate), '明确时间必须有明确日期').refine(value => !value.endTime || Boolean(value.startTime), '结束时间必须有开始时间')
export const aiResultSchema = z.object({ tasks: z.array(parsedTaskSchema).min(1).max(50) })
export type AIResult = z.infer<typeof aiResultSchema>
