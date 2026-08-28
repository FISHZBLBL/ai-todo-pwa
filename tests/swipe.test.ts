import { describe, expect, it } from 'vitest'
import { resolveSwipeReveal } from '../src/utils/swipe'

describe('任务滑动防误触', () => {
  it('轻微横向移动和主要为纵向滚动时不显示操作', () => {
    expect(resolveSwipeReveal(40, 0)).toBeNull()
    expect(resolveSwipeReveal(70, 60)).toBeNull()
  })

  it('明确滑动只显示操作，不直接完成或删除', () => {
    expect(resolveSwipeReveal(70, 5)).toBe('complete')
    expect(resolveSwipeReveal(-70, 5)).toBe('delete')
  })

  it('已完成列表禁止再次右滑完成', () => {
    expect(resolveSwipeReveal(70, 0, false)).toBeNull()
  })
})
