import { config } from '../config.js'
import { z } from 'zod'
import type { AIResult } from './schema.js'
import { describeSchemaError, parseAIResponse } from './response.js'
import { AI_SYSTEM_PROMPT } from './systemPrompt.js'
import { cloudStore } from '../storage.js'
import { decryptDeepseekApiKey } from '../secrets.js'

export interface ParseContext { content: string; currentLocalDateTime: string; timezone: string; locale: string }
export interface AIProvider { parse(context: ParseContext, options?: { jsonMode?: boolean }): Promise<AIResult> }
export class AIEmptyResponseError extends Error {}
export class AIJsonSyntaxError extends Error {}
export class AISchemaError extends Error {}
export class AIProviderHttpError extends Error {}
export class AIJsonModeError extends AIProviderHttpError {}

function parseProviderContent(content: string): AIResult {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(cleaned)
  } catch {
    throw new AIJsonSyntaxError('AI 返回的内容不是有效 JSON，请重试')
  }
  try {
    return parseAIResponse(json)
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[ai-schema]', describeSchemaError(error, json))
      throw new AISchemaError('AI 返回格式不符合要求，请重试')
    }
    throw error
  }
}

async function jsonModeUnsupported(response: Response) {
  if (response.status !== 400 && response.status !== 422) return false
  try {
    const details = await response.text()
    return /response[_ -]?format|json[_ -]?object|json mode/i.test(details) && /unsupported|not support|unknown|invalid/i.test(details)
  } catch {
    return false
  }
}

class OpenAICompatibleProvider implements AIProvider {
  constructor(private readonly apiKey = config.AI_API_KEY) {}

  async parse(context: ParseContext, options: { jsonMode?: boolean } = {}): Promise<AIResult> {
    if (!this.apiKey) throw new Error('AI 服务未配置')
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 18000)
    try {
      const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.AI_MODEL, temperature: 0, ...(options.jsonMode === false ? {} : { response_format: { type: 'json_object' } }), messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(context) }] })
      })
      if (!response.ok) {
        if (options.jsonMode !== false && await jsonModeUnsupported(response)) throw new AIJsonModeError('当前 Provider 不支持 JSON mode')
        throw new AIProviderHttpError(`AI Provider 返回 ${response.status}`)
      }
      let body: { choices?: Array<{ message?: { content?: string } }> }
      try {
        body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      } catch {
        throw new AIProviderHttpError('AI Provider 响应无法解析')
      }
      const content = body.choices?.[0]?.message?.content
      if (!content?.trim()) throw new AIEmptyResponseError('AI 返回为空，请重试')
      return parseProviderContent(content)
    } catch (error) { if (controller.signal.aborted) throw new Error('AI 请求超时'); throw error }
    finally { clearTimeout(timeout) }
  }
}

export function createAIProvider(apiKey?: string): AIProvider { return new OpenAICompatibleProvider(apiKey) }
export async function resolveDeepseekApiKey() {
  const stored = await cloudStore.getDeepseekSecret()
  return stored ? decryptDeepseekApiKey(stored) : config.AI_API_KEY
}
export async function verifyDeepseekApiKey(apiKey: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    if (response.status === 401 || response.status === 403) throw new Error('DeepSeek API Key 无效或已被撤销')
    if (!response.ok) throw new Error(`DeepSeek 验证失败 (${response.status})`)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('DeepSeek 验证超时，请稍后再试')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
export async function parseWithRetry(context: ParseContext) {
  const provider = createAIProvider(await resolveDeepseekApiKey())
  try { return await provider.parse(context, { jsonMode: true }) } catch (first) {
    if (!(first instanceof AIJsonModeError)) throw first
    try { return await provider.parse(context, { jsonMode: false }) }
    catch { throw first }
  }
}
