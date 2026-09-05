import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { profileRepository } from '../repositories/profileRepository'
import { syncNow } from '../sync/syncService'
import type { ProfileEntry } from '../types'

const nowIso = () => new Date().toISOString()

export const useProfileStore = defineStore('profiles', () => {
  const profiles = ref<ProfileEntry[]>([])
  let syncTimer: number | undefined
  const active = computed(() => [...profiles.value].filter(profile => !profile.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  const scheduleSync = () => { window.clearTimeout(syncTimer); syncTimer = window.setTimeout(() => void syncNow().catch(() => undefined), 100) }

  async function load() { profiles.value = await profileRepository.list(true) }
  async function save(input: { id?: string; title: string | null; content: string }) {
    const content = input.content.trim()
    if (!content) throw new Error('正文不能为空')
    const current = input.id ? profiles.value.find(profile => profile.id === input.id) : undefined
    const timestamp = nowIso()
    const profile: ProfileEntry = {
      id: current?.id ?? crypto.randomUUID(),
      title: input.title?.trim() || null,
      content,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      deletedAt: null
    }
    await profileRepository.save(profile)
    const index = profiles.value.findIndex(value => value.id === profile.id)
    if (index < 0) profiles.value.push(profile); else profiles.value[index] = profile
    scheduleSync()
    return profile
  }
  async function remove(id: string) {
    const current = profiles.value.find(profile => profile.id === id)
    if (!current) return
    const profile = { ...current, deletedAt: nowIso(), updatedAt: nowIso() }
    await profileRepository.save(profile)
    profiles.value[profiles.value.findIndex(value => value.id === id)] = profile
    scheduleSync()
  }
  return { profiles, active, load, save, remove }
})
