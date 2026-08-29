import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const parsedReminderSchema = z.object({
  requested: z.literal(true),
  date: isoDate.nullable(),
  time: clockTime.nullable(),
  period: z.enum(['morning', 'noon', 'afternoon', 'evening', 'night']).nullable()
})

export const parsedTaskSchema = z.object({
  title: z.string().min(1).max(240),
  dueDate: isoDate.nullable(),
  dateRange: z.object({ start: isoDate, end: isoDate }).nullable(),
  startTime: clockTime.nullable(),
  endTime: clockTime.nullable(),
  url: z.string().url().nullable(),
  reminders: z.array(parsedReminderSchema).max(8).default([]),
  reminder: parsedReminderSchema.nullable().optional()
}).refine(value => !(value.dueDate && value.dateRange), 'dueDate 与 dateRange 不能同时存在').refine(value => !value.startTime || Boolean(value.dueDate), '明确时间必须有明确日期').refine(value => !value.endTime || Boolean(value.startTime), '结束时间必须有开始时间')
export const aiResultSchema = z.object({ tasks: z.array(parsedTaskSchema).min(1).max(50) })
export type AIResult = z.infer<typeof aiResultSchema>
