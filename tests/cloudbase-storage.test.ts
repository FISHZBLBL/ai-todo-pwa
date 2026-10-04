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

  it('reads existing CloudBase object state but rejects unsafe multi-instance writes', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-storage'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    const existingTask = { id: 'existing-task', title: '已有任务', updatedAt: '2026-10-01T00:00:00Z' }
    const content = Buffer.from(JSON.stringify({ tasks: [existingTask] }))
    const app = {
      getTempFileURL: vi.fn(async () => ({ fileList: content ? [{ fileID: 'cloud://test-env/ai-todo/state.json', tempFileURL: 'https://example.test/state.json', code: 'SUCCESS' }] : [{ fileID: 'cloud://test-env/ai-todo/state.json', tempFileURL: '', code: 'NOT_FOUND' }] })),
      getUploadMetadata: vi.fn(async () => ({ data: { fileId: 'cloud://test-env/ai-todo/state.json' } })),
      downloadFile: vi.fn(async () => {
        if (!content) throw new Error('resource not found')
        return { fileContent: content }
      }),
      uploadFile: vi.fn()
    }
    vi.doMock('@cloudbase/node-sdk', () => ({ init: vi.fn(() => app) }))

    const { cloudStore } = await import('../server/storage')
    const task = { id: crypto.randomUUID(), title: '云存储任务', updatedAt: new Date().toISOString() }
    await expect(cloudStore.merge([{ entity: 'task', value: task }])).rejects.toThrow('仅支持只读')

    expect(app.uploadFile).not.toHaveBeenCalled()
    expect((await cloudStore.read()).tasks).toContainEqual(expect.objectContaining(existingTask))
  })

  it.each(['PERMISSION_DENIED', 'ACCESS_DENIED', 'SUCCESS'])('does not treat a missing temp URL (%s) as an empty state', async code => {
    process.env.STORAGE_ADAPTER = 'cloudbase-storage'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    const app = { getUploadMetadata: vi.fn(async () => ({ data: { fileId: 'cloud://test/state.json' } })), getTempFileURL: vi.fn(async () => ({ fileList: [{ code, tempFileURL: '' }] })), uploadFile: vi.fn() }
    vi.doMock('@cloudbase/node-sdk', () => ({ init: vi.fn(() => app) }))
    const { cloudStore } = await import('../server/storage')
    await expect(cloudStore.read()).rejects.toThrow('CloudBase 存储读取失败')
    await expect(cloudStore.merge([])).rejects.toThrow('仅支持只读')
    expect(app.uploadFile).not.toHaveBeenCalled()
  })

  it('only returns empty state for an explicit missing-file response', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-storage'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    const app = { getUploadMetadata: vi.fn(async () => ({ data: { fileId: 'cloud://test/state.json' } })), getTempFileURL: vi.fn(async () => ({ fileList: [{ code: 'NOT_FOUND', tempFileURL: '' }] })) }
    vi.doMock('@cloudbase/node-sdk', () => ({ init: vi.fn(() => app) }))
    const { cloudStore } = await import('../server/storage')
    await expect(cloudStore.read()).resolves.toMatchObject({ tasks: [], drafts: [] })
  })

  it('initializes an absent PostgreSQL row with an atomic insert', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-postgres'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    process.env.CLOUDBASE_APIKEY = 'test-key'
    let persisted: any
    const builder: any = { select: vi.fn(() => builder), eq: vi.fn(() => builder), limit: vi.fn(async () => ({ data: [], error: null })), insert: vi.fn(async (row: any) => { persisted = row; return { error: null } }), update: vi.fn() }
    vi.doMock('@cloudbase/js-sdk', () => ({ default: { init: vi.fn(() => ({ rdb: () => ({ from: () => builder }) })) } }))
    const { cloudStore } = await import('../server/storage')
    await cloudStore.merge([{ entity: 'draft', value: { id: 'draft-1', updatedAt: '2026-10-04T00:00:00Z' } }])
    expect(persisted).toMatchObject({ id: 'single-user-state', version: 1, state: { drafts: [{ id: 'draft-1' }] } })
    expect(builder.update).not.toHaveBeenCalled()
  })

  it('re-reads and merges after a concurrent PostgreSQL initialization wins', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-postgres'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    process.env.CLOUDBASE_APIKEY = 'test-key'
    let row: any = null
    const database = { from: vi.fn(() => {
      let update: any
      const filters: Record<string, unknown> = {}
      const builder: any = {
        select: vi.fn(() => update ? Promise.resolve((() => { if (row.version !== filters.version) return { data: [], error: null }; row = { ...row, ...structuredClone(update) }; return { data: [{ version: row.version }], error: null } })()) : builder),
        eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return builder }),
        limit: vi.fn(async () => ({ data: row ? [structuredClone(row)] : [], error: null })),
        insert: vi.fn(async () => { row = { state: { tasks: [{ id: 'other-client', updatedAt: '2026-10-03T00:00:00Z' }] }, version: 1 }; return { error: { code: '23505', message: 'duplicate key' } } }),
        update: vi.fn((value: any) => { update = value; return builder })
      }
      return builder
    }) }
    vi.doMock('@cloudbase/js-sdk', () => ({ default: { init: vi.fn(() => ({ rdb: () => database })) } }))
    const { cloudStore } = await import('../server/storage')
    await cloudStore.merge([{ entity: 'task', value: { id: 'this-client', updatedAt: '2026-10-04T00:00:00Z' } }])
    expect(row.state.tasks.map((task: any) => task.id).sort()).toEqual(['other-client', 'this-client'])
    expect(row.version).toBe(2)
  })

  it('retries a PostgreSQL version conflict without losing the concurrent writer', async () => {
    process.env.STORAGE_ADAPTER = 'cloudbase-postgres'
    process.env.CLOUDBASE_ENV_ID = 'test-env'
    process.env.CLOUDBASE_APIKEY = 'test-key'
    let row: any = { state: { tasks: [] }, version: 1 }
    let raced = false
    let writes = 0
    const database = { from: vi.fn(() => {
      let update: any
      const filters: Record<string, unknown> = {}
      const builder: any = {
        select: vi.fn(() => {
          if (!update) return builder
          writes += 1
          if (!raced) { row = { state: { tasks: [{ id: 'other-client', updatedAt: '2026-10-03T00:00:00Z' }] }, version: 2 }; raced = true }
          if (row.version !== filters.version) return Promise.resolve({ data: [], error: null })
          row = { ...row, ...structuredClone(update) }
          return Promise.resolve({ data: [{ version: row.version }], error: null })
        }),
        eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return builder }),
        limit: vi.fn(async () => ({ data: [structuredClone(row)], error: null })),
        update: vi.fn((value: any) => { update = value; return builder })
      }
      return builder
    }) }
    vi.doMock('@cloudbase/js-sdk', () => ({ default: { init: vi.fn(() => ({ rdb: () => database })) } }))
    const { cloudStore } = await import('../server/storage')
    await cloudStore.merge([{ entity: 'task', value: { id: 'this-client', updatedAt: '2026-10-04T00:00:00Z' } }])
    expect(row.state.tasks.map((task: any) => task.id).sort()).toEqual(['other-client', 'this-client'])
    expect(row.version).toBe(3)
    expect(writes).toBe(2)
  })
})
