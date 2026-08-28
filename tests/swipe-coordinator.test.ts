import { afterEach, describe, expect, it } from 'vitest'
import { listenForSwipeClose, requestCloseSwipeActions } from '../src/utils/swipeCoordinator'

describe('滑动操作协调', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

  it('点击任务列表空白处时收起所有已滑开的任务', () => {
    const closed: string[] = []
    cleanups.push(listenForSwipeClose('task-a', () => closed.push('task-a')))
    cleanups.push(listenForSwipeClose('task-b', () => closed.push('task-b')))
    requestCloseSwipeActions()
    expect(closed).toEqual(['task-a', 'task-b'])
  })

  it('开始滑动新任务时只收起其他任务', () => {
    const closed: string[] = []
    cleanups.push(listenForSwipeClose('task-a', () => closed.push('task-a')))
    cleanups.push(listenForSwipeClose('task-b', () => closed.push('task-b')))
    requestCloseSwipeActions('task-b')
    expect(closed).toEqual(['task-a'])
  })
})
