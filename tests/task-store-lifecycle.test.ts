import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { taskRepository } from '../src/repositories/taskRepository'
import { draftRepository } from '../src/repositories/draftRepository'
import { db, resetDatabaseForTests } from '../src/storage/database'
import { useTaskStore } from '../src/stores/tasks'
import type { Task } from '../src/types'

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: '生命周期验收',
  dueDate: null,
  dateRange: null,
  startTime: null,
  endTime: null,
  reminderMode: 'off',
  reminders: [],
  pinned: false,
  sortOrder: null,
  completed: false,
  completedAt: null,
  createdAt: '2026-08-30T08:00:00.000Z',
  updatedAt: '2026-08-30T08:00:00.000Z',
  deletedAt: null,
  recurrence: null,
  source: 'manual',
  ...overrides
})

async function loadedStore() {
  await taskRepository.save(task(), false)
  const store = useTaskStore()
  await store.load()
  return store
}

async function deferNextUpdate() {
  let release!: () => void
  const original = taskRepository.update.bind(taskRepository)
  vi.spyOn(taskRepository, 'update').mockImplementation((id, updater) => new Promise(resolve => {
    release = () => { void original(id, updater).then(resolve) }
  }))
  return () => release()
}

describe('任务操作持久化与撤销提示', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    setActivePinia(createPinia())
    await resetDatabaseForTests()
  })

  it('完成状态落盘前不从界面消失，避免关闭 App 后复活', async () => {
    const store = await loadedStore()
    const release = await deferNextUpdate()
    const operation = store.complete(task().id)
    expect(store.active).toHaveLength(1)
    release()
    await operation
    expect(store.active).toHaveLength(0)
  })

  it('删除 tombstone 落盘前不从界面消失，也不提前显示撤销提示', async () => {
    const store = await loadedStore()
    const release = await deferNextUpdate()
    const operation = store.softDelete(task().id)
    expect(store.active).toHaveLength(1)
    expect(store.lastDeleted).toBeNull()
    release()
    await operation
    expect(store.active).toHaveLength(0)
    expect(store.lastDeleted?.id).toBe(task().id)
  })

  it('iOS 后台冻结计时器后，恢复页面会按绝对 5 秒期限关闭提示', async () => {
    const store = await loadedStore()
    await store.softDelete(task().id)
    expect(store.lastDeleted).not.toBeNull()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(store.lastDeleted).toBeNull()
  })

  it('点击撤销立即关闭提示，不等待 IndexedDB 写入完成', async () => {
    const store = await loadedStore()
    await store.softDelete(task().id)
    const release = await deferNextUpdate()
    const operation = store.undoDelete()
    expect(store.lastDeleted).toBeNull()
    release()
    await operation
    expect(store.active).toHaveLength(1)
  })

  it('带显式提醒的任务可以完成并持久化', async () => {
    await taskRepository.save(task({
      reminderMode: 'explicit',
      reminders: [{ id: 'reminder-1', at: '2026-09-01T03:00:00.000Z', eventId: 'event-1', sentAt: null, source: 'explicit' }]
    }), false)
    const store = useTaskStore()
    await store.load()

    await expect(store.complete(task().id)).resolves.toBeUndefined()
    expect((await taskRepository.get(task().id))?.completed).toBe(true)
  })

  it('带多条提醒的任务可以删除并保存 tombstone', async () => {
    await taskRepository.save(task({
      reminderMode: 'explicit',
      reminders: [
        { id: 'reminder-1', at: '2026-09-01T03:00:00.000Z', eventId: 'event-1', sentAt: null, source: 'explicit' },
        { id: 'reminder-2', at: '2026-09-02T03:00:00.000Z', eventId: null, sentAt: null, source: 'explicit' }
      ]
    }), false)
    const store = useTaskStore()
    await store.load()

    await expect(store.softDelete(task().id)).resolves.toBeUndefined()
    expect((await taskRepository.get(task().id))?.deletedAt).toBeTruthy()
  })

  it('并发完成与备注更新都基于最新持久化状态，不会互相覆盖', async () => {
    const store = await loadedStore()
    await Promise.all([store.complete(task().id), store.update(task().id, { note: '已补全备注' })])
    expect(await taskRepository.get(task().id)).toMatchObject({ completed: true, note: '已补全备注' })
    expect(store.tasks[0]).toMatchObject({ completed: true, note: '已补全备注' })
  })

  it('持久化手动排序不会覆盖已完成状态', async () => {
    const store = await loadedStore()
    store.positionTasks([task().id])
    await Promise.all([store.complete(task().id), store.persistPositions([task().id])])
    expect(await taskRepository.get(task().id)).toMatchObject({ completed: true, sortOrder: 0 })
  })

  it('未来任务跨月、跨年时按照实际日期排序', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 25, 12))
    const store = useTaskStore()
    store.tasks = [task({ id: 'october', dueDate: '2026-10-01' }), task({ id: 'tomorrow', dueDate: '2026-09-26' }), task({ id: 'next-year', dueDate: '2027-01-01' })]
    expect(store.sorted.map(value => value.id)).toEqual(['tomorrow', 'october', 'next-year'])
    vi.useRealTimers()
  })

  it('AI 批量确认其中一份清单过大时不会提前保存其他任务', async () => {
    const store = useTaskStore()
    const draftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await draftRepository.save({ id: draftId, content: '原始 AI 输入', aiParseStatus: 'parsed', createdAt: task().createdAt, updatedAt: task().updatedAt }, false)
    await expect(store.createParsed([
      { kind: 'task', title: '正常任务', dueDate: null, dateRange: null, startTime: null, endTime: null, url: null, reminders: [] },
      { kind: 'checklist', title: '过大清单', sections: [{ title: '准备事项', note: null, items: Array.from({ length: 200 }, () => ({ text: '字'.repeat(500) })) }] }
    ], draftId)).rejects.toThrow('内容过大')
    expect(store.tasks).toHaveLength(0)
    expect(await taskRepository.list(true)).toHaveLength(0)
    expect(await (await db()).count('syncQueue')).toBe(0)
    expect(await draftRepository.get(draftId)).toMatchObject({ content: '原始 AI 输入' })
    expect((await draftRepository.get(draftId))?.deletedAt).toBeFalsy()
  })

  it('AI 草稿确认创建任务与删除草稿一起提交，重复确认不会重复创建', async () => {
    const store = useTaskStore()
    const draftId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    await draftRepository.save({ id: draftId, content: '明天买雨衣', aiParseStatus: 'parsed', createdAt: task().createdAt, updatedAt: task().updatedAt }, false)
    const items = [{ kind: 'task' as const, title: '买雨衣', dueDate: null, dateRange: null, startTime: null, endTime: null, url: null, reminders: [] }]
    await store.createParsed(items, draftId)
    expect((await draftRepository.get(draftId))?.deletedAt).toBeTruthy()
    expect(await taskRepository.list()).toHaveLength(1)
    expect(store.tasks).toHaveLength(1)
    const queuedAfterFirstConfirmation = await (await db()).count('syncQueue')
    await store.createParsed(items, draftId)
    expect(await taskRepository.list()).toHaveLength(1)
    expect(store.tasks).toHaveLength(1)
    expect(await (await db()).count('syncQueue')).toBe(queuedAfterFirstConfirmation)
  })
})
