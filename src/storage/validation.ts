import type { ZodType } from 'zod'
import { validationMessage } from '../../shared/syncSchema'

export function validateRecord<T>(schema: ZodType, value: T): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(validationMessage(result.error))
  return result.data as T
}

export function nextTimestamp(previous?: string) {
  const previousTime = previous ? Date.parse(previous) : NaN
  return new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString()
}
