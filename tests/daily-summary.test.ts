import { beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.fn()
const purgeExpiredTombstones = vi.fn()
const claimDailySummary = vi.fn()
const releaseDailySummary = vi.fn()
vi.mock('../server/storage', () => ({ cloudStore: { read, purgeExpiredTombstones, claimDailySummary, releaseDailySummary } }))

const today = '2026-09-03'
const data = (tasks: import('../server/push').DailyDigestTask[]) => ({ tasks, settings: { timezone: 'Asia/Shanghai' } })

describe('每日汇总内容与去重', () => {
  beforeEach(() => { read.mockReset(); purgeExpiredTombstones.mockReset(); claimDailySummary.mockReset(); releaseDailySummary.mockReset(); purgeExpiredTombstones.mockResolvedValue(undefined) })

  it('包含今天、逾期和当天 dateRange 内的未完成任务', async () => {
    const { buildDailyDigest } = await import('../server/push')
    const digest = buildDailyDigest(data([
      { id: 'overdue', title: '写作业', dueDate: '2026-09-02', completed: false, deletedAt: null },
      { id: 'today', title: '手机贴膜', dueDate: today, completed: false, deletedAt: null },
      { id: 'range', title: '整理旅行计划', dateRange: { start: '2026-09-01', end: '2026-09-05' }, completed: false, deletedAt: null },
      { id: 'done', title: '已完成', dueDate: today, completed: true, deletedAt: null },
      { id: 'deleted', title: '已删除', dueDate: today, completed: false, deletedAt: today }
    ]), new Date('2026-09-03T01:00:00.000Z'))
    expect(digest?.body).toContain('逾期：\n• 写作业')
    expect(digest?.body).toContain('今天：\n• 手机贴膜\n• 整理旅行计划')
    expect(digest?.body).not.toContain('已完成')
    expect(digest?.body).not.toContain('已删除')
  })

  it('同一天已发送后新增任务不会补发', async () => {
    const state = data([{ id: 'today', title: '写作业', dueDate: today, completed: false, deletedAt: null }])
    read.mockResolvedValue(state)
    let claimed = false
    claimDailySummary.mockImplementation(async () => { if (claimed) return false; claimed = true; return true })
    const sender = vi.fn(async () => ({ sent: 1, failed: 0, subscriptions: 1 }))
    const { sendDailySummary } = await import('../server/push')
    await sendDailySummary(new Date('2026-09-03T01:00:00.000Z'), sender)
    state.tasks.push({ id: 'late', title: '下午新增', dueDate: today, completed: false, deletedAt: null })
    await sendDailySummary(new Date('2026-09-03T06:00:00.000Z'), sender)
    expect(sender).toHaveBeenCalledOnce()
  })

  it('空任务不发送通知', async () => {
    read.mockResolvedValue(data([]))
    const sender = vi.fn(async () => ({ sent: 1, failed: 0, subscriptions: 1 }))
    const { sendDailySummary } = await import('../server/push')
    await expect(sendDailySummary(new Date('2026-09-03T01:00:00.000Z'), sender)).resolves.toMatchObject({ skipped: 'empty' })
    expect(sender).not.toHaveBeenCalled()
    expect(claimDailySummary).not.toHaveBeenCalled()
  })
})
