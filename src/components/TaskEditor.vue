<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { Task } from '../types'
import { addDays, toDateKey } from '../utils/date'
import BottomSheet from './BottomSheet.vue'
const props = defineProps<{ task?: Task; quick?: boolean }>()
const emit = defineEmits<{ close: []; save: [Partial<Task> & { title: string }]; remove: [string]; exportIcs: [Task] }>()
const toLocalInput = (value?: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
const formError = ref('')
const form = reactive({ title: props.task?.title ?? '', dueDate: props.task?.dueDate ?? '', startTime: props.task?.startTime ?? '', endTime: props.task?.endTime ?? '', reminderEnabled: props.task?.reminderEnabled ?? false, reminderAt: toLocalInput(props.task?.reminderAt), note: props.task?.note ?? '', url: props.task?.url ?? '', pinned: props.task?.pinned ?? false })
function save() {
  if (!form.title.trim()) return
  formError.value = ''
  const hasExactDate = Boolean(form.dueDate)
  const reminderAt = form.reminderEnabled && form.reminderAt ? new Date(form.reminderAt).toISOString() : null
  if (form.reminderEnabled && (!reminderAt || Date.parse(reminderAt) <= Date.now())) { formError.value = '提醒时间必须晚于当前时间'; return }
  if (reminderAt && Date.parse(reminderAt) >= Date.now() + 365 * 24 * 60 * 60 * 1000) { formError.value = '提醒时间不能超过一年'; return }
  emit('save', { title: form.title.trim(), dueDate: form.dueDate || null, startTime: hasExactDate ? form.startTime || null : null, endTime: hasExactDate && form.startTime ? form.endTime || null : null, reminderEnabled: form.reminderEnabled, reminderAt, note: form.note || null, url: form.url || null, pinned: form.pinned, dateRange: form.dueDate ? null : props.task?.dateRange ?? null })
}
const quickDate = (days: number | null) => { form.dueDate = days == null ? '' : toDateKey(addDays(new Date(), days)); if (!form.dueDate) { form.startTime = ''; form.endTime = '' } }
</script>
<template><BottomSheet :title="quick ? '快速添加任务' : '编辑任务'" @close="emit('close')">
  <form class="editor" @submit.prevent="save">
    <input v-model="form.title" class="title-input" placeholder="要做什么？" maxlength="240" autofocus />
    <div class="quick-dates"><button type="button" @click="quickDate(0)">今天</button><button type="button" @click="quickDate(1)">明天</button><button type="button" @click="quickDate(2)">后天</button><button type="button" @click="quickDate(null)">无日期</button></div>
    <div class="field-grid"><label>截止日期<input v-model="form.dueDate" type="date" /></label><label>开始时间<input v-model="form.startTime" type="time" :disabled="!form.dueDate" /></label><label>结束时间<input v-model="form.endTime" type="time" :disabled="!form.dueDate || !form.startTime" /></label></div>
    <label class="toggle-row">单独提醒<input v-model="form.reminderEnabled" type="checkbox" /></label>
    <label v-if="form.reminderEnabled">提醒时间<input v-model="form.reminderAt" type="datetime-local" required /></label>
    <small v-if="formError" class="setting-message">{{ formError }}</small>
    <label>备注<textarea v-model="form.note" rows="3" placeholder="可选"></textarea></label>
    <label>链接<input v-model="form.url" type="url" placeholder="https://" /></label>
    <label class="toggle-row">全局置顶<input v-model="form.pinned" type="checkbox" /></label>
    <div class="editor-actions"><button v-if="task?.dueDate && task.startTime" type="button" @click="emit('exportIcs', task)">导出日历</button><button v-if="task" type="button" class="danger-text" @click="emit('remove', task.id)">删除</button><button type="submit" class="primary">{{ quick ? '添加' : '保存' }}</button></div>
  </form>
</BottomSheet>
</template>
