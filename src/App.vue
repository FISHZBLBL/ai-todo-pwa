<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useTaskStore } from './stores/tasks'
import { addDays, formatTaskDate, isOverdue, nextWeekRange, toDateKey, weekendRange } from './utils/date'
import { installAutoSync, syncNow } from './sync/syncService'
import { draftRepository } from './repositories/draftRepository'
import { taskRepository } from './repositories/taskRepository'
import type { ParsedTask, Task } from './types'
import TaskRow from './components/TaskRow.vue'
import BottomSheet from './components/BottomSheet.vue'
import TaskEditor from './components/TaskEditor.vue'
import DateQuickSheet from './components/DateQuickSheet.vue'
import AIInboxView from './views/AIInboxView.vue'
import CalendarView from './views/CalendarView.vue'
import CompletedView from './views/CompletedView.vue'
import SettingsView from './views/SettingsView.vue'
import LoginView from './views/LoginView.vue'
import SearchView from './views/SearchView.vue'
import { api, authExpiredEvent } from './services/api'
import { getSettings, saveSettings } from './storage/database'
import { requestCloseSwipeActions } from './utils/swipeCoordinator'
import { toggleCollapsedGroup } from './utils/groupCollapse'
import { CalendarDays, Check, ChevronDown, GripVertical, Plus, Search, Settings } from '@lucide/vue'

const store = useTaskStore(); const screen = ref<'home'|'ai'|'calendar'|'completed'|'settings'|'search'>('home'); const sheet = ref<'add'|'quick'|'edit'|'date'|null>(null); const editing = ref<Task>(); const dateEditing = ref<Task>(); const authenticated = ref(api.hasSession()); const draftCount = ref(0); const draftToOpen = ref<string>()
const collapsedGroups = ref(new Set<string>())
const collapsedGroupsStorageKey = 'todo-collapsed-groups-v1'
let uninstallSync: (() => void) | undefined
const handleAuthExpired = () => { authenticated.value = false; screen.value = 'home' }
onMounted(async () => { window.addEventListener(authExpiredEvent, handleAuthExpired); try { const saved = JSON.parse(localStorage.getItem(collapsedGroupsStorageKey) ?? '[]'); if (Array.isArray(saved) && saved.every(value => typeof value === 'string')) collapsedGroups.value = new Set(saved) } catch {} await store.load(); await taskRepository.purgeExpiredTombstones(); await draftRepository.purgeExpiredTombstones(); const settings = await getSettings(); const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; if (settings.updatedAt === new Date(0).toISOString() || settings.timezone !== timezone) await saveSettings({ ...settings, timezone, updatedAt: new Date().toISOString() }, true); await store.load(); draftCount.value = (await draftRepository.list()).filter(d => d.content.trim()).length; uninstallSync = installAutoSync(store.load); if (authenticated.value) void syncNow().then(async () => { await store.load(); openTodoFromUrl() }).catch(()=>{}); else openTodoFromUrl() })
onUnmounted(() => { uninstallSync?.(); window.removeEventListener(authExpiredEvent, handleAuthExpired) })
const filtered = computed(() => store.sorted)
const groups = computed(() => {
  const today = toDateKey(new Date()), tomorrow = toDateKey(addDays(new Date(),1)), weekend = weekendRange(), next = nextWeekRange()
  const map = new Map<string, Task[]>(); const add = (label:string, task:Task) => map.set(label, [...(map.get(label) ?? []), task])
  for (const task of filtered.value) {
    if (task.pinned) add('置顶', task)
    else if (isOverdue(task)) add('过期', task)
    else if (task.dueDate === today) add('今天', task)
    else if (task.dueDate === tomorrow) add('明天', task)
    else if (task.dateRange?.start === weekend.start && task.dateRange.end === weekend.end) add('本周末', task)
    else if (task.dateRange?.start === next.start && task.dateRange.end === next.end) add('下周', task)
    else if (task.dueDate || task.dateRange) add(formatTaskDate(task), task)
    else add('无日期', task)
  }
  return [...map.entries()].map(([label,tasks]) => ({ label, key: label, tasks }))
})
function openEdit(task: Task) { editing.value = task; sheet.value = 'edit' }
function openTodoFromUrl() { const todoId = new URLSearchParams(location.search).get('todo'); if (!todoId) return; const task = store.tasks.find(item => item.id === todoId && !item.deletedAt); if (task) { screen.value = 'home'; openEdit(task) } history.replaceState(null, '', `${location.pathname}${location.hash}`) }
function openDate(task: Task) { dateEditing.value = task; sheet.value = 'date' }
async function saveTask(patch: Partial<Task> & { title: string }) { if (editing.value && sheet.value === 'edit') await store.update(editing.value.id, patch); else await store.create(patch); sheet.value = null; editing.value = undefined }
async function remove(id: string) { await store.softDelete(id); sheet.value = null; editing.value = undefined }
async function addParsed(tasks: ParsedTask[], draftId?: string) { await store.createParsed(tasks); if (draftId) await draftRepository.delete(draftId); draftToOpen.value = undefined; screen.value = 'home'; draftCount.value = (await draftRepository.list()).length }
function logout() { api.logout(); authenticated.value = false; screen.value = 'home' }
async function loggedIn() { authenticated.value = true; await syncNow().catch(() => false); await store.load(); openTodoFromUrl() }
function editFromSearch(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function editFromCompleted(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function editFromCalendar(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function openDraft(id: string) { draftToOpen.value = id; screen.value = 'ai' }
function toggleGroup(groupKey: string) { collapsedGroups.value = toggleCollapsedGroup(collapsedGroups.value, groupKey); localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...collapsedGroups.value])) }
async function saveQuickDate(patch: Partial<Task>) { if (!dateEditing.value) return; await store.update(dateEditing.value.id, patch); dateEditing.value = undefined; sheet.value = null }
function closeSwipeActionsFromBlank(event: MouseEvent) { if (event.target instanceof Element && event.target.closest('.task-swipe')) return; requestCloseSwipeActions() }
const draggingTaskId = ref<string>(); const draggingGroupKey = ref<string>(); const orderChanged = ref(false)
const dragGhost = ref<{ task: Task; top: number; left: number; width: number; offsetY: number }>()
let lastDragY: number | undefined
function startReorder(id: string, x: number, y: number) {
  const group = groups.value.find(item => item.tasks.some(task => task.id === id)); const row = document.querySelector<HTMLElement>(`[data-task-id="${id}"] .task-row`)
  const task = group?.tasks.find(item => item.id === id); if (!group || !row || !task) return
  const rect = row.getBoundingClientRect(); dragGhost.value = { task, top: rect.top, left: rect.left, width: rect.width, offsetY: y - rect.top }
  draggingTaskId.value = id; draggingGroupKey.value = group.key; orderChanged.value = false; lastDragY = undefined
}
function moveReorder(id: string, x: number, y: number) {
  if (draggingTaskId.value !== id || !draggingGroupKey.value) return
  if (dragGhost.value) dragGhost.value = { ...dragGhost.value, top: y - dragGhost.value.offsetY }
  const direction = lastDragY == null ? 0 : y - lastDragY; lastDragY = y
  if (Math.abs(direction) < 1) return
  if (y < 96) window.scrollBy({ top: -12 }); else if (y > window.innerHeight - 130) window.scrollBy({ top: 12 })
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-task-id]')
  if (!target?.dataset.taskId || target.dataset.taskId === id || target.closest<HTMLElement>('[data-task-group]')?.dataset.taskGroup !== draggingGroupKey.value) return
  const group = groups.value.find(item => item.key === draggingGroupKey.value); if (!group) return
  const ids = group.tasks.map(task => task.id); const from = ids.indexOf(id), targetIndex = ids.indexOf(target.dataset.taskId); if (from < 0 || targetIndex < 0) return
  const targetRect = target.getBoundingClientRect(); const threshold = targetRect.height * .2
  const insertAfter = direction > 0 ? y > targetRect.top + threshold : y > targetRect.bottom - threshold
  let insertAt = targetIndex + (insertAfter ? 1 : 0)
  const next = [...ids]; next.splice(from, 1); if (from < insertAt) insertAt--; next.splice(insertAt, 0, id)
  if (next.every((taskId, index) => taskId === ids[index])) return
  store.positionTasks(next); orderChanged.value = true
}
async function finishReorder(id: string) { if (draggingTaskId.value !== id) return; const group = groups.value.find(item => item.key === draggingGroupKey.value); const shouldPersist = Boolean(group && orderChanged.value); const ids = group?.tasks.map(task => task.id) ?? []; draggingTaskId.value = undefined; draggingGroupKey.value = undefined; dragGhost.value = undefined; lastDragY = undefined; if (shouldPersist) await store.persistPositions(ids) }
</script>
<template>
  <LoginView v-if="!authenticated" @success="loggedIn" />
  <AIInboxView v-else-if="screen === 'ai'" :draft-id="draftToOpen" @close="draftToOpen=undefined;screen='home'" @confirm="addParsed" />
  <CalendarView v-else-if="screen === 'calendar'" @close="screen='home'" @edit="editFromCalendar" />
  <CompletedView v-else-if="screen === 'completed'" @close="screen='home'" @edit="editFromCompleted" />
  <SettingsView v-else-if="screen === 'settings'" @close="screen='home'" @logout="logout" />
  <SearchView v-else-if="screen === 'search'" @close="screen='home'" @edit="editFromSearch" @open-draft="openDraft" />
  <div v-else class="app-shell" @click="closeSwipeActionsFromBlank">
    <header class="topbar"><div><h1>Todo</h1><p>{{ store.active.length }} 件在路上</p></div><div class="top-actions"><button class="icon-action" aria-label="日历" @click="screen='calendar'"><CalendarDays :size="23" :stroke-width="2.1"/></button><button class="search-button" aria-label="搜索" @click="screen='search'"><Search :size="23" :stroke-width="2.1"/></button></div></header>
    <main class="task-list"><section v-for="group in groups" :key="group.label" class="task-group" :data-task-group="group.key"><button class="task-group-header" :aria-expanded="!collapsedGroups.has(group.key)" @click.stop="toggleGroup(group.key)"><h2>{{ group.label }}</h2><ChevronDown :size="17" :class="{ collapsed: collapsedGroups.has(group.key) }"/></button><TransitionGroup v-if="!collapsedGroups.has(group.key)" name="task-reorder" tag="div" class="task-group-rows"><TaskRow v-for="task in group.tasks" :key="task.id" :task="task" :reorderable="true" :reordering="Boolean(draggingTaskId)" :is-drag-source="draggingTaskId === task.id" @edit="openEdit" @date="openDate" @complete="store.complete" @restore="store.restore" @remove="remove" @reorder-start="startReorder" @reorder-move="moveReorder" @reorder-end="finishReorder"/></TransitionGroup></section><div v-if="!groups.length" class="empty home-empty"><span>✓</span><h2>现在没有要做的事</h2><p>想到什么，随手丢进来。</p></div></main>
    <article v-if="dragGhost" class="drag-ghost" :style="{ top: `${dragGhost.top}px`, left: `${dragGhost.left}px`, width: `${dragGhost.width}px` }"><span class="check"></span><div class="task-main"><span class="task-title">{{ dragGhost.task.title }}</span><span class="task-meta">{{ formatTaskDate(dragGhost.task) }}</span></div><GripVertical class="drag-ghost-handle" :size="19" :stroke-width="1.8"/></article>
    <nav class="bottom-nav"><button aria-label="设置" @click="screen='settings'"><span><Settings :size="22" :stroke-width="1.8"/></span>设置</button><button class="add-button" aria-label="添加任务" @click="sheet='add'"><Plus :size="31" :stroke-width="2.2"/></button><button aria-label="已完成任务" @click="screen='completed'"><span><Check :size="23" :stroke-width="2"/></span>已完成</button></nav>
    <div v-if="store.lastDeleted" class="toast">已删除 <button @click="store.undoDelete">撤销</button></div>
    <BottomSheet v-if="sheet==='add'" title="添加" @close="sheet=null"><div class="add-choices"><button @click="sheet='quick'"><span class="choice-icon">＋</span><div><strong>快速添加任务</strong><small>知道要记什么，立即保存</small></div><span>›</span></button><button @click="sheet=null;screen='ai'"><span class="choice-icon ai">✦</span><div><strong>AI 整理</strong><small>一次输入多件事，确认后添加</small></div><span v-if="draftCount" class="draft-badge">{{ draftCount }}</span><span>›</span></button></div></BottomSheet>
    <TaskEditor v-if="sheet==='quick'" quick @close="sheet=null" @save="saveTask" @remove="remove"/>
    <TaskEditor v-if="sheet==='edit' && editing" :task="editing" @close="sheet=null" @save="saveTask" @remove="remove"/>
    <DateQuickSheet v-if="sheet==='date' && dateEditing" :task="dateEditing" @close="sheet=null" @save="saveQuickDate" />
  </div>
</template>
