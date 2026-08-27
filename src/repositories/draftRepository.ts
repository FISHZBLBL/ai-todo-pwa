import { db } from '../storage/database'
import type { Draft, SyncChange } from '../types'

export const draftRepository = {
  async list(includeDeleted = false) { const drafts = await (await db()).getAll('drafts'); return includeDeleted ? drafts : drafts.filter(draft => !draft.deletedAt) },
  async get(id: string) { return (await db()).get('drafts', id) },
  async latest() {
    const items = await this.list()
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  },
  async save(draft: Draft, shouldQueue = true) {
    await (await db()).put('drafts', draft)
    if (shouldQueue) await (await db()).add('syncQueue', { entity: 'draft', value: draft, queuedAt: new Date().toISOString() } satisfies SyncChange)
    return draft
  },
  async delete(id: string) { const draft = await this.get(id); if (!draft) return; const now = new Date().toISOString(); await this.save({ ...draft, updatedAt: now, deletedAt: now }) },
  async removePermanently(id: string) { await (await db()).delete('drafts', id) },
  async purgeExpiredTombstones(now = new Date()) { const cutoff = now.getTime() - 30 * 86400000; for (const draft of await this.list(true)) if (draft.deletedAt && Date.parse(draft.deletedAt) < cutoff) await this.removePermanently(draft.id) }
}
