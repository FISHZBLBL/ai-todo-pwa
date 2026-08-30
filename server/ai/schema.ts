import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const parsedReminderSchema = z.object({
  requested: z.literal(true),
  date: isoDate.nullable().default(null),
  time: clockTime.nullable().default(null),
  period: z.enum(['morning', 'noon', 'afternoon', 'evening', 'night']).nullable().default(null)
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
