import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const context = { content: '明天下午三点测器件', currentLocalDateTime: '2026-08-27T10:00:00+08:00', timezone: 'Asia/Shanghai', locale: 'zh-CN' }
describe('AI Provider 重试策略', () => {
  beforeEach(() => { vi.resetModules(); process.env.AI_API_KEY = 'test-only'; process.env.AI_BASE_URL = 'https://ai.example.com'; process.env.AI_MODEL = 'test-model' })
  afterEach(() => { vi.restoreAllMocks(); delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL })
  it('非法 JSON 安全重试一次，保持原始用户内容且降级关闭 JSON mode', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'not-json' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title:'测器件', date:'2026-08-28', dateRange:null, time:'15:00', endTime:null, url:null }] }) } }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).resolves.toMatchObject({ tasks: [{ title: '测器件' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body), secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(firstBody.messages[1].content).toBe(JSON.stringify(context))
    expect(secondBody.messages[1].content).toBe(JSON.stringify(context))
    expect(firstBody.response_format).toEqual({ type: 'json_object' })
    expect(secondBody.response_format).toBeUndefined()
  })
  it('网络错误不重复请求', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).rejects.toThrow('offline')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
