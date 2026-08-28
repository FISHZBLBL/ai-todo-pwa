import { afterEach, describe, expect, it, vi } from 'vitest'

describe('CloudBase storage adapter', () => {
  afterEach(() => {
    delete process.env.STORAGE_ADAPTER
    delete process.env.CLOUDBASE_ENV_ID
    delete process.env.CLOUDBASE_APIKEY
    vi.doUnmock('@cloudbase/node-sdk')
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
      createCollection: vi.fn(async () => ({ requestId: 'test' })),
      collection: transaction.collection,
      runTransaction: vi.fn(async (callback: (value: typeof transaction) => Promise<void>) => callback(transaction))
    }
    vi.doMock('@cloudbase/node-sdk', () => ({ init: vi.fn(() => ({ database: () => database })) }))

    const { cloudStore } = await import('../server/storage')
    const task = { id: crypto.randomUUID(), title: '事务任务', updatedAt: new Date().toISOString() }
    const result = await cloudStore.merge([{ entity: 'task', value: task }])

    expect(database.runTransaction).toHaveBeenCalledOnce()
    expect(database.createCollection).toHaveBeenCalledWith('ai_todo_state')
    expect(document.set).toHaveBeenCalledOnce()
    expect(result.tasks).toContainEqual(expect.objectContaining(task))
    expect(persisted?.tasks).toContainEqual(expect.objectContaining(task))
  })

  it('uses optimistic locking for CloudBase PostgreSQL state', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-postgres'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    process.env.CLOUDBASE_APIKEY = 'test-key'
    let row = { state: { tasks: [], drafts: [], settings: null, subscriptions: [], dailySummarySentDates: [] }, version: 0 }
    let updatePending = false
    const builder: any = {
      select: vi.fn(() => updatePending ? Promise.resolve({ data: [{ version: row.version }], error: null }) : builder),
      eq: vi.fn(() => builder),
      limit: vi.fn(async () => ({ data: [structuredClone(row)], error: null })),
      update: vi.fn((value: typeof row) => { row = structuredClone(value); updatePending = true; return builder })
    }
    const database = { from: vi.fn(() => builder) }
    vi.doMock('@cloudbase/js-sdk', () => ({ default: { init: vi.fn(() => ({ rdb: () => database })) } }))

    const { cloudStore } = await import('../server/storage')
    const task = { id: crypto.randomUUID(), title: 'PostgreSQL 任务', updatedAt: new Date().toISOString() }
    const result = await cloudStore.merge([{ entity: 'task', value: task }])

    expect(database.from).toHaveBeenCalledWith('ai_todo_state')
    expect(builder.update).toHaveBeenCalledOnce()
    expect(result.tasks).toContainEqual(expect.objectContaining(task))
    expect(row.state.tasks).toContainEqual(expect.objectContaining(task))
    expect(row.version).toBe(1)
  })

  it('stores preview state in private CloudBase storage without a separate COS key', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-storage'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    let content: Buffer | undefined
    const app = {
      getTempFileURL: vi.fn(async () => ({ fileList: content ? [{ fileID: 'cloud://test-env/ai-todo/state.json', tempFileURL: 'https://example.test/state.json', code: 'SUCCESS' }] : [{ fileID: 'cloud://test-env/ai-todo/state.json', tempFileURL: '', code: 'NOT_FOUND' }] })),
      getUploadMetadata: vi.fn(async () => ({ data: { fileId: 'cloud://test-env/ai-todo/state.json' } })),
      downloadFile: vi.fn(async () => {
        if (!content) throw new Error('resource not found')
        return { fileContent: content }
      }),
      uploadFile: vi.fn(async ({ fileContent }: { fileContent: Buffer }) => { content = Buffer.from(fileContent); return { fileID: 'cloud://test-env/ai-todo/state.json' } })
    }
    vi.doMock('@cloudbase/node-sdk', () => ({ init: vi.fn(() => app) }))

    const { cloudStore } = await import('../server/storage')
    const task = { id: crypto.randomUUID(), title: '云存储任务', updatedAt: new Date().toISOString() }
    await cloudStore.merge([{ entity: 'task', value: task }])

    expect(app.uploadFile).toHaveBeenCalledOnce()
    expect((await cloudStore.read()).tasks).toContainEqual(expect.objectContaining(task))
  })
})
