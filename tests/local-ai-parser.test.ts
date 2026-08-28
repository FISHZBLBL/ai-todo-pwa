import { describe, expect, it } from 'vitest'
import { parseLocalInbox } from '../src/ai/localParser'

const now = new Date('2026-08-27T10:00:00+08:00')
describe('本地 AI 失败兜底解析', () => {
  it('拆分多个任务', () => expect(parseLocalInbox('买牙膏，整理桌面', now).map(item => item.title)).toEqual(['买牙膏', '整理桌面']))
  it('继承并列上下文中的日期但不创造具体时间', () => {
    const tasks = parseLocalInbox('明天下午去实验室，测器件，整理数据，晚上买菜', now)
    expect(tasks.map(item => item.dueDate)).toEqual(['2026-08-28', '2026-08-28', '2026-08-28', '2026-08-28'])
    expect(tasks.every(item => item.startTime === null)).toBe(true)
    expect(tasks[0].title).toBe('下午去实验室')
  })
  it('新的日期范围替换继承上下文', () => { const tasks = parseLocalInbox('明天看论文，周末收拾屋子，买菜', now); expect(tasks[0].dueDate).toBe('2026-08-28'); expect(tasks[1].dateRange).toEqual({ start:'2026-08-29', end:'2026-08-30' }); expect(tasks[2].dateRange).toEqual(tasks[1].dateRange) })
  it('识别 URL', () => expect(parseLocalInbox('看看 https://example.com/docs', now)[0].url).toBe('https://example.com/docs'))
})
