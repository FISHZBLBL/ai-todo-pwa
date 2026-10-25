import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorDoNotRetry, ErrorRetryAfterDelay } from '../server/reminders/workflow'

describe('提醒工作流协议', () => {
  it.each([[2500, 2500], ['1m', 60_000], ['2s', 2000], ['1.5h', 5_400_000], ['1d', 86_400_000], ['25ms', 25]])('将 %s 转为毫秒', (retryDelay, milliseconds) => {
    const error = new ErrorRetryAfterDelay({ message: '等待恢复', retryDelay })
    expect(error.message).toBe('等待恢复')
    expect(error.retryDelayMs).toBe(milliseconds)
    expect(error.forceDelayTime).toBe(false)
  })

  it.each([0, -1, Infinity, NaN, '0s', '-1m', '1 minute', 'invalid'])('拒绝无效间隔 %s', retryDelay => {
    expect(() => new ErrorRetryAfterDelay({ message: '等待恢复', retryDelay })).toThrow(RangeError)
  })

  it('保留强制延迟和不可重试错误语义', () => {
    expect(new ErrorRetryAfterDelay({ message: '未到时间', retryDelay: 60_000, forceDelayTime: true }).forceDelayTime).toBe(true)
    expect(new ErrorDoNotRetry('无订阅')).toMatchObject({ name: 'ErrorDoNotRetry', message: '无订阅' })
  })

  it.each(['todo-reminder', 'daily-summary', 'reminder-maintenance'])('%s 旧入口已停用且不再声明定时或队列任务', async name => {
    const module = name === 'todo-reminder' ? await import('../netlify/functions/todo-reminder')
      : name === 'daily-summary' ? await import('../netlify/functions/daily-summary')
        : await import('../netlify/functions/reminder-maintenance')
    expect((await module.default()).status).toBe(410)
    expect(module).not.toHaveProperty('config')
    expect(module).not.toHaveProperty('asyncWorkloadConfig')
    const source = await readFile(resolve('netlify/functions', `${name}.ts`), 'utf8')
    expect(source).not.toMatch(/@netlify\/async-workloads|asyncWorkloadFn|schedule\s*:/)
  })
})
