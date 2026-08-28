import { z } from 'zod'

export const parsedTaskSchema = z.object({
  title: z.string().min(1).max(240),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateRange: z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  url: z.string().url().nullable()
}).refine(value => !(value.dueDate && value.dateRange), 'dueDate 与 dateRange 不能同时存在').refine(value => !value.startTime || Boolean(value.dueDate), '明确时间必须有明确日期').refine(value => !value.endTime || Boolean(value.startTime), '结束时间必须有开始时间')
export const aiResultSchema = z.object({ tasks: z.array(parsedTaskSchema).min(1).max(50) })
export type AIResult = z.infer<typeof aiResultSchema>
