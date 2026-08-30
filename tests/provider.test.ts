import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const context = { content: '明天下午三点测器件', currentLocalDateTime: '2026-08-27T10:00:00+08:00', timezone: 'Asia/Shanghai', locale: 'zh-CN' }
describe('AI Provider 输出与重试策略', () => {
  beforeEach(() => { vi.resetModules(); process.env.AI_API_KEY = 'test-only'; process.env.AI_BASE_URL = 'https://ai.example.com'; process.env.AI_MODEL = 'test-model' })
  afterEach(() => { vi.restoreAllMocks(); delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL })

  it('正常解析只请求一次，并接受安全 normalization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([{ title:'测器件', dueDate:'2026-08-28', startTime:'15:00' }]) } }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).resolves.toMatchObject({ tasks: [{ title: '测器件', dateRange: null, reminders: [] }] })
    expect(fetchMock).toHaveBeenCalledOnce()
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(firstBody.messages[1].content).toBe(JSON.stringify(context))
    expect(firstBody.response_format).toEqual({ type: 'json_object' })
  })

  it('JSON 语法错误不会重复消耗请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'not-json' } }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).rejects.toThrow('不是有效 JSON')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('空响应与普通 Provider HTTP 错误分别报告且不重试', async () => {
    const emptyFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) })
    vi.stubGlobal('fetch', emptyFetch)
    let provider = await import('../server/ai/provider')
    await expect(provider.parseWithRetry(context)).rejects.toThrow('AI 返回为空，请重试')
    expect(emptyFetch).toHaveBeenCalledOnce()

    vi.resetModules()
    const httpFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    vi.stubGlobal('fetch', httpFetch)
    provider = await import('../server/ai/provider')
    await expect(provider.parseWithRetry(context)).rejects.toThrow('AI Provider 返回 429')
    expect(httpFetch).toHaveBeenCalledOnce()
  })

  it('普通 400 不是 JSON mode 不兼容，不应降级重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid request payload' })
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).rejects.toThrow('AI Provider 返回 400')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('Schema mismatch 输出安全诊断且不会重复请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: '测器件', dueDate: '明天' }] }) } }] }) })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).rejects.toThrow('AI 返回格式不符合要求，请重试')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('[ai-schema]', expect.objectContaining({ rootType: 'object', taskKeys: [expect.arrayContaining(['dueDate', 'title'])], issues: [expect.objectContaining({ path: 'tasks.0.dueDate' })] }))
  })

  it('只有 Provider 明确不支持 JSON mode 时关闭 JSON mode 重试一次', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'response_format json_object is not supported' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title:'测器件', dueDate:'2026-08-28', startTime:'15:00' }] }) } }] }) })
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).resolves.toMatchObject({ tasks: [{ title: '测器件' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format).toBeUndefined()
  })

  it('网络错误不重复请求', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const { parseWithRetry } = await import('../server/ai/provider')
    await expect(parseWithRetry(context)).rejects.toThrow('offline')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
