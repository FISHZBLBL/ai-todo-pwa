import { db } from '../storage/database'
import type { ProfileEntry, SyncChange } from '../types'

export const profileRepository = {
  async list(includeDeleted = false) {
    const profiles = await (await db()).getAll('profiles')
    return includeDeleted ? profiles : profiles.filter(profile => !profile.deletedAt)
  },
  async get(id: string) { return (await db()).get('profiles', id) },
  async save(profile: ProfileEntry, shouldQueue = true) {
    const database = await db()
    const transaction = database.transaction(['profiles', 'syncQueue'], 'readwrite')
    await transaction.objectStore('profiles').put({ ...profile })
    if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'profile', value: profile, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return profile
  },
  async purgeExpiredTombstones(now = new Date()) {
    const cutoff = now.getTime() - 30 * 86400000
    for (const profile of await this.list(true)) if (profile.deletedAt && Date.parse(profile.deletedAt) < cutoff) await (await db()).delete('profiles', profile.id)
  }
}
