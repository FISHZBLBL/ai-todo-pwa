import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { taskRepository } from '../repositories/taskRepository'
import { formatTaskDate, isOverdue, toDateKey } from '../utils/date'
import type { ParsedTask, Task } from '../types'
import { extractFirstUrl } from '../utils/url'
import { syncNow } from '../sync/syncService'
import { resolveReminderState } from '../utils/reminder'
import { parsedTaskToTaskInput } from '../ai/reminderPreview'
import { getSettings } from '../storage/database'

const nowIso = () => new Date().toISOString()
export const useTaskStore = defineStore('tasks', () => {
  const tasks = ref<Task[]>([])
  const loading = ref(true)
  let undoTimer: number | undefined
  let undoExpiresAt: number | undefined
  let syncTimer: number | undefined
  const lastDeleted = ref<Task | null>(null)

  function clearUndoToast() {
    window.clearTimeout(undoTimer)
    undoTimer = undefined
    undoExpiresAt = undefined
    lastDeleted.value = null
  }
  function expireUndoToast() { if (undoExpiresAt != null && Date.now() >= undoExpiresAt) clearUndoToast() }
  function scheduleUndoToast() {
    window.clearTimeout(undoTimer)
    undoExpiresAt = Date.now() + 5000
    undoTimer = window.setTimeout(clearUndoToast, 5000)
  }
  document.addEventListener('visibilitychange', expireUndoToast)
  window.addEventListener('pageshow', expireUndoToast)
  onScopeDispose(() => {
    clearUndoToast()
    document.removeEventListener('visibilitychange', expireUndoToast)
    window.removeEventListener('pageshow', expireUndoToast)
  })

  const active = computed(() => tasks.value.filter(task => !task.deletedAt && !task.completed))
  const completed = computed(() => tasks.value.filter(task => !task.deletedAt && task.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')))

  async function load() { tasks.value = await taskRepository.list(true); loading.value = false }
  function build(input: Partial<Task> & Pick<Task, 'title'>): Task {
    const now = nowIso()
    const dueDate = input.dueDate ?? null, startTime = input.startTime ?? null
    const reminder = resolveReminderState(undefined, input)
    return { id: crypto.randomUUID(), title: input.title.trim(), note: input.note ?? null, url: input.url ?? extractFirstUrl(input.title), dueDate, dateRange: input.dateRange ?? null, startTime, endTime: input.endTime ?? null, ...reminder, pinned: input.pinned ?? false, sortOrder: null, completed: false, completedAt: null, createdAt: now, updatedAt: now, deletedAt: null, recurrence: null, source: input.source ?? 'manual' }
  }
  function scheduleSync() { window.clearTimeout(syncTimer); syncTimer = window.setTimeout(() => void syncNow().catch(() => undefined), 100) }
  async function create(input: Partial<Task> & Pick<Task, 'title'>) { const task = build(input); tasks.value.push(task); await taskRepository.save(task); scheduleSync(); return task }
  async function createParsed(items: ParsedTask[]) {
    const settings = await getSettings()
    for (const item of items.filter(item => item.selected !== false)) await create({ ...parsedTaskToTaskInput(item, settings), source: 'ai' })
  }
  async function update(id: string, patch: Partial<Task>) {
    const index = tasks.value.findIndex(task => task.id === id); if (index < 0) return
    const normalized = patch.title && patch.url == null ? { ...patch, url: extractFirstUrl(patch.title) } : patch
    const reminder = resolveReminderState(tasks.value[index], normalized)
    const task = { ...tasks.value[index], ...normalized, ...reminder, updatedAt: nowIso() }
    // Only expose the new state after IndexedDB and syncQueue commit together.
    // Seeing a completed/deleted row disappear now means the action is durable.
    await taskRepository.save(task)
    const currentIndex = tasks.value.findIndex(value => value.id === id)
    if (currentIndex >= 0) tasks.value[currentIndex] = task
    scheduleSync()
  }
  async function complete(id: string) { await update(id, { completed: true, completedAt: nowIso() }) }
  async function restore(id: string) { await update(id, { completed: false, completedAt: null }) }
  async function softDelete(id: string) {
    const task = tasks.value.find(task => task.id === id); if (!task) return
    await update(id, { deletedAt: nowIso() })
    lastDeleted.value = { ...task }
    scheduleUndoToast()
  }
  async function undoDelete() {
    const task = lastDeleted.value
    if (!task) return
    clearUndoToast()
    await update(task.id, { deletedAt: null })
  }

  function positionTasks(ids: string[]) {
    const positions = new Map(ids.map((id, index) => [id, index]))
    tasks.value = tasks.value.map(task => positions.has(task.id) ? { ...task, sortOrder: positions.get(task.id)! } : task)
  }
  async function persistPositions(ids: string[]) {
    const positions = new Map(ids.map((id, index) => [id, index]))
    const updatedAt = nowIso()
    tasks.value = tasks.value.map(task => positions.has(task.id) ? { ...task, sortOrder: positions.get(task.id)!, updatedAt } : task)
    await taskRepository.saveMany(tasks.value.filter(task => positions.has(task.id)))
    scheduleSync()
  }

  const sorted = computed(() => [...active.value].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const today = toDateKey(new Date())
    const key = (task: Task) => {
      if (isOverdue(task)) return `0-${task.dueDate ?? task.dateRange?.end}-${task.startTime ?? '99:99'}`
      if (task.dueDate === today) return `1-${task.startTime ? `0-${task.startTime}` : `1-${task.createdAt}`}`
      if (task.dueDate) return `2-${task.dueDate}-${task.startTime ?? task.createdAt}`
      if (task.dateRange) return `3-${task.dateRange.start}-${task.createdAt}`
      return `4-${task.createdAt}`
    }
    const group = (task: Task) => {
      if (task.pinned) return '0-置顶'
      if (isOverdue(task)) return '1-过期'
      if (task.dueDate === today) return '2-今天'
      if (task.dueDate) return `3-${formatTaskDate(task)}`
      if (task.dateRange) return `4-${formatTaskDate(task)}`
      return '5-无日期'
    }
    const byGroup = group(a).localeCompare(group(b))
    if (byGroup !== 0) return byGroup
    if (a.sortOrder != null || b.sortOrder != null) return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    return key(a).localeCompare(key(b))
  }))

  return { tasks, active, completed, sorted, loading, lastDeleted, load, create, createParsed, update, complete, restore, softDelete, undoDelete, positionTasks, persistPositions }
})
