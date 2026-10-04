<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { draftRepository } from '../repositories/draftRepository'
import { api } from '../services/api'
import { parseNaturalTask } from '../utils/date'
import { parseLocalInbox } from '../ai/localParser'
import { useSpeech } from '../composables/useSpeech'
import type { Draft, ParsedChecklist, ParsedChecklistSection, ParsedInboxItem, ParsedTask } from '../types'
import { parsedInboxItemError } from '../ai/inboxValidation'
import { INPUT_LIMITS } from '../../shared/limits'
import { getSettings } from '../storage/database'
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue'

const props = defineProps<{ draftId?: string }>()
const emit = defineEmits<{ close: []; confirm: [ParsedInboxItem[], string | undefined, (error?: string) => void] }>()
const content = ref(''), draft = ref<Draft>(), parsing = ref(false), error = ref(''), preview = ref<ParsedInboxItem[]>([])
const dailySummaryTime = ref('08:00')
const confirming = ref(false)
let timer: number | undefined
let controller: AbortController | undefined
let requestTimeout: number | undefined
let requestGeneration = 0
let disposed = false
let contentChanged = false
let pendingDraftId: string | undefined
let saveQueue = Promise.resolve()
let finishInitialization!: () => void
const initialized = new Promise<void>(resolve => { finishInitialization = resolve })
const isChecklist = (item: ParsedInboxItem): item is ParsedChecklist => item.kind === 'checklist'
onMounted(async () => {
  try {
    const settings = await getSettings()
    const saved = props.draftId ? await draftRepository.get(props.draftId) : await draftRepository.latest()
    if (disposed) return
    dailySummaryTime.value = settings.dailySummaryTime
    draft.value = saved
    if (saved && !contentChanged) content.value = saved.content
  } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : '读取草稿失败' }
  finally { finishInitialization() }
})
watch(content, () => { contentChanged = true; window.clearTimeout(timer); if (!disposed && !confirming.value) timer = window.setTimeout(() => void saveDraft().catch(showError), 300) })
function showError(reason: unknown) { if (!disposed) error.value = reason instanceof Error ? reason.message : '保存草稿失败' }
async function saveDraft(status: Draft['aiParseStatus'] = draft.value?.aiParseStatus ?? 'idle', lastError: string | null = null, duringConfirmation = false) {
  await initialized
  if (disposed || (confirming.value && !duringConfirmation)) return
  if (!content.value.trim() && !draft.value) return
  if (content.value.length > INPUT_LIMITS.draftContent) { error.value = `输入最多 ${INPUT_LIMITS.draftContent} 字，请缩短后保存`; return }
  const now = new Date().toISOString()
  pendingDraftId ??= draft.value?.id ?? crypto.randomUUID()
  const next: Draft = { id: pendingDraftId, content: content.value, createdAt: draft.value?.createdAt ?? now, updatedAt: now, aiParseStatus: status, lastError }
  const save = saveQueue.then(async () => {
    const saved = await draftRepository.save(next)
    if (!disposed) draft.value = saved
  })
  saveQueue = save.catch(() => undefined)
  await save
}
function selectable(items: ParsedInboxItem[]): ParsedInboxItem[] {
  return items.map(item => isChecklist(item)
    ? { ...item, selected: true, sections: item.sections.map(section => ({ ...section, items: section.items.map(value => ({ ...value, selected: true })) })) }
    : { ...item, reminders: item.reminders?.map(reminder => reminder.recurrence && !reminder.time ? { ...reminder, time: dailySummaryTime.value, period: null } : reminder), selected: true })
}
async function parse() {
  if (disposed || confirming.value || parsing.value || !content.value.trim()) return
  if (content.value.length > INPUT_LIMITS.draftContent) { error.value = `输入最多 ${INPUT_LIMITS.draftContent} 字`; return }
  const generation = ++requestGeneration
  const requestController = new AbortController()
  controller = requestController
  const current = () => !disposed && !confirming.value && generation === requestGeneration
  parsing.value = true; error.value = ''
  try {
    await saveDraft('parsing')
    if (!current()) return
    requestTimeout = window.setTimeout(() => requestController.abort(new DOMException('AI 请求超时', 'TimeoutError')), 20000)
    const result = await api.parse(content.value, dailySummaryTime.value, requestController.signal)
    if (!current()) return
    preview.value = selectable(result.tasks)
    await saveDraft('parsed')
  } catch (reason) {
    if (!current()) return
    error.value = requestController.signal.aborted ? 'AI 请求超时，请检查网络后重试' : reason instanceof Error ? reason.message : 'AI 解析失败'
    try { await saveDraft('failed', error.value) } catch (saveError) { showError(saveError) }
  } finally {
    if (generation === requestGeneration) { window.clearTimeout(requestTimeout); requestTimeout = undefined; controller = undefined; parsing.value = false }
  }
}
function stopParsing() { requestGeneration++; controller?.abort(); controller = undefined; window.clearTimeout(requestTimeout); requestTimeout = undefined; parsing.value = false }
onUnmounted(() => { disposed = true; window.clearTimeout(timer); stopParsing() })
async function close() {
  if (confirming.value) return
  window.clearTimeout(timer); stopParsing()
  try { await saveDraft(); await saveQueue; if (!disposed) emit('close') } catch (reason) { showError(reason) }
}
function localPreview() { if (confirming.value) return; stopParsing(); preview.value = selectable(parseLocalInbox(content.value)) }
function singlePreview() { if (confirming.value) return; stopParsing(); preview.value = selectable([{ ...parseNaturalTask(content.value), reminders: [] }]) }
async function confirm() {
  if (!canConfirm.value || confirming.value || disposed) return
  confirming.value = true; error.value = ''; window.clearTimeout(timer); stopParsing()
  await saveQueue
  if (disposed) return
  if (!draft.value) {
    try { await saveDraft('parsed', null, true) }
    catch (reason) { confirming.value = false; showError(reason); return }
    if (disposed) return
    if (!draft.value) { confirming.value = false; error.value ||= '请先保存原始输入后再确认'; return }
  }
  const selected = JSON.parse(JSON.stringify(preview.value.filter(item => item.selected !== false))) as ParsedInboxItem[]
  emit('confirm', selected, draft.value?.id, message => { if (!disposed && message) { confirming.value = false; error.value = message } })
}
function setPreviewDate(task: ParsedTask, event: Event) { task.dueDate = (event.target as HTMLInputElement).value || null; if (task.dueDate) task.dateRange = null; else { task.startTime = null; task.endTime = null } }
function setReminderDate(reminder: NonNullable<ParsedTask['reminders']>[number], event: Event) { reminder.date = (event.target as HTMLInputElement).value || null }
function removeReminder(task: ParsedTask, index: number) { task.reminders?.splice(index, 1) }
const reminderPeriodLabel: Record<NonNullable<ParsedTask['reminders']>[number]['period'] & string, string> = { morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', night: '夜间' }
const previewError = computed(() => preview.value.filter(item => item.selected !== false).map(parsedInboxItemError).find(Boolean))
const canConfirm = computed(() => preview.value.some(item => item.selected !== false) && !previewError.value)
const checklistMode = computed(() => preview.value.length === 1 && isChecklist(preview.value[0]))
function inferredTitle() { const line = content.value.split('\n').map(value => value.trim()).find(value => value && !/保存成清单|整理成清单|做成清单/i.test(value)); return line?.slice(0, 80) || '新清单' }
function convertToChecklist() {
  if (checklistMode.value) return
  const items = preview.value.flatMap(item => isChecklist(item) ? item.sections.flatMap(section => section.items) : [{ text: item.title, selected: item.selected }])
  preview.value = [{ kind: 'checklist', title: inferredTitle(), selected: true, sections: [{ title: '清单', note: null, items }] }]
}
function emptyTask(title: string): ParsedTask { return { kind: 'task', title, dueDate: null, dateRange: null, startTime: null, endTime: null, url: null, reminders: [], selected: true } }
function convertToTasks() { if (!checklistMode.value) return; const checklist = preview.value[0] as ParsedChecklist; preview.value = checklist.sections.flatMap(section => section.items.filter(item => item.selected !== false).map(item => emptyTask(item.text))) }
function addPreviewSection(checklist: ParsedChecklist) { if (checklist.sections.length < INPUT_LIMITS.checklistSections) checklist.sections.push({ title: `分组 ${checklist.sections.length + 1}`, note: null, items: [{ text: '', selected: true }] }) }
function addPreviewItem(section: ParsedChecklistSection) { if (section.items.length < INPUT_LIMITS.checklistItems) section.items.push({ text: '', selected: true }) }
function removePreviewItem(section: ParsedChecklistSection, index: number) { section.items.splice(index, 1) }
function movePreviewItem(section: ParsedChecklistSection, index: number, offset: number) { const target = index + offset; if (target < 0 || target >= section.items.length) return; const [item] = section.items.splice(index, 1); section.items.splice(target, 0, item) }
const speech = useSpeech(text => { content.value = `${content.value}${content.value && !content.value.endsWith('\n') ? '，' : ''}${text}`.slice(0, INPUT_LIMITS.draftContent) })
</script>

<template><main class="full-view ai-view">
  <header class="view-header"><button :disabled="confirming" @click="close">取消</button><h1>AI Inbox</h1><span /></header>
  <section v-if="!preview.length" class="inbox-compose">
    <div class="inbox-field"><textarea v-model="content" :maxlength="INPUT_LIMITS.draftContent" placeholder="粘贴内容，并告诉 AI 保存成任务或清单……" autofocus/><button v-if="speech.supported" class="mic" :class="{ listening: speech.listening.value }" :aria-label="speech.listening.value ? '停止录音' : '语音输入'" @click="speech.toggle">{{ speech.listening.value ? '■' : '●' }}</button></div>
    <p class="draft-state">{{ draft ? '草稿已自动保存' : '输入会自动保存为草稿' }}</p>
    <div v-if="error" class="error-panel"><strong>AI 解析失败</strong><p>{{ error }}</p><div><button @click="parse">重新解析</button><button @click="localPreview">在本地整理</button><button @click="singlePreview">作为单项任务保存</button></div><small>原始输入仍保留在草稿箱。</small></div>
    <button class="primary large" :disabled="parsing || confirming || !content.trim() || content.length > INPUT_LIMITS.draftContent" @click="parse">{{ parsing ? '正在整理…' : 'AI 整理' }}</button>
  </section>
  <section v-else class="preview">
    <div class="preview-heading"><h2>{{ checklistMode ? '清单预览' : `识别到 ${preview.length} 个任务` }}</h2><p>确认后才会写入；识别错误可以切换保存方式</p><div class="preview-kind-toggle"><button :class="{ active: !checklistMode }" @click="convertToTasks">普通任务</button><button :class="{ active: checklistMode }" @click="convertToChecklist">清单</button></div></div>
    <article v-for="(item, index) in preview" :key="index" class="preview-item" :class="{ excluded: item.selected === false, 'checklist-preview-item': isChecklist(item) }">
      <button class="check checked" :class="{ off: item.selected === false }" @click="item.selected = item.selected === false">✓</button>
      <div v-if="isChecklist(item)" class="preview-checklist"><input v-model="item.title" class="preview-title" maxlength="240"/><section v-for="(section, sectionIndex) in item.sections" :key="sectionIndex" class="preview-checklist-section"><div><input v-model="section.title" class="preview-section-title" maxlength="120"/><button aria-label="删除分组" :disabled="item.sections.length === 1" @click="item.sections.splice(sectionIndex, 1)"><Trash2 :size="16"/></button></div><textarea v-model="section.note" rows="2" maxlength="2000" placeholder="说明文字（可选）"/><div v-for="(checkItem, itemIndex) in section.items" :key="itemIndex" class="preview-checklist-row"><button class="check checked" :class="{ off: checkItem.selected === false }" :aria-label="checkItem.selected === false ? '包含项目' : '排除项目'" @click="checkItem.selected = checkItem.selected === false">✓</button><input v-model="checkItem.text" maxlength="500"/><button aria-label="上移" :disabled="itemIndex === 0" @click="movePreviewItem(section, itemIndex, -1)"><ArrowUp :size="15"/></button><button aria-label="下移" :disabled="itemIndex === section.items.length - 1" @click="movePreviewItem(section, itemIndex, 1)"><ArrowDown :size="15"/></button><button aria-label="删除" @click="removePreviewItem(section, itemIndex)"><Trash2 :size="15"/></button></div><button class="checklist-add-row" :disabled="section.items.length >= INPUT_LIMITS.checklistItems" @click="addPreviewItem(section)"><Plus :size="15"/>添加项目</button></section><button class="checklist-add-section" :disabled="item.sections.length >= INPUT_LIMITS.checklistSections" @click="addPreviewSection(item)"><Plus :size="16"/>添加分组</button></div>
      <div v-else><input v-model="item.title" class="preview-title" :maxlength="INPUT_LIMITS.taskTitle" /><div class="preview-fields"><label class="preview-date-field"><span>日期</span><input :value="item.dueDate ?? ''" type="date" @change="setPreviewDate(item, $event)"/></label><input v-if="item.dueDate" v-model="item.startTime" type="time" aria-label="开始时间"/><template v-if="item.dateRange"><input v-model="item.dateRange.start" type="date" aria-label="范围开始"/><span>–</span><input v-model="item.dateRange.end" type="date" aria-label="范围结束"/></template></div><section v-for="(reminder, reminderIndex) in item.reminders" :key="reminderIndex" class="preview-reminder" :class="{ incomplete: !reminder.date || !reminder.time }"><div class="reminder-heading"><strong>提醒</strong><span v-if="!reminder.date || !reminder.time">还需补全具体时间</span><span v-else-if="reminder.recurrence">重复提醒</span></div><div class="preview-fields"><label><span>首次日期</span><input :value="reminder.date ?? ''" type="date" @change="setReminderDate(reminder, $event)"/></label><label><span>时间</span><input v-model="reminder.time" type="time" aria-label="提醒时间"/></label><span v-if="reminder.period && !reminder.time" class="period-hint">{{ reminderPeriodLabel[reminder.period] }}</span></div><div v-if="reminder.recurrence" class="preview-fields recurrence-preview"><label><span>每隔</span><input v-model.number="reminder.recurrence.interval" type="number" min="1" max="365"/></label><select v-model="reminder.recurrence.unit" aria-label="重复单位"><option value="day">天</option><option value="week">周</option></select><select v-model="reminder.recurrence.end" aria-label="结束方式"><option value="never">持续重复</option><option value="count">按次数</option><option value="date">到指定日期</option></select><label v-if="reminder.recurrence.end==='count'"><span>共</span><input v-model.number="reminder.recurrence.count" type="number" min="1" max="365"/></label><label v-if="reminder.recurrence.end==='date'"><span>结束</span><input v-model="reminder.recurrence.until" type="date"/></label><span v-if="reminder.recurrence.countdown">每次显示剩余时间</span></div><button type="button" class="remove-reminder" @click="removeReminder(item, reminderIndex)">不设置此提醒</button></section></div>
    </article>
    <p v-if="error || previewError" class="reminder-error" role="alert">{{ error || previewError }}</p><div class="sticky-actions"><button :disabled="confirming" @click="preview = []">返回修改</button><button class="primary" :disabled="!canConfirm || confirming" @click="confirm">{{ confirming ? '保存中…' : '确认保存' }}</button></div>
  </section>
</main></template>
