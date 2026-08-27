import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { taskRepository } from '../repositories/taskRepository'
import { taskDateKey, toDateKey } from '../utils/date'
import type { ParsedTask, Task } from '../types'
import { extractFirstUrl } from '../utils/url'

const nowIso = () => new Date().toISOString()
export const useTaskStore = defineStore('tasks', () => {
  const tasks = ref<Task[]>([])
  const loading = ref(true)
  let undoTimer: number | undefined
  const lastDeleted = ref<Task | null>(null)

  const active = computed(() => tasks.value.filter(task => !task.deletedAt && !task.completed))
  const completed = computed(() => tasks.value.filter(task => !task.deletedAt && task.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')))

  async function load() { tasks.value = await taskRepository.list(true); loading.value = false }
  function build(input: Partial<Task> & Pick<Task, 'title'>): Task {
    const now = nowIso()
    return { id: crypto.randomUUID(), title: input.title.trim(), note: input.note ?? null, url: input.url ?? extractFirstUrl(input.title), date: input.date ?? null, dateRange: input.dateRange ?? null, time: input.time ?? null, endTime: input.endTime ?? null, pinned: input.pinned ?? false, completed: false, completedAt: null, createdAt: now, updatedAt: now, deletedAt: null, recurrence: null, source: input.source ?? 'manual' }
  }
  async function create(input: Partial<Task> & Pick<Task, 'title'>) { const task = build(input); tasks.value.push(task); await taskRepository.save(task); return task }
  async function createParsed(items: ParsedTask[]) { for (const item of items.filter(item => item.selected !== false)) await create({ ...item, source: 'ai' }) }
  async function update(id: string, patch: Partial<Task>) {
    const index = tasks.value.findIndex(task => task.id === id); if (index < 0) return
    const normalized = patch.title && patch.url == null ? { ...patch, url: extractFirstUrl(patch.title) } : patch
    const task = { ...tasks.value[index], ...normalized, updatedAt: nowIso() }; tasks.value[index] = task; await taskRepository.save(task)
  }
  async function complete(id: string) { await update(id, { completed: true, completedAt: nowIso() }) }
  async function restore(id: string) { await update(id, { completed: false, completedAt: null }) }
  async function softDelete(id: string) {
    const task = tasks.value.find(task => task.id === id); if (!task) return
    lastDeleted.value = { ...task }; await update(id, { deletedAt: nowIso() })
    window.clearTimeout(undoTimer); undoTimer = window.setTimeout(() => { lastDeleted.value = null }, 5000)
  }
  async function undoDelete() { if (!lastDeleted.value) return; await update(lastDeleted.value.id, { deletedAt: null }); lastDeleted.value = null; window.clearTimeout(undoTimer) }

  const sorted = computed(() => [...active.value].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const today = toDateKey(new Date())
    const key = (task: Task) => {
      const date = taskDateKey(task)
      if (date && date < today) return `0-${date}-${task.time ?? '99:99'}`
      if (date === today) return `1-${task.time ? `0-${task.time}` : `1-${task.createdAt}`}`
      if (date) return `2-${date}-${task.time ?? task.createdAt}`
      return `3-${task.createdAt}`
    }
    return key(a).localeCompare(key(b))
  }))

  return { tasks, active, completed, sorted, loading, lastDeleted, load, create, createParsed, update, complete, restore, softDelete, undoDelete }
})
