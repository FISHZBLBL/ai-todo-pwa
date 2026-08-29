<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { Task, TaskReminder } from '../types'
import { addDays, toDateKey } from '../utils/date'
import { explicitReminder, reminderAtFromStartTime } from '../utils/reminder'
import BottomSheet from './BottomSheet.vue'

type ReminderForm = { id: string; date: string; time: string }
const props = defineProps<{ task?: Task; quick?: boolean }>()
const emit = defineEmits<{ close: []; save: [Partial<Task> & { title: string }]; remove: [string] }>()
const form = reactive({ title: props.task?.title ?? '', dueDate: props.task?.dueDate ?? '', startTime: props.task?.startTime ?? '', endTime: props.task?.endTime ?? '', note: props.task?.note ?? '', url: props.task?.url ?? '', pinned: props.task?.pinned ?? false })
const reminderEnabled = ref(props.task ? props.task.reminderMode !== 'off' : false)
const reminderError = ref('')
function localDateTimeParts(value?: string | null) { if (!value) return { date: '', time: '' }; const date = new Date(value); if (Number.isNaN(date.getTime())) return { date: '', time: '' }; const pad = (part: number) => `${part}`.padStart(2, '0'); return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` } }
const reminderForms = ref<ReminderForm[]>((props.task?.reminders ?? []).filter(item => item.source === 'explicit').map(item => ({ id: item.id, ...localDateTimeParts(item.at) })))
const reminderDescription = computed(() => reminderForms.value.length ? '已设置独立提醒时间' : form.dueDate && form.startTime ? '默认在开始时间提醒' : '')
function addReminder() { reminderEnabled.value = true; reminderError.value = ''; reminderForms.value.push({ id: crypto.randomUUID(), date: form.dueDate, time: form.startTime }) }
function removeReminder(id: string) { reminderForms.value = reminderForms.value.filter(item => item.id !== id); reminderError.value = '' }
function reminderPatch(dueDate: string | null, startTime: string | null): Partial<Task> | null {
  if (!reminderEnabled.value) return { reminderMode: 'off', reminders: [] }
  if (!reminderForms.value.length) return dueDate && startTime ? { reminderMode: 'auto' } : { reminderMode: 'off', reminders: [] }
  const reminders: TaskReminder[] = []
  for (const reminder of reminderForms.value) { const at = reminderAtFromStartTime(reminder.date || null, reminder.time || null); if (!at) return null; const existing = props.task?.reminders?.find(item => item.id === reminder.id); reminders.push({ ...explicitReminder(at, reminder.id), eventId: existing?.eventId ?? null, sentAt: existing?.sentAt ?? null }) }
  return { reminderMode: 'explicit', reminders }
}
function save() { if (!form.title.trim()) return; const dueDate = form.dueDate || null, startTime = form.dueDate ? form.startTime || null : null, reminder = reminderPatch(dueDate, startTime); if (!reminder) { reminderError.value = '请为每条提醒同时选择日期和时间'; return }; emit('save', { title: form.title.trim(), dueDate, startTime, endTime: startTime ? form.endTime || null : null, ...reminder, note: form.note || null, url: form.url || null, pinned: form.pinned, dateRange: form.dueDate ? null : props.task?.dateRange ?? null }) }
function quickDate(days: number | null) { form.dueDate = days == null ? '' : toDateKey(addDays(new Date(), days)); if (!form.dueDate) { form.startTime = ''; form.endTime = '' } }
</script>
<template><BottomSheet :title="quick ? '快速添加任务' : '编辑任务'" @close="emit('close')"><form class="editor" @submit.prevent="save"><input v-model="form.title" class="title-input" placeholder="要做什么？" maxlength="240" autofocus /><div class="quick-dates"><button type="button" @click="quickDate(0)">今天</button><button type="button" @click="quickDate(1)">明天</button><button type="button" @click="quickDate(2)">后天</button><button type="button" @click="quickDate(null)">无日期</button></div><div class="field-grid"><label>日期<input v-model="form.dueDate" type="date" /></label><label>开始时间<input v-model="form.startTime" type="time" :disabled="!form.dueDate" /></label><label>结束时间<input v-model="form.endTime" type="time" :disabled="!form.dueDate || !form.startTime" /></label></div><section class="editor-reminder"><div class="editor-reminder-heading"><strong>提醒</strong><label class="reminder-switch"><input v-model="reminderEnabled" type="checkbox" @change="reminderError=''"/><span /></label></div><p v-if="reminderEnabled && reminderDescription" class="time-reminder">{{ reminderDescription }}</p><div v-if="reminderEnabled && reminderForms.length" class="reminder-list"><div v-for="reminder in reminderForms" :key="reminder.id" class="field-grid reminder-fields"><label>提醒日期<input v-model="reminder.date" type="date" /></label><label>提醒时间<input v-model="reminder.time" type="time" /></label><button type="button" class="danger-text remove-editor-reminder" @click="removeReminder(reminder.id)">删除</button></div></div><button v-if="reminderEnabled" type="button" class="add-reminder" @click="addReminder">+ 添加提醒</button><p v-if="reminderError" class="reminder-error">{{ reminderError }}</p></section><label>备注<textarea v-model="form.note" rows="3" placeholder="可选"></textarea></label><label>链接<input v-model="form.url" type="url" placeholder="https://" /></label><label class="toggle-row">全局置顶<input v-model="form.pinned" type="checkbox" /></label><div class="editor-actions"><button v-if="task" type="button" class="danger-text" @click="emit('remove', task.id)">删除</button><button type="submit" class="primary">{{ quick ? '添加' : '保存' }}</button></div></form></BottomSheet></template>
