<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../services/api'
import { createExport, downloadText, importData, tasksToIcs } from '../utils/export'
import { getSettings } from '../storage/database'
import { syncNow } from '../sync/syncService'
import { useTaskStore } from '../stores/tasks'
import type { Settings } from '../types'

interface DeepseekStatus { configured: boolean; maskedKey: string | null; updatedAt: string | null }

const emit = defineEmits<{ close: []; logout: [] }>()
const store = useTaskStore()
const settings = ref<Settings>()
const aiStatus = ref('检测中…')
const deepseek = ref<DeepseekStatus>({ configured: false, maskedKey: null, updatedAt: null })
const apiKey = ref('')
const keyBusy = ref(false)
const keyMessage = ref('')
const pushPermission = ref<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
const pushRegistered = ref(false)
const pushMessage = ref('')
const syncMessage = ref('')
const syncBusy = ref(false)
const pushLabel = computed(() => pushPermission.value === 'granted' ? (pushRegistered.value ? '已订阅' : '未订阅') : ({ denied: '已拒绝', default: '未授权', unsupported: '不支持' }[pushPermission.value]))

async function detectAi() {
  aiStatus.value = '检测中…'; keyMessage.value = ''
  try {
    const [health, status] = await Promise.all([api.health(), api.getDeepseekSettings()])
    deepseek.value = status.deepseek
    aiStatus.value = health.ai.configured ? `${health.ai.provider} · ${health.ai.model}` : '未配置'
  } catch (error) { aiStatus.value = '连接失败'; keyMessage.value = error instanceof Error ? error.message : '无法连接 AI 服务' }
}
onMounted(async () => { settings.value = await getSettings(); await Promise.all([detectAi(), refreshPushStatus()]) })

async function exportJson() { downloadText(`todo-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await createExport(), null, 2), 'application/json') }
async function handleImport(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return
  try { downloadText(`todo-pre-import-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await createExport(), null, 2), 'application/json'); const mode = confirm('导入前备份已生成。\n确定要覆盖现有数据吗？\n选择“取消”将合并数据。') ? 'replace' : 'merge'; await importData(JSON.parse(await file.text()), mode); await store.load(); void syncNow().catch(() => undefined) }
  catch (error) { alert(`导入失败：${error instanceof Error ? error.message : '文件格式无效'}`) }
  finally { input.value = '' }
}
function exportIcs() { try { downloadText('todo.ics', tasksToIcs(store.active.filter(task => task.dueDate && task.startTime)), 'text/calendar') } catch (error) { alert((error as Error).message) } }

async function saveDeepseekKey() {
  if (!apiKey.value.trim()) return
  keyBusy.value = true; keyMessage.value = '正在验证…'
  try { const result = await api.saveDeepseekKey(apiKey.value); deepseek.value = result.deepseek; apiKey.value = ''; await detectAi(); keyMessage.value = 'API Key 已验证并加密保存' }
  catch (error) { keyMessage.value = error instanceof Error ? error.message : '保存失败' }
  finally { keyBusy.value = false }
}
async function deleteDeepseekKey() {
  if (!confirm('确定删除已保存的 DeepSeek API Key 吗？')) return
  keyBusy.value = true
  try { deepseek.value = (await api.deleteDeepseekKey()).deepseek; await detectAi(); keyMessage.value = 'API Key 已删除' }
  catch (error) { keyMessage.value = error instanceof Error ? error.message : '删除失败' }
  finally { keyBusy.value = false }
}
async function enablePush() {
  pushMessage.value = ''
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') { pushPermission.value = 'unsupported'; pushMessage.value = '当前浏览器不支持 Web Push'; return }
  if (Notification.permission === 'denied') { pushPermission.value = 'denied'; pushMessage.value = '请在浏览器的网站权限中允许通知；iPhone 需先添加到主屏幕后操作'; return }
  try {
    const permission = await Notification.requestPermission(); pushPermission.value = permission
    if (permission !== 'granted') { pushMessage.value = '没有获得通知权限'; return }
    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY
    if (!key) { pushMessage.value = '服务端尚未配置 Web Push 公钥'; return }
    const registration = await navigator.serviceWorker.ready
    const expectedKey = decodeVapidKey(key)
    let subscription = await registration.pushManager.getSubscription()
    const actualKey = subscription?.options.applicationServerKey ? new Uint8Array(subscription.options.applicationServerKey) : null
    if (subscription && actualKey && !keysEqual(actualKey, expectedKey)) { await subscription.unsubscribe(); subscription = null }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey })
    await api.savePush({ ...subscription.toJSON(), appUrl: new URL(import.meta.env.BASE_URL, location.origin).href })
    pushRegistered.value = true
    pushMessage.value = '当前设备已订阅提醒'
  } catch (error) { pushMessage.value = error instanceof Error ? error.message : '通知订阅失败' }
}
function decodeVapidKey(value: string) { const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`; return Uint8Array.from(atob(padded), character => character.charCodeAt(0)) }
function keysEqual(left: Uint8Array, right: Uint8Array) { return left.length === right.length && left.every((value, index) => value === right[index]) }
async function refreshPushStatus() {
  if (pushPermission.value !== 'granted' || !('serviceWorker' in navigator)) return
  try { const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); pushRegistered.value = subscription ? (await api.pushStatus(subscription.endpoint)).registered : false }
  catch { pushRegistered.value = false }
}
async function disablePush() {
  try {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (subscription) { await api.deletePush(subscription.endpoint); await subscription.unsubscribe() }
    pushRegistered.value = false; pushMessage.value = '当前设备已取消订阅'
  } catch (error) { pushMessage.value = error instanceof Error ? error.message : '取消订阅失败' }
}
async function runSync() {
  syncBusy.value = true; syncMessage.value = '正在同步…'
  try { const synced = await syncNow(); settings.value = await getSettings(); syncMessage.value = synced ? '同步完成' : navigator.onLine ? '当前没有有效登录会话' : '当前处于离线状态' }
  catch (error) { syncMessage.value = error instanceof Error ? error.message : '同步失败' }
  finally { syncBusy.value = false }
}
</script>

<template><main class="full-view settings-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>设置</h1><span /></header>
  <section><h2>提醒</h2><div class="setting-row"><div><strong>每日汇总提醒</strong><small>每天 08:00 汇总当天任务；单项提醒在任务中独立设置</small></div><span>08:00</span></div></section>
  <section><h2>数据</h2><button class="setting-row" @click="exportJson"><span>导出 JSON</span><span>›</span></button><label class="setting-row file-row"><span>导入 JSON</span><span>›</span><input type="file" accept="application/json" @change="handleImport"/></label><button class="setting-row" @click="exportIcs"><span>导出明确时间任务 ICS</span><span>›</span></button></section>
  <section><h2>AI</h2><div class="setting-card"><div class="setting-row"><div><strong>DeepSeek</strong><small v-if="deepseek.maskedKey">当前密钥 {{ deepseek.maskedKey }}</small></div><span class="muted">{{ aiStatus }}</span></div><form class="api-key-form" @submit.prevent="saveDeepseekKey"><label>{{ deepseek.configured ? '替换 API Key' : 'API Key' }}<input v-model="apiKey" type="password" autocomplete="off" placeholder="sk-…" /></label><div><button type="button" @click="detectAi">重新检测</button><button v-if="deepseek.configured" type="button" class="danger-text" :disabled="keyBusy" @click="deleteDeepseekKey">删除</button><button class="primary" :disabled="keyBusy || !apiKey.trim()">{{ keyBusy ? '处理中…' : '验证并保存' }}</button></div><small v-if="keyMessage" class="setting-message">{{ keyMessage }}</small></form></div></section>
  <section><h2>同步</h2><button class="setting-row" :disabled="syncBusy" @click="runSync"><span>立即同步</span><span class="muted">{{ settings?.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '尚未同步' }}</span></button><small v-if="syncMessage" class="section-message">{{ syncMessage }}</small></section>
  <section><h2>通知</h2><button class="setting-row" @click="enablePush"><span>Web Push</span><span class="muted">{{ pushLabel }}</span></button><button v-if="pushRegistered" class="setting-row danger-text" @click="disablePush"><span>取消当前设备订阅</span><span>›</span></button><small v-if="pushMessage" class="section-message">{{ pushMessage }}</small></section>
  <section><h2>账户</h2><button class="setting-row danger-text" @click="emit('logout')">退出登录</button></section>
  <section><h2>关于</h2><div class="setting-row"><span>版本</span><span class="muted">1.1.0</span></div></section>
</main></template>
