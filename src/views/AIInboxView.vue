<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { draftRepository } from '../repositories/draftRepository'
import { api } from '../services/api'
import { parseNaturalTask } from '../utils/date'
import { parseLocalInbox } from '../ai/localParser'
import { useSpeech } from '../composables/useSpeech'
import type { Draft, ParsedTask } from '../types'
import { hasIncompleteReminder } from '../ai/reminderPreview'

const props = defineProps<{ draftId?: string }>()
const emit = defineEmits<{ close: []; confirm: [ParsedTask[], string | undefined] }>()
const content = ref(''), draft = ref<Draft>(), parsing = ref(false), error = ref(''), preview = ref<ParsedTask[]>([])
let timer: number | undefined
onMounted(async () => { draft.value = props.draftId ? await draftRepository.get(props.draftId) : await draftRepository.latest(); if (draft.value) content.value = draft.value.content })
watch(content, () => { window.clearTimeout(timer); timer = window.setTimeout(saveDraft, 300) })
async function saveDraft(status: Draft['aiParseStatus'] = draft.value?.aiParseStatus ?? 'idle', lastError: string | null = null) {
  if (!content.value.trim() && !draft.value) return
  const now = new Date().toISOString()
  const next: Draft = { id: draft.value?.id ?? crypto.randomUUID(), content: content.value, createdAt: draft.value?.createdAt ?? now, updatedAt: now, aiParseStatus: status, lastError }
  await draftRepository.save(next)
  draft.value = next
}
async function parse() {
  if (!content.value.trim()) return
  parsing.value = true; error.value = ''; await saveDraft('parsing')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(new DOMException('AI 请求超时', 'TimeoutError')), 20000)
  try {
    const result = await api.parse(content.value, controller.signal); preview.value = result.tasks.map(item => ({ ...item, selected: true })); await saveDraft('parsed')
  } catch (reason) { error.value = controller.signal.aborted ? 'AI 请求超时，请检查网络后重试' : reason instanceof Error ? reason.message : 'AI 解析失败'; await saveDraft('failed', error.value) }
  finally { window.clearTimeout(timeout); parsing.value = false }
}
function localPreview() {
  preview.value = parseLocalInbox(content.value)
}
function singlePreview() { preview.value = [{ ...parseNaturalTask(content.value), reminders: [], selected: true }] }
function confirm() { emit('confirm', preview.value.filter(item => item.selected), draft.value?.id) }
function setPreviewDate(task: ParsedTask, event: Event) { task.dueDate = (event.target as HTMLInputElement).value || null; if (task.dueDate) task.dateRange = null; else { task.startTime = null; task.endTime = null } }
function setReminderDate(reminder: NonNullable<ParsedTask['reminders']>[number], event: Event) { reminder.date = (event.target as HTMLInputElement).value || null }
function removeReminder(task: ParsedTask, index: number) { task.reminders?.splice(index, 1) }
const reminderPeriodLabel: Record<NonNullable<ParsedTask['reminders']>[number]['period'] & string, string> = { morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', night: '夜间' }
const canConfirm = computed(() => preview.value.some(task => task.selected) && preview.value.filter(task => task.selected).every(task => task.title.trim() && (!task.dateRange || task.dateRange.start <= task.dateRange.end) && (!task.startTime || Boolean(task.dueDate)) && !hasIncompleteReminder(task)))
const speech = useSpeech(text => { content.value += `${content.value && !content.value.endsWith('\n') ? '，' : ''}${text}` })
</script>
<template><main class="full-view ai-view">
  <header class="view-header"><button @click="emit('close')">取消</button><h1>AI Inbox</h1><span /></header>
  <section v-if="!preview.length" class="inbox-compose">
    <div class="inbox-field"><textarea v-model="content" placeholder="把脑子里的事情全扔进来……" autofocus/><button v-if="speech.supported" class="mic" :class="{ listening: speech.listening.value }" :aria-label="speech.listening.value ? '停止录音' : '语音输入'" @click="speech.toggle">{{ speech.listening.value ? '■' : '●' }}</button></div>
    <p class="draft-state">{{ draft ? '草稿已自动保存' : '输入会自动保存为草稿' }}</p>
    <div v-if="error" class="error-panel"><strong>AI 解析失败</strong><p>{{ error }}</p><div><button @click="parse">重新解析</button><button @click="localPreview">在本地整理</button><button @click="singlePreview">作为单项任务保存</button></div><small>原始输入仍保留在草稿箱。</small></div>
    <button class="primary large" :disabled="parsing || !content.trim()" @click="parse">{{ parsing ? '正在整理…' : 'AI 整理' }}</button>
  </section>
  <section v-else class="preview">
    <div class="preview-heading"><h2>识别到 {{ preview.length }} 个任务</h2><p>确认后才会写入任务库</p></div>
    <article v-for="(task, index) in preview" :key="index" class="preview-item" :class="{ excluded: !task.selected }">
      <button class="check checked" :class="{ off: !task.selected }" @click="task.selected = !task.selected">✓</button>
      <div><input v-model="task.title" class="preview-title" /><div class="preview-fields"><label class="preview-date-field"><span>日期</span><input :value="task.dueDate ?? ''" type="date" @change="setPreviewDate(task, $event)"/></label><input v-if="task.dueDate" v-model="task.startTime" type="time" aria-label="开始时间"/><template v-if="task.dateRange"><input v-model="task.dateRange.start" type="date" aria-label="范围开始"/><span>–</span><input v-model="task.dateRange.end" type="date" aria-label="范围结束"/></template></div><section v-for="(reminder, reminderIndex) in task.reminders" :key="reminderIndex" class="preview-reminder" :class="{ incomplete: !reminder.date || !reminder.time }"><div class="reminder-heading"><strong>🔔 提醒</strong><span v-if="!reminder.date || !reminder.time">还需补全具体时间</span></div><div class="preview-fields"><label><span>日期</span><input :value="reminder.date ?? ''" type="date" @change="setReminderDate(reminder, $event)"/></label><label><span>时间</span><input v-model="reminder.time" type="time" aria-label="提醒时间"/></label><span v-if="reminder.period && !reminder.time" class="period-hint">{{ reminderPeriodLabel[reminder.period] }}</span></div><button type="button" class="remove-reminder" @click="removeReminder(task, reminderIndex)">不设置此提醒</button></section></div>
    </article>
    <div class="sticky-actions"><button @click="preview = []">返回修改</button><button class="primary" :disabled="!canConfirm" @click="confirm">全部添加</button></div>
  </section>
</main></template>
