<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type PushConfig } from '../services/api'
import { getSettings, saveSettings } from '../storage/database'
import { getSyncIssues, syncNow, type SyncIssue } from '../sync/syncService'
import type { Settings } from '../types'

interface DeepseekStatus { configured: boolean; maskedKey: string | null; updatedAt: string | null }

defineProps<{ completedCount?: number }>()
const emit = defineEmits<{ close: []; logout: []; completed: [] }>()
const settings = ref<Settings>()
const aiStatus = ref('检测中…')
const deepseek = ref<DeepseekStatus>({ configured: false, maskedKey: null, updatedAt: null })
const apiKey = ref('')
const keyBusy = ref(false)
const keyMessage = ref('')
const pushPermission = ref<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
const pushRegistered = ref(false)
const pushBusy = ref(false)
const pushConfig = ref<PushConfig>()
const pushMessage = ref('')
const pushScheduleMessage = computed(() => pushConfig.value?.configured && !pushConfig.value.schedulingAvailable ? '服务端提醒调度尚未启用；当前设备可以订阅，启用调度后才能自动发送提醒' : '')
const syncMessage = ref('')
const syncBusy = ref(false)
const syncIssues = ref<SyncIssue[]>([])
const summaryBusy = ref(false)
const summaryMessage = ref('')
const pushLabel = computed(() => pushPermission.value === 'granted' ? (pushRegistered.value ? '已订阅' : '未订阅') : ({ denied: '已拒绝', default: '未授权', unsupported: '不支持' }[pushPermission.value]))

async function detectAi() {
  aiStatus.value = '检测中…'; keyMessage.value = ''
  try {
    const [health, status] = await Promise.all([api.health(), api.getDeepseekSettings()])
    deepseek.value = status.deepseek
    aiStatus.value = health.ai.configured ? `${health.ai.provider} · ${health.ai.model}` : '未配置'
  } catch (error) { aiStatus.value = '连接失败'; keyMessage.value = error instanceof Error ? error.message : '无法连接 AI 服务' }
}
onMounted(async () => { settings.value = await getSettings(); syncIssues.value = await getSyncIssues(); await Promise.all([detectAi(), refreshPushStatus()]) })

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
  if (pushBusy.value) return
  pushBusy.value = true
  pushMessage.value = ''
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') { pushPermission.value = 'unsupported'; pushMessage.value = '当前浏览器不支持 Web Push'; return }
    if (Notification.permission === 'denied') { pushPermission.value = 'denied'; pushMessage.value = '请在浏览器的网站权限中允许通知；iPhone 需先添加到主屏幕后操作'; return }
    // Keep permission requests in the click gesture; iOS can reject them after
    // awaiting a network request. Configuration is checked again on each click.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); pushPermission.value = permission
    if (permission !== 'granted') { pushMessage.value = '没有获得通知权限'; return }
    const config = await api.getPushConfig()
    pushConfig.value = config
    if (!config.configured || !config.publicKey) { pushRegistered.value = false; pushMessage.value = pushConfigurationMessage(config); return }
    const registration = await navigator.serviceWorker.ready
    const expectedKey = decodeVapidKey(config.publicKey)
    let subscription = await registration.pushManager.getSubscription()
    const actualKey = subscription?.options.applicationServerKey ? new Uint8Array(subscription.options.applicationServerKey) : null
    if (subscription && (!actualKey || !keysEqual(actualKey, expectedKey))) {
      if (!await subscription.unsubscribe()) throw new Error('无法更新旧通知订阅，请重试')
      subscription = null
      pushRegistered.value = false
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expectedKey })
    await api.savePush({ ...subscription.toJSON(), appUrl: new URL(import.meta.env.BASE_URL, location.origin).href })
    pushRegistered.value = true
    pushMessage.value = '当前设备已订阅提醒'
  } catch (error) { pushMessage.value = error instanceof Error ? error.message : '通知订阅失败' }
  finally { pushBusy.value = false }
}
function pushConfigurationMessage(config: PushConfig) {
  const messages = {
    missing_public_key: '服务端尚未配置 Web Push 公钥',
    missing_private_key: '服务端尚未配置 Web Push 私钥',
    invalid_keys: '服务端 Web Push 密钥格式无效，请检查配置',
    key_mismatch: '服务端 Web Push 公钥与私钥不匹配，请检查配置'
  }
  return config.reason ? messages[config.reason] : '服务端 Web Push 配置不完整'
}
function decodeVapidKey(value: string) {
  try {
    const key = value.trim()
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(key)) throw new Error()
    const padded = `${key.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - key.length % 4) % 4)}`
    const decoded = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    if (decoded.length !== 65 || decoded[0] !== 4) throw new Error()
    return decoded
  } catch { throw new Error('服务端 Web Push 公钥格式无效') }
}
function keysEqual(left: Uint8Array, right: Uint8Array) { return left.length === right.length && left.every((value, index) => value === right[index]) }
async function refreshPushStatus() {
  try {
    const config = await api.getPushConfig()
    pushConfig.value = config
    if (!config.configured || !config.publicKey) { pushRegistered.value = false; pushMessage.value = pushConfigurationMessage(config); return }
    const expectedKey = decodeVapidKey(config.publicKey)
    if (pushPermission.value !== 'granted' || !('serviceWorker' in navigator)) return
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    const actualKey = subscription?.options.applicationServerKey ? new Uint8Array(subscription.options.applicationServerKey) : null
    if (subscription && (!actualKey || !keysEqual(actualKey, expectedKey))) { pushRegistered.value = false; pushMessage.value = '当前设备的通知订阅使用了旧公钥，请重新订阅'; return }
    pushRegistered.value = subscription ? (await api.pushStatus(subscription.endpoint)).registered : false
  } catch (error) { pushRegistered.value = false; pushMessage.value = error instanceof Error ? error.message : '无法读取通知配置' }
}
async function disablePush() {
  if (pushBusy.value) return
  pushBusy.value = true
  try {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    if (subscription) { await api.deletePush(subscription.endpoint); await subscription.unsubscribe() }
    pushRegistered.value = false; pushMessage.value = '当前设备已取消订阅'
  } catch (error) { pushMessage.value = error instanceof Error ? error.message : '取消订阅失败' }
  finally { pushBusy.value = false }
}
async function runSync() {
  syncBusy.value = true; syncMessage.value = '正在同步…'
  try { const synced = await syncNow(); settings.value = await getSettings(); syncIssues.value = await getSyncIssues(); syncMessage.value = synced ? (syncIssues.value.length ? `同步完成；${syncIssues.value.length} 条记录需要修正` : '同步完成') : navigator.onLine ? '当前没有有效登录会话' : '当前处于离线状态' }
  catch (error) { syncMessage.value = error instanceof Error ? error.message : '同步失败' }
  finally { syncBusy.value = false }
}
function exportSyncIssues() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(syncIssues.value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'todo-sync-recovery.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function saveDailySummaryTime() {
  if (!settings.value) return
  summaryBusy.value = true; summaryMessage.value = ''
  try {
    const next = { ...settings.value, updatedAt: new Date().toISOString() }
    settings.value = await saveSettings(next, true)
    await syncNow()
    settings.value = await getSettings()
    summaryMessage.value = '每日汇总提醒时间已更新'
  } catch (error) { summaryMessage.value = error instanceof Error ? error.message : '保存失败' }
  finally { summaryBusy.value = false }
}
</script>

<template><main class="full-view settings-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>设置</h1><span /></header>
  <section><h2>任务</h2><button class="setting-row" @click="emit('completed')"><span><strong>已完成</strong><small>查看已完成任务和已归档清单</small></span><span class="muted">{{ completedCount ?? 0 }} 项 ›</span></button></section>
  <section><h2>提醒</h2><div class="setting-row"><div><strong>每日汇总提醒</strong><small>汇总逾期与当天任务；单项提醒在任务中独立设置</small></div><input v-if="settings" v-model="settings.dailySummaryTime" type="time" :disabled="summaryBusy" @change="saveDailySummaryTime" aria-label="每日汇总提醒时间"/></div><small v-if="summaryMessage" class="section-message">{{ summaryMessage }}</small></section>
  <section><h2>AI</h2><div class="setting-card"><div class="setting-row"><div><strong>DeepSeek</strong><small v-if="deepseek.maskedKey">当前密钥 {{ deepseek.maskedKey }}</small></div><span class="muted">{{ aiStatus }}</span></div><form class="api-key-form" @submit.prevent="saveDeepseekKey"><label>{{ deepseek.configured ? '替换 API Key' : 'API Key' }}<input v-model="apiKey" type="password" autocomplete="off" placeholder="sk-…" /></label><div><button type="button" @click="detectAi">重新检测</button><button v-if="deepseek.configured" type="button" class="danger-text" :disabled="keyBusy" @click="deleteDeepseekKey">删除</button><button class="primary" :disabled="keyBusy || !apiKey.trim()">{{ keyBusy ? '处理中…' : '验证并保存' }}</button></div><small v-if="keyMessage" class="setting-message">{{ keyMessage }}</small></form></div></section>
  <section><h2>同步</h2><div class="setting-card"><button class="setting-row" :disabled="syncBusy" @click="runSync"><span><strong>同步到云端</strong><small>同步任务、清单、草稿、资料与设置</small></span><span class="muted">{{ settings?.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '尚未同步' }}</span></button></div><small v-if="syncMessage" class="section-message">{{ syncMessage }}</small><div v-if="syncIssues.length" class="setting-card"><p>以下记录保留在本机，修正内容后可重新同步：</p><p v-for="issue in syncIssues" :key="`${issue.entity}:${issue.id}`">{{ issue.reason }}</p><button @click="exportSyncIssues">导出待恢复内容</button></div></section>
  <section><h2>通知</h2><button class="setting-row" :disabled="pushBusy" @click="enablePush"><span>Web Push</span><span class="muted">{{ pushLabel }}</span></button><button v-if="pushRegistered" class="setting-row danger-text" :disabled="pushBusy" @click="disablePush"><span>取消当前设备订阅</span><span>›</span></button><small v-if="pushMessage" class="section-message" role="status">{{ pushMessage }}</small><small v-if="pushScheduleMessage" class="section-message">{{ pushScheduleMessage }}</small></section>
  <section><h2>账户</h2><button class="setting-row danger-text" @click="emit('logout')">退出登录</button></section>
  <section><h2>关于</h2><div class="setting-row"><span>版本</span><span class="muted">1.1.0</span></div></section>
</main></template>
