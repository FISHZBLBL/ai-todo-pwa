import { describe, expect, it } from 'vitest'
import { extractFirstUrl } from '../src/utils/url'

describe('URL 自动识别', () => {
  it('从中文任务标题提取 HTTPS URL', () => expect(extractFirstUrl('看看 https://example.com/docs，明天处理')).toBe('https://example.com/docs'))
  it('没有 URL 时返回 null', () => expect(extractFirstUrl('买牙膏')).toBeNull())
})
