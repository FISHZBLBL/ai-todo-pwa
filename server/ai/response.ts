import { z } from 'zod'
import { aiResultSchema, type AIResult } from './schema.js'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeReminder(value: unknown): unknown {
  if (!isObject(value)) return value
  // "weekend"/“周末” describes a date, never a time-of-day period. DeepSeek
  // occasionally puts it in period even when it has already resolved the date.
  // Clearing only this known category error is safe; other invalid periods still
  // fail schema validation instead of being silently accepted.
  return value.period === 'weekend' || value.period === '周末'
    ? { ...value, period: null }
    : value
}

function normalizeTask(value: unknown): unknown {
  if (!isObject(value)) return value
  const { reminder, reminders, ...task } = value
  if (Array.isArray(reminders)) return { ...task, reminders: reminders.map(normalizeReminder) }
  if (isObject(reminder)) return { ...task, reminders: [normalizeReminder(reminder)] }
  return task
}

export function normalizeAIResponse(value: unknown): unknown {
  if (Array.isArray(value)) return { tasks: value.map(normalizeTask) }
  if (!isObject(value)) return value
  if (Array.isArray(value.tasks)) return { ...value, tasks: value.tasks.map(normalizeTask) }
  if (typeof value.title === 'string') return { tasks: [normalizeTask(value)] }
  return value
}

export function parseAIResponse(value: unknown): AIResult {
  return aiResultSchema.parse(normalizeAIResponse(value))
}

export function describeSchemaError(error: z.ZodError, value: unknown) {
  const normalized = normalizeAIResponse(value)
  const rootType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  const taskKeys = isObject(normalized) && Array.isArray(normalized.tasks)
    ? normalized.tasks.slice(0, 5).map(task => isObject(task) ? Object.keys(task).sort() : [])
    : []
  return {
    rootType,
    taskKeys,
    issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message, code: issue.code }))
  }
}
