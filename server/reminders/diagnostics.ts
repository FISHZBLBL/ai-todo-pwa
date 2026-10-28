import { CosOperationError } from '../cos.js'
import { AlarmRequestError } from './alarmClient.js'

/** Administrative diagnostics contain codes only, never exception text or data. */
export function reminderFailureDiagnostic(error: unknown) {
  if (error instanceof CosOperationError) return { code: 'cos_request_failed', operation: error.operation, upstreamStatus: error.httpStatus, serviceCode: error.serviceCode }
  if (error instanceof AlarmRequestError) return { code: 'scheduler_request_failed', upstreamStatus: error.status }
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('COS 安全写入需要从未开启版本控制')) return { code: 'cos_unsafe_versioning' }
  if (message.startsWith('无法确认 COS 存储桶的版本控制状态')) return { code: 'cos_versioning_unverified' }
  if (message.startsWith('COS 状态文件已被锁定')) return { code: 'cos_state_locked' }
  if (message.startsWith('连接腾讯 COS 超时')) return { code: 'cos_timeout' }
  if (message.startsWith('连接腾讯 COS 失败')) return { code: 'cos_connection_failed' }
  return { code: 'reminder_operation_failed' }
}
