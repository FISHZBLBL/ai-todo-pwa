import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { taskRepository } from '../repositories/taskRepository'
import { isOverdue, taskDateKey, toDateKey } from '../utils/date'
import type { ChecklistContent, ParsedInboxItem, Task } from '../types'
import { extractFirstUrl } from '../utils/url'
import { syncNow } from '../sync/syncService'
import { resolveReminderState } from '../utils/reminder'
import { parsedTaskToTaskInput } from '../ai/reminderPreview'
import { getSettings } from '../storage/database'
import { cloneChecklist, parsedChecklistContent } from '../utils/checklist'
import { parsedInboxItemError } from '../ai/inboxValidation'

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
    window.clearTimeout(syncTimer)
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
    const kind = input.kind === 'checklist' ? 'checklist' : 'task'
    return { id: crypto.randomUUID(), kind, title: input.title.trim(), note: input.note ?? null, url: kind === 'task' ? input.url ?? extractFirstUrl(input.title) : null, dueDate: kind === 'task' ? dueDate : null, dateRange: kind === 'task' ? input.dateRange ?? null : null, startTime: kind === 'task' ? startTime : null, endTime: kind === 'task' ? input.endTime ?? null : null, ...reminder, reminders: kind === 'task' ? reminder.reminders : [], reminderMode: kind === 'task' ? reminder.reminderMode : 'off', pinned: input.pinned ?? false, sortOrder: null, completed: false, completedAt: null, createdAt: now, updatedAt: now, deletedAt: null, recurrence: null, source: input.source ?? 'manual', checklist: kind === 'checklist' ? cloneChecklist(input.checklist) : null }
  }
  function scheduleSync() { window.clearTimeout(syncTimer); syncTimer = window.setTimeout(() => void syncNow().catch(() => undefined), 100) }
  async function create(input: Partial<Task> & Pick<Task, 'title'>) { const task = await taskRepository.save(build(input)); tasks.value.push(task); scheduleSync(); return task }
  async function createChecklist(input: { title: string; checklist: ChecklistContent; source?: Task['source'] }) {
    return create({ kind: 'checklist', title: input.title, checklist: input.checklist, source: input.source ?? 'manual' })
  }
  async function createParsed(items: ParsedInboxItem[], draftId?: string) {
    const settings = await getSettings()
    const selected = items.filter(item => item.selected !== false)
    for (const item of selected) {
      const error = parsedInboxItemError(item)
      if (error) throw new Error(error)
    }
    const tasksToSave = selected.map(item => item.kind === 'checklist'
      ? build({ kind: 'checklist', title: item.title, checklist: parsedChecklistContent(item), source: 'ai' })
      : build({ ...parsedTaskToTaskInput(item, settings), source: 'ai' }))
    const saved = await taskRepository.saveMany(tasksToSave, true, draftId)
    tasks.value.push(...saved)
    scheduleSync()
  }
  async function update(id: string, patch: Partial<Task>) {
    const normalized = patch.title && patch.url == null ? { ...patch, url: extractFirstUrl(patch.title) } : patch
    // Only expose the new state after IndexedDB and syncQueue commit together.
    // Seeing a completed/deleted row disappear now means the action is durable.
    const task = await taskRepository.update(id, current => {
      const reminder = resolveReminderState(current, normalized)
      return { ...current, ...normalized, ...reminder, checklist: normalized.checklist === undefined ? current.checklist : cloneChecklist(normalized.checklist), updatedAt: nowIso() }
    })
    if (!task) return
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
    // Persist only the order patch against the latest record, so a concurrent
    // completion or note change is never replaced by an earlier UI snapshot.
    for (const [index, id] of ids.entries()) await update(id, { sortOrder: index })
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
      const date = taskDateKey(task)
      if (date) return `3-${date}-${task.dueDate ? 'date' : `range-${task.dateRange?.end}`}`
      return '4-无日期'
    }
    const byGroup = group(a).localeCompare(group(b))
    if (byGroup !== 0) return byGroup
    if (a.sortOrder != null || b.sortOrder != null) return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
    return key(a).localeCompare(key(b))
  }))

  return { tasks, active, completed, sorted, loading, lastDeleted, load, create, createChecklist, createParsed, update, complete, restore, softDelete, undoDelete, positionTasks, persistPositions }
})
