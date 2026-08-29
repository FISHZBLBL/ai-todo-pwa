import { describe, expect, it } from 'vitest'
import { aiResultSchema } from '../server/ai/schema'

describe('AI 输出校验', () => {
  it('接受严格结构化任务', () => expect(aiResultSchema.parse({ tasks: [{ title:'测器件', dueDate:'2026-08-28', dateRange:null, startTime:'15:00', endTime:null, url:null, reminder:null }] }).tasks).toHaveLength(1))
  it('拒绝非法 JSON 结构', () => expect(() => aiResultSchema.parse({ tasks: [{ title:'', dueDate:'明天', startTime:'下午' }] })).toThrow())
  it('拒绝 AI 猜测时间但没有日期', () => expect(() => aiResultSchema.parse({ tasks: [{ title:'任务', dueDate:null, dateRange:null, startTime:'08:00', endTime:null, url:null }] })).toThrow())
})
