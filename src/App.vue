<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useTaskStore } from './stores/tasks'
import { formatTaskDate } from './utils/date'
import { installAutoSync, syncNow } from './sync/syncService'
import { draftRepository } from './repositories/draftRepository'
import { taskRepository } from './repositories/taskRepository'
import { profileRepository } from './repositories/profileRepository'
import type { ChecklistContent, ParsedInboxItem, Task } from './types'
import TaskRow from './components/TaskRow.vue'
import BottomSheet from './components/BottomSheet.vue'
import TaskEditor from './components/TaskEditor.vue'
import DateQuickSheet from './components/DateQuickSheet.vue'
import AIInboxView from './views/AIInboxView.vue'
import CalendarView from './views/CalendarView.vue'
import CompletedView from './views/CompletedView.vue'
import SettingsView from './views/SettingsView.vue'
import LoginView from './views/LoginView.vue'
import ProfileView from './views/ProfileView.vue'
import ChecklistView from './views/ChecklistView.vue'
import ChecklistEditor from './components/ChecklistEditor.vue'
import { api, authExpiredEvent } from './services/api'
import { requestCloseSwipeActions } from './utils/swipeCoordinator'
import { toggleCollapsedGroup } from './utils/groupCollapse'
import { buildHomeTaskGroups } from './utils/homeGroups'
import { CalendarDays, ChevronDown, CircleAlert, Files, GripVertical, ListChecks, Plus, Settings } from '@lucide/vue'
import { useProfileStore } from './stores/profiles'
import { checklistProgress, isChecklist } from './utils/checklist'

const store = useTaskStore(); const profiles = useProfileStore(); const screen = ref<'home'|'ai'|'calendar'|'completed'|'settings'|'profile'|'checklist'>('home'); const sheet = ref<'add'|'quick'|'edit'|'date'|'checklist'|null>(null); const editing = ref<Task>(); const dateEditing = ref<Task>(); const checklistId = ref<string>(); const authenticated = ref(api.hasSession()); const draftCount = ref(0); const draftToOpen = ref<string>()
const selectedChecklist = computed(() => store.tasks.find(task => task.id === checklistId.value && !task.deletedAt))
const collapsedGroups = ref(new Set<string>())
const collapsedGroupsStorageKey = 'todo-collapsed-groups-v1'
const operationError = ref('')
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : '保存失败，请重试'
async function runOperation(work: () => Promise<void>) { operationError.value = ''; try { await work() } catch (reason) { operationError.value = errorMessage(reason) } }
let uninstallSync: (() => void) | undefined
let clockTimer: number | undefined
const currentTime = ref(new Date())
const handleAuthExpired = () => { authenticated.value = false; screen.value = 'home' }
onMounted(async () => { window.addEventListener(authExpiredEvent, handleAuthExpired); clockTimer = window.setInterval(() => { currentTime.value = new Date() }, 30_000); try { const saved = JSON.parse(localStorage.getItem(collapsedGroupsStorageKey) ?? '[]'); if (Array.isArray(saved) && saved.every(value => typeof value === 'string')) collapsedGroups.value = new Set(saved) } catch {} await store.load(); await taskRepository.purgeExpiredTombstones(); await draftRepository.purgeExpiredTombstones(); await profileRepository.purgeExpiredTombstones(); await store.load(); await profiles.load(); draftCount.value = (await draftRepository.list()).filter(d => d.content.trim()).length; uninstallSync = installAutoSync(() => { void store.load(); void profiles.load() }); if (authenticated.value) void syncNow().then(async () => { await store.load(); await profiles.load(); openTodoFromUrl() }).catch(()=>{}); else openTodoFromUrl() })
onUnmounted(() => { uninstallSync?.(); window.clearInterval(clockTimer); window.removeEventListener(authExpiredEvent, handleAuthExpired) })
const filtered = computed(() => store.sorted)
const groups = computed(() => buildHomeTaskGroups(filtered.value, currentTime.value))
function openEdit(task: Task) { editing.value = task; sheet.value = 'edit' }
function openTask(task: Task) { if (isChecklist(task)) { checklistId.value = task.id; screen.value = 'checklist' } else openEdit(task) }
function openTodoFromUrl() { const todoId = new URLSearchParams(location.search).get('todo'); if (!todoId) return; const task = store.tasks.find(item => item.id === todoId && !item.deletedAt); if (task) { screen.value = 'home'; openTask(task) } history.replaceState(null, '', `${location.pathname}${location.hash}`) }
function openDate(task: Task) { dateEditing.value = task; sheet.value = 'date' }
async function saveTask(patch: Partial<Task> & { title: string }) { await runOperation(async () => { if (editing.value && sheet.value === 'edit') await store.update(editing.value.id, patch); else await store.create(patch); sheet.value = null; editing.value = undefined }) }
async function remove(id: string) { await runOperation(async () => { await store.softDelete(id); sheet.value = null; editing.value = undefined }) }
async function addParsed(tasks: ParsedInboxItem[], draftId?: string, done?: (error?: string) => void) {
  operationError.value = ''
  try { await store.createParsed(tasks, draftId); draftToOpen.value = undefined; screen.value = 'home'; draftCount.value = (await draftRepository.list()).length; done?.() }
  catch (reason) { operationError.value = errorMessage(reason); done?.(operationError.value) }
}
async function saveChecklist(value: { title: string; checklist: ChecklistContent }) { await runOperation(async () => { const task = await store.createChecklist(value); sheet.value = null; checklistId.value = task.id; screen.value = 'checklist' }) }
async function updateChecklist(patch: Partial<Task>) { await runOperation(async () => { if (checklistId.value) await store.update(checklistId.value, patch) }) }
async function archiveChecklist() { const task = selectedChecklist.value; if (!task) return; const progress = checklistProgress(task); if (progress.completed < progress.total && !window.confirm(`仍有 ${progress.total - progress.completed} 项未完成，确定归档吗？`)) return; await runOperation(async () => { await store.complete(task.id); screen.value = 'home'; checklistId.value = undefined }) }
async function restoreChecklist() { const task = selectedChecklist.value; if (!task) return; await runOperation(async () => { await store.restore(task.id); screen.value = 'home'; checklistId.value = undefined }) }
async function removeChecklist() { const task = selectedChecklist.value; if (!task || !window.confirm('确定删除整份清单吗？')) return; await runOperation(async () => { await store.softDelete(task.id); screen.value = 'home'; checklistId.value = undefined }) }
function logout() { api.logout(); authenticated.value = false; screen.value = 'home' }
async function loggedIn() { authenticated.value = true; await syncNow().catch(() => false); await store.load(); await profiles.load(); openTodoFromUrl() }
function editFromCompleted(task: Task) { if (isChecklist(task)) { checklistId.value = task.id; screen.value = 'checklist' } else { editing.value = task; screen.value = 'home'; sheet.value = 'edit' } }
function editFromCalendar(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function openDraft(id: string) { draftToOpen.value = id; screen.value = 'ai' }
function toggleGroup(groupKey: string) { collapsedGroups.value = toggleCollapsedGroup(collapsedGroups.value, groupKey); localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...collapsedGroups.value])) }
async function saveQuickDate(patch: Partial<Task>) { const task = dateEditing.value; if (!task) return; await runOperation(async () => { await store.update(task.id, patch); dateEditing.value = undefined; sheet.value = null }) }
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
async function finishReorder(id: string) { if (draggingTaskId.value !== id) return; const group = groups.value.find(item => item.key === draggingGroupKey.value); const shouldPersist = Boolean(group && orderChanged.value); const ids = group?.tasks.map(task => task.id) ?? []; draggingTaskId.value = undefined; draggingGroupKey.value = undefined; dragGhost.value = undefined; lastDragY = undefined; if (shouldPersist) await runOperation(() => store.persistPositions(ids)) }
</script>
<template>
  <LoginView v-if="!authenticated" @success="loggedIn" />
  <AIInboxView v-else-if="screen === 'ai'" :draft-id="draftToOpen" @close="draftToOpen=undefined;screen='home'" @confirm="addParsed" />
  <CalendarView v-else-if="screen === 'calendar'" @close="screen='home'" @edit="editFromCalendar" />
  <CompletedView v-else-if="screen === 'completed'" @close="screen='home'" @edit="editFromCompleted" />
  <ProfileView v-else-if="screen === 'profile'" @close="screen='home'" />
  <SettingsView v-else-if="screen === 'settings'" :completed-count="store.completed.length" @close="screen='home'" @completed="screen='completed'" @logout="logout" />
  <ChecklistView v-else-if="screen === 'checklist' && selectedChecklist" :task="selectedChecklist" :archived="selectedChecklist.completed" @close="screen='home';checklistId=undefined" @update="updateChecklist" @archive="archiveChecklist" @restore="restoreChecklist" @remove="removeChecklist" />
  <div v-else class="app-shell" @click="closeSwipeActionsFromBlank">
    <header class="topbar"><div><h1>Todo</h1><p>{{ store.active.length }} 件在路上</p></div><div class="top-actions"><button class="icon-action" aria-label="日历" @click="screen='calendar'"><CalendarDays :size="23" :stroke-width="2.1"/></button></div></header>
    <main class="task-list"><section v-for="group in groups" :key="group.key" class="task-group" :class="{ 'attention-group': group.attention }" :data-task-group="group.key"><button class="task-group-header" :aria-expanded="!collapsedGroups.has(group.key)" @click.stop="toggleGroup(group.key)"><h2><span v-if="group.attention" class="attention-mark"><CircleAlert :size="17" :stroke-width="2.15"/></span><span>{{ group.label }}</span><small v-if="group.attention">· {{ group.tasks.length }}</small></h2><ChevronDown :size="17" :class="{ collapsed: collapsedGroups.has(group.key) }"/></button><TransitionGroup v-if="!collapsedGroups.has(group.key)" name="task-reorder" tag="div" class="task-group-rows"><TaskRow v-for="task in group.tasks" :key="task.id" :task="task" :now="currentTime" :reorderable="!group.attention" :reordering="Boolean(draggingTaskId)" :is-drag-source="draggingTaskId === task.id" @edit="openTask" @date="openDate" @complete="id => runOperation(() => store.complete(id))" @restore="id => runOperation(() => store.restore(id))" @remove="remove" @reorder-start="startReorder" @reorder-move="moveReorder" @reorder-end="finishReorder"/></TransitionGroup></section><div v-if="!groups.length" class="empty home-empty"><span>✓</span><h2>现在没有要做的事</h2><p>想到什么，随手丢进来。</p></div></main>
    <article v-if="dragGhost" class="drag-ghost" :style="{ top: `${dragGhost.top}px`, left: `${dragGhost.left}px`, width: `${dragGhost.width}px` }"><div class="task-main"><span class="task-title">{{ dragGhost.task.title }}</span><span class="task-meta">{{ formatTaskDate(dragGhost.task) }}</span></div><GripVertical class="drag-ghost-handle" :size="19" :stroke-width="1.8"/></article>
    <nav class="bottom-nav"><button aria-label="设置" @click="screen='settings'"><span><Settings :size="22" :stroke-width="1.8"/></span>设置</button><button class="add-button" aria-label="添加任务" @click="sheet='add'"><Plus :size="31" :stroke-width="2.2"/></button><button aria-label="资料" @click="screen='profile'"><span><Files :size="23" :stroke-width="2"/></span>资料</button></nav>
    <div v-if="store.lastDeleted" class="toast">已删除 <button @click="runOperation(() => store.undoDelete())">撤销</button></div>
    <BottomSheet v-if="sheet==='add'" title="添加" @close="sheet=null"><div class="add-choices"><button @click="sheet='quick'"><span class="choice-icon">＋</span><div><strong>快速添加任务</strong><small>知道要记什么，立即保存</small></div><span>›</span></button><button @click="sheet='checklist'"><span class="choice-icon checklist-choice"><ListChecks :size="19"/></span><div><strong>手动创建清单</strong><small>按分组逐项准备和核对</small></div><span>›</span></button><button @click="sheet=null;screen='ai'"><span class="choice-icon ai">✦</span><div><strong>AI 整理</strong><small>粘贴长内容，自动识别任务或清单</small></div><span v-if="draftCount" class="draft-badge">{{ draftCount }}</span><span>›</span></button></div></BottomSheet>
    <TaskEditor v-if="sheet==='quick'" quick @close="sheet=null" @save="saveTask" @remove="remove"/>
    <TaskEditor v-if="sheet==='edit' && editing" :task="editing" @close="sheet=null" @save="saveTask" @remove="remove"/>
    <ChecklistEditor v-if="sheet==='checklist'" @close="sheet=null" @save="saveChecklist"/>
    <DateQuickSheet v-if="sheet==='date' && dateEditing" :task="dateEditing" @close="sheet=null" @save="saveQuickDate" />
  </div>
<div v-if="operationError" class="toast" role="alert">{{ operationError }} <button @click="operationError=''">关闭</button></div>
</template>
