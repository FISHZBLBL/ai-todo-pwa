import { db } from '../storage/database'
import type { Draft, SyncChange } from '../types'
import { draftValueSchema } from '../../shared/syncSchema'
import { nextTimestamp, validateRecord } from '../storage/validation'

export const draftRepository = {
  async list(includeDeleted = false) { const drafts = await (await db()).getAll('drafts'); return includeDeleted ? drafts : drafts.filter(draft => !draft.deletedAt) },
  async get(id: string) { return (await db()).get('drafts', id) },
  async latest() {
    const items = await this.list()
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  },
  async save(draft: Draft, shouldQueue = true) {
    let normalized = validateRecord(draftValueSchema, draft)
    const transaction = (await db()).transaction(['drafts', 'syncQueue'], 'readwrite')
    const previous = await transaction.objectStore('drafts').get(draft.id)
    // A delayed AI callback may finish after the user has consumed a draft.
    if (shouldQueue && previous?.deletedAt && !normalized.deletedAt) { await transaction.done; return previous }
    if (shouldQueue && previous && normalized.updatedAt <= previous.updatedAt) normalized = { ...normalized, updatedAt: nextTimestamp(previous.updatedAt) }
    await transaction.objectStore('drafts').put(normalized)
    if (shouldQueue) await transaction.objectStore('syncQueue').add({ entity: 'draft', value: normalized, queuedAt: new Date().toISOString() } satisfies SyncChange)
    await transaction.done
    return normalized
  },
  async delete(id: string) { const draft = await this.get(id); if (!draft) return; const now = new Date().toISOString(); await this.save({ ...draft, updatedAt: now, deletedAt: now }) },
  async removePermanently(id: string) { await (await db()).delete('drafts', id) },
  async purgeExpiredTombstones(now = new Date()) { const cutoff = now.getTime() - 30 * 86400000; for (const draft of await this.list(true)) if (draft.deletedAt && Date.parse(draft.deletedAt) < cutoff) await this.removePermanently(draft.id) }
}
