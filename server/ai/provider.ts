import { config } from '../config.js'
import { aiResultSchema, type AIResult } from './schema.js'
import { AI_SYSTEM_PROMPT } from './systemPrompt.js'

export interface ParseContext { content: string; currentLocalDateTime: string; timezone: string; locale: string }
export interface AIProvider { parse(context: ParseContext, options?: { jsonMode?: boolean }): Promise<AIResult> }
class AIOutputError extends Error {}
class AIJsonModeError extends Error {}

class OpenAICompatibleProvider implements AIProvider {
  async parse(context: ParseContext, options: { jsonMode?: boolean } = {}): Promise<AIResult> {
    if (!config.AI_API_KEY) throw new Error('AI 服务未配置')
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 18000)
    try {
      const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.AI_MODEL, temperature: 0, ...(options.jsonMode === false ? {} : { response_format: { type: 'json_object' } }), messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }] })
      })
      if (!response.ok) {
        if (options.jsonMode !== false && response.status === 400) throw new AIJsonModeError('当前 Provider 不支持 JSON mode')
        throw new Error(`AI Provider 返回 ${response.status}`)
      }
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = body.choices?.[0]?.message?.content
      if (!content) throw new AIOutputError('AI 返回为空')
      try { return aiResultSchema.parse(JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''))) }
      catch { throw new AIOutputError('AI 返回的 JSON 结构无效') }
    } catch (error) { if (controller.signal.aborted) throw new Error('AI 请求超时'); throw error }
    finally { clearTimeout(timeout) }
  }
}

export function createAIProvider(): AIProvider { return new OpenAICompatibleProvider() }
export async function parseWithRetry(context: ParseContext) {
  const provider = createAIProvider()
  try { return await provider.parse(context, { jsonMode: true }) } catch (first) {
    if (!(first instanceof AIOutputError) && !(first instanceof AIJsonModeError)) throw first
    try { return await provider.parse(context, { jsonMode: false }) }
    catch { throw first }
  }
}
