import { afterEach, describe, expect, it, vi } from 'vitest'

describe('CloudBase storage adapter', () => {
  afterEach(() => {
    delete process.env.STORAGE_ADAPTER
    delete process.env.CLOUDBASE_ENV_ID
    vi.doUnmock('@cloudbase/js-sdk')
    vi.resetModules()
  })

  it('uses a transaction and persists the merged single-user state document', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    let persisted: Record<string, unknown> | undefined
    const document = {
      get: vi.fn(async () => ({ data: persisted ? [{ _id: 'single-user-state', ...persisted }] : [] })),
      set: vi.fn(async (value: Record<string, unknown>) => { persisted = structuredClone(value) })
    }
    const transaction = { collection: vi.fn(() => ({ doc: vi.fn(() => document) })) }
    const database = {
      collection: transaction.collection,
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => Promise<void>) => callback(transaction))
    }
    vi.doMock('@cloudbase/js-sdk', () => ({ default: { init: vi.fn(() => ({ database: () => database })) } }))

    const { cloudStore } = await import('../server/storage')
    const task = { id: crypto.randomUUID(), title: '事务任务', updatedAt: new Date().toISOString() }
    const result = await cloudStore.merge([{ entity: 'task', value: task }])

    expect(database.runTransaction).toHaveBeenCalledOnce()
    expect(document.set).toHaveBeenCalledOnce()
    expect(result.tasks).toContainEqual(task)
    expect(persisted?.tasks).toContainEqual(task)
  })
})
