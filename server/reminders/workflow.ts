export interface WorkflowEventType {
  eventName: string
  eventData: unknown
}

/** Only successful step results are durable. Throwing keeps a step retryable. */
export type WorkflowEvent<T extends WorkflowEventType = WorkflowEventType> = T & {
  eventId: string
  attempt?: number
  step: {
    run<Result>(name: string, callback: () => Result | Promise<Result>): Promise<Result>
  }
}

export class ErrorDoNotRetry extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ErrorDoNotRetry'
  }
}

function retryMilliseconds(value: number | string) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) return value
    throw new RangeError('重试间隔必须为正数')
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(value.trim())
  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const result = match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN
  if (!Number.isFinite(result) || result <= 0) throw new RangeError('重试间隔格式无效')
  return result
}

export class ErrorRetryAfterDelay extends Error {
  readonly retryDelayMs: number
  readonly forceDelayTime: boolean

  constructor(options: { message: string; retryDelay: number | string; forceDelayTime?: boolean }) {
    super(options.message)
    this.name = 'ErrorRetryAfterDelay'
    this.retryDelayMs = retryMilliseconds(options.retryDelay)
    this.forceDelayTime = options.forceDelayTime ?? false
  }
}
