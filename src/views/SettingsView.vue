<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../services/api'
import { createExport, downloadText, importData, tasksToIcs } from '../utils/export'
import { getSettings, saveSettings } from '../storage/database'
import { syncNow } from '../sync/syncService'
import { useTaskStore } from '../stores/tasks'
import type { Settings } from '../types'
const emit = defineEmits<{ close: []; logout: [] }>(); const store = useTaskStore(); const settings = ref<Settings>(); const aiStatus = ref('未检测'); const pushStatus = ref<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
onMounted(async () => { settings.value = await getSettings(); try { const health = await api.health(); aiStatus.value = health.ai.configured ? `${health.ai.provider} · ${health.ai.model}` : '未配置' } catch { aiStatus.value = '离线' } })
async function updateTime() { if (settings.value) { settings.value.updatedAt = new Date().toISOString(); settings.value.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; await saveSettings(settings.value, true); void syncNow().catch(() => undefined) } }
async function exportJson() { downloadText(`todo-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await createExport(), null, 2), 'application/json') }
async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    downloadText(`todo-pre-import-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await createExport(), null, 2), 'application/json')
    const mode = confirm('导入前备份已生成。\n确定要覆盖现有数据吗？\n选择“取消”将合并数据。') ? 'replace' : 'merge'
    await importData(JSON.parse(await file.text()), mode)
    await store.load()
    void syncNow().catch(() => undefined)
  } catch (error) { alert(`导入失败：${error instanceof Error ? error.message : '文件格式无效'}`) }
  finally { input.value = '' }
}
function exportIcs() { try { downloadText('todo.ics', tasksToIcs(store.active.filter(task => task.date && task.time)), 'text/calendar') } catch (e) { alert((e as Error).message) } }
async function enablePush() { if (!('serviceWorker' in navigator) || !('PushManager' in window)) { pushStatus.value = 'unsupported'; return }; const permission = await Notification.requestPermission(); pushStatus.value = permission; if (permission !== 'granted') return; const registration = await navigator.serviceWorker.ready; const key = (import.meta.env as any).VITE_VAPID_PUBLIC_KEY; if (!key) return; const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); await api.savePush({ ...subscription.toJSON(), appUrl: new URL(import.meta.env.BASE_URL, location.origin).href }) }
</script>
<template><main class="full-view settings-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>设置</h1><span /></header>
  <section><h2>提醒</h2><div class="setting-row"><div><strong>每日汇总提醒</strong><small>只用于提醒，不会写入任务时间</small></div><input v-if="settings" v-model="settings.dailySummaryTime" type="time" @change="updateTime"/></div></section>
  <section><h2>数据</h2><button class="setting-row" @click="exportJson"><span>导出 JSON</span><span>›</span></button><label class="setting-row file-row"><span>导入 JSON</span><span>›</span><input type="file" accept="application/json" @change="handleImport"/></label><button class="setting-row" @click="exportIcs"><span>导出明确时间任务 ICS</span><span>›</span></button></section>
  <section><h2>AI</h2><div class="setting-row"><span>AI 服务</span><span class="muted">{{ aiStatus }}</span></div></section>
  <section><h2>同步</h2><div class="setting-row"><span>最后同步</span><span class="muted">{{ settings?.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '尚未同步' }}</span></div></section>
  <section><h2>通知</h2><button class="setting-row" @click="enablePush"><span>Web Push</span><span class="muted">{{ pushStatus }}</span></button></section>
  <section><h2>账户</h2><button class="setting-row danger-text" @click="emit('logout')">退出登录</button></section>
  <section><h2>关于</h2><div class="setting-row"><span>版本</span><span class="muted">1.0.0</span></div></section>
</main></template>
