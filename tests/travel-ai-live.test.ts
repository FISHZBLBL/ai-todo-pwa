/* @vitest-environment node */
import { expect, it } from 'vitest'
import { siguniangTripInput } from './fixtures/siguniang-trip'
import { parseWithRetry } from '../server/ai/provider'

// Run explicitly with DEEPSEEK_LIVE_TEST=1. It calls the configured provider.
it.skipIf(process.env.DEEPSEEK_LIVE_TEST !== '1')('turns the trip brief into one grouped checklist', async () => {
  const result = await parseWithRetry({ content: `${siguniangTripInput}\n把上面内容做成一个清单。`, currentLocalDateTime: '2037-05-01T14:35:00+08:00', timezone: 'Asia/Shanghai', locale: 'zh-CN', dailySummaryTime: '08:00' })
  expect(result.tasks).toHaveLength(1)
  const checklist = result.tasks[0]
  expect(checklist.kind).toBe('checklist')
  if (checklist.kind !== 'checklist') return
  expect(checklist.sections).toHaveLength(4)
  const items = checklist.sections.flatMap(section => section.items.map(item => item.text))
  expect(items).toHaveLength(32)
  expect(items.some(text => text.includes('雨壳/冲锋衣'))).toBe(true)
  expect(items.some(text => text.includes('便携式氧气瓶/氧气罐') && text.includes('2～3瓶'))).toBe(true)
  expect(items.some(text => text.includes('5/7 成都→四姑娘山车票'))).toBe(true)
  expect(items.some(text => text.includes('三沟门票预约'))).toBe(true)
  expect(items.some(text => /氧气袋|新镜头|赤道仪/.test(text))).toBe(false)
}, 30000)
