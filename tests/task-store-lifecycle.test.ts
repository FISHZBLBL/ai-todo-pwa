import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { taskRepository } from '../src/repositories/taskRepository'
import { resetDatabaseForTests } from '../src/storage/database'
import { useTaskStore } from '../src/stores/tasks'
import type { Task } from '../src/types'

const task = (): Task => ({
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
  source: 'manual'
})

async function loadedStore() {
  await taskRepository.save(task(), false)
  const store = useTaskStore()
  await store.load()
  return store
}

function deferNextSave() {
  let release!: () => void
  vi.spyOn(taskRepository, 'save').mockImplementation(value => new Promise(resolve => {
    release = () => resolve(value)
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
    const release = deferNextSave()
    const operation = store.complete(task().id)
    expect(store.active).toHaveLength(1)
    release()
    await operation
    expect(store.active).toHaveLength(0)
  })

  it('删除 tombstone 落盘前不从界面消失，也不提前显示撤销提示', async () => {
    const store = await loadedStore()
    const release = deferNextSave()
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
    const release = deferNextSave()
    const operation = store.undoDelete()
    expect(store.lastDeleted).toBeNull()
    release()
    await operation
    expect(store.active).toHaveLength(1)
  })
})
