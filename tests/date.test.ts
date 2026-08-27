import { describe, expect, it } from 'vitest'
import { parseNaturalTask } from '../src/utils/date'

const now = new Date('2026-08-27T10:00:00+08:00')
describe('自然语言日期解析', () => {
  it.each([
    ['今天看论文', '2026-08-27'], ['明天看论文', '2026-08-28'], ['后天看论文', '2026-08-29']
  ])('%s', (input, expected) => expect(parseNaturalTask(input, now).date).toBe(expected))
  it('下周解析为下一自然周周一至周五', () => expect(parseNaturalTask('下周整理数据', now).dateRange).toEqual({ start: '2026-08-31', end: '2026-09-04' }))
  it('周末解析为周六至周日', () => expect(parseNaturalTask('周末收拾屋子', now).dateRange).toEqual({ start: '2026-08-29', end: '2026-08-30' }))
  it('明确时间才产生 time', () => expect(parseNaturalTask('明天下午三点测器件', now)).toMatchObject({ date: '2026-08-28', time: '15:00', title: '测器件' }))
  it('模糊时段不产生 time', () => expect(parseNaturalTask('明天上午测器件', now)).toMatchObject({ date: '2026-08-28', time: null, title: '上午测器件' }))
  it('解析结束时间', () => expect(parseNaturalTask('明天下午三点到五点测器件', now)).toMatchObject({ time: '15:00', endTime: '17:00', title: '测器件' }))
  it('无日期任务保持无日期', () => expect(parseNaturalTask('有空看看视频', now)).toMatchObject({ date: null, dateRange: null, time: null }))
  it('提取 URL', () => expect(parseNaturalTask('看看 https://example.com 文档', now).url).toBe('https://example.com'))
})
