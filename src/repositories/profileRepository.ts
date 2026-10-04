import { db } from '../storage/database'
import type { ProfileEntry, SyncChange } from '../types'
import { profileValueSchema } from '../../shared/syncSchema'
import { nextTimestamp, validateRecord } from '../storage/validation'

export const profileRepository = {
  async list(includeDeleted = false) {
    const profiles = await (await db()).getAll('profiles')
    return includeDeleted ? profiles : profiles.filter(profile => !profile.deletedAt)
  },
  async get(id: string) { return (await db()).get('profiles', id) },
  async save(profile: ProfileEntry, shouldQueue = true) {
    let normalized = validateRecord(profileValueSchema, profile)
    const database = await db()
    const transaction = database.transaction(['profiles', 'syncQueue'], 'readwrite')
    const previous = await transaction.objectStore('profiles').get(profile.id)
    if (shouldQueue && previous && normalized.updatedAt <= previous.updatedAt) normalized = { ...normalized, updatedAt: nextTimestamp(previous.updatedAt) }
    await transaction.objectStore('profiles').put(normalized)
    if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'profile', value: normalized, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return normalized
  },
  async purgeExpiredTombstones(now = new Date()) {
    const cutoff = now.getTime() - 30 * 86400000
    for (const profile of await this.list(true)) if (profile.deletedAt && Date.parse(profile.deletedAt) < cutoff) await (await db()).delete('profiles', profile.id)
  }
}
