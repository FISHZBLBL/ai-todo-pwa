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
import CompletedView from './views/CompletedView.vue'
import SettingsView from './views/SettingsView.vue'
import LoginView from './views/LoginView.vue'
import SearchView from './views/SearchView.vue'
import { api, authExpiredEvent } from './services/api'
import { downloadText, tasksToIcs } from './utils/export'
import { getSettings, saveSettings } from './storage/database'

const store = useTaskStore(); const screen = ref<'home'|'ai'|'completed'|'settings'|'search'>('home'); const sheet = ref<'add'|'quick'|'edit'|'date'|null>(null); const editing = ref<Task>(); const dateEditing = ref<Task>(); const authenticated = ref(api.hasSession()); const draftCount = ref(0); const draftToOpen = ref<string>(); const selectMode = ref(false); const selected = ref(new Set<string>())
let uninstallSync: (() => void) | undefined
const handleAuthExpired = () => { authenticated.value = false; screen.value = 'home' }
onMounted(async () => { window.addEventListener(authExpiredEvent, handleAuthExpired); await store.load(); await taskRepository.purgeExpiredTombstones(); await draftRepository.purgeExpiredTombstones(); const settings = await getSettings(); const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; if (settings.updatedAt === new Date(0).toISOString() || settings.timezone !== timezone) await saveSettings({ ...settings, timezone, updatedAt: new Date().toISOString() }, true); await store.load(); draftCount.value = (await draftRepository.list()).filter(d => d.content.trim()).length; uninstallSync = installAutoSync(store.load); if (authenticated.value) void syncNow().then(async () => { await store.load(); openTodoFromUrl() }).catch(()=>{}); else openTodoFromUrl() })
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
  return [...map.entries()].map(([label,tasks]) => ({ label, tasks }))
})
function openEdit(task: Task) { editing.value = task; sheet.value = 'edit' }
function openTodoFromUrl() { const todoId = new URLSearchParams(location.search).get('todo'); if (!todoId) return; const task = store.tasks.find(item => item.id === todoId && !item.deletedAt); if (task) { screen.value = 'home'; openEdit(task) } history.replaceState(null, '', `${location.pathname}${location.hash}`) }
function openDate(task: Task) { dateEditing.value = task; sheet.value = 'date' }
async function saveTask(patch: Partial<Task> & { title: string }) { if (editing.value && sheet.value === 'edit') await store.update(editing.value.id, patch); else await store.create(patch); sheet.value = null; editing.value = undefined }
async function remove(id: string) { await store.softDelete(id); sheet.value = null; editing.value = undefined }
async function addParsed(tasks: ParsedTask[], draftId?: string) { await store.createParsed(tasks); if (draftId) await draftRepository.delete(draftId); draftToOpen.value = undefined; screen.value = 'home'; draftCount.value = (await draftRepository.list()).length }
function logout() { api.logout(); authenticated.value = false; screen.value = 'home' }
async function loggedIn() { authenticated.value = true; await syncNow().catch(() => false); await store.load(); openTodoFromUrl() }
function toggleSelected(id: string) { const next = new Set(selected.value); next.has(id) ? next.delete(id) : next.add(id); selected.value = next }
function exportSelected() { try { downloadText('todo-selected.ics', tasksToIcs(store.tasks.filter(task => selected.value.has(task.id))), 'text/calendar'); selectMode.value = false; selected.value = new Set() } catch (error) { alert((error as Error).message) } }
function editFromSearch(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function editFromCompleted(task: Task) { editing.value = task; screen.value = 'home'; sheet.value = 'edit' }
function openDraft(id: string) { draftToOpen.value = id; screen.value = 'ai' }
async function saveQuickDate(dueDate: string | null) { if (!dateEditing.value) return; await store.update(dateEditing.value.id, dueDate ? { dueDate, dateRange: null } : { dueDate: null, dateRange: null, startTime: null, endTime: null }); dateEditing.value = undefined; sheet.value = null }
function exportOne(task: Task) { try { downloadText(`todo-${task.id}.ics`, tasksToIcs([task]), 'text/calendar') } catch (error) { alert((error as Error).message) } }
</script>
<template>
  <LoginView v-if="!authenticated" @success="loggedIn" />
  <AIInboxView v-else-if="screen === 'ai'" :draft-id="draftToOpen" @close="draftToOpen=undefined;screen='home'" @confirm="addParsed" />
  <CompletedView v-else-if="screen === 'completed'" @close="screen='home'" @edit="editFromCompleted" />
  <SettingsView v-else-if="screen === 'settings'" @close="screen='home'" @logout="logout" />
  <SearchView v-else-if="screen === 'search'" @close="screen='home'" @edit="editFromSearch" @open-draft="openDraft" />
  <div v-else class="app-shell">
    <header class="topbar"><div><h1>{{ selectMode ? '选择日历任务' : 'Todo' }}</h1><p>{{ selectMode ? '仅明确日期和时间的任务可导出' : `${store.active.length} 件在路上` }}</p></div><div class="top-actions"><button class="text-action" @click="selectMode=!selectMode;selected=new Set()">{{ selectMode ? '取消' : '日历' }}</button><button class="search-button" aria-label="搜索" @click="screen='search'">⌕</button></div></header>
    <main class="task-list"><section v-for="group in groups" :key="group.label" class="task-group"><h2>{{ group.label }}</h2><TaskRow v-for="task in group.tasks" :key="task.id" :task="task" :selection-mode="selectMode" :selectable="Boolean(task.dueDate && task.startTime)" :selected="selected.has(task.id)" @select="toggleSelected" @edit="openEdit" @date="openDate" @complete="store.complete" @restore="store.restore" @remove="remove"/></section><div v-if="!groups.length" class="empty home-empty"><span>✓</span><h2>现在没有要做的事</h2><p>想到什么，随手丢进来。</p></div></main>
    <nav class="bottom-nav"><button @click="screen='settings'"><span>⚙</span>设置</button><button class="add-button" aria-label="添加任务" @click="sheet='add'">＋</button><button @click="screen='completed'"><span>✓</span>已完成</button></nav>
    <div v-if="store.lastDeleted" class="toast">已删除 <button @click="store.undoDelete">撤销</button></div>
    <div v-if="selectMode" class="selection-bar"><span>已选 {{ selected.size }} 项</span><button class="primary" :disabled="!selected.size" @click="exportSelected">导出到系统日历</button></div>
    <BottomSheet v-if="sheet==='add'" title="添加" @close="sheet=null"><div class="add-choices"><button @click="sheet='quick'"><span class="choice-icon">＋</span><div><strong>快速添加任务</strong><small>知道要记什么，立即保存</small></div><span>›</span></button><button @click="sheet=null;screen='ai'"><span class="choice-icon ai">✦</span><div><strong>AI 整理</strong><small>一次输入多件事，确认后添加</small></div><span v-if="draftCount" class="draft-badge">{{ draftCount }}</span><span>›</span></button></div></BottomSheet>
    <TaskEditor v-if="sheet==='quick'" quick @close="sheet=null" @save="saveTask" @remove="remove" @export-ics="exportOne"/>
    <TaskEditor v-if="sheet==='edit' && editing" :task="editing" @close="sheet=null" @save="saveTask" @remove="remove" @export-ics="exportOne"/>
    <DateQuickSheet v-if="sheet==='date' && dateEditing" :task="dateEditing" @close="sheet=null" @save="saveQuickDate" />
  </div>
</template>
