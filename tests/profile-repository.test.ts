import { beforeEach, describe, expect, it } from 'vitest'
import { db, resetDatabaseForTests } from '../src/storage/database'
import { profileRepository } from '../src/repositories/profileRepository'
import type { ProfileEntry } from '../src/types'

const profile = (overrides: Partial<ProfileEntry> = {}): ProfileEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: null,
  content: 'sk-private-key',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  deletedAt: null,
  ...overrides
})

describe('资料存储', () => {
  beforeEach(resetDatabaseForTests)

  it('accepts an untitled record and queues it for COS sync', async () => {
    await profileRepository.save(profile())
    expect(await profileRepository.list()).toEqual([profile()])
    const queued = await (await db()).getAll('syncQueue')
    expect(queued[0]?.value).toEqual(profile())
    expect((queued[0]?.value as ProfileEntry).content).toBe('sk-private-key')
  })

  it('keeps a deletion tombstone out of the normal list', async () => {
    await profileRepository.save(profile({ deletedAt: '2026-09-05T01:00:00.000Z', updatedAt: '2026-09-05T01:00:00.000Z' }))
    expect(await profileRepository.list()).toEqual([])
    expect(await profileRepository.list(true)).toHaveLength(1)
  })
})
