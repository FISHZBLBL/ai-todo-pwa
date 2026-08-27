<script setup lang="ts">
import { reactive } from 'vue'
import type { Task } from '../types'
import { addDays, toDateKey } from '../utils/date'
import BottomSheet from './BottomSheet.vue'
const props = defineProps<{ task?: Task; quick?: boolean }>()
const emit = defineEmits<{ close: []; save: [Partial<Task> & { title: string }]; remove: [string]; exportIcs: [Task] }>()
const form = reactive({ title: props.task?.title ?? '', date: props.task?.date ?? '', time: props.task?.time ?? '', endTime: props.task?.endTime ?? '', note: props.task?.note ?? '', url: props.task?.url ?? '', pinned: props.task?.pinned ?? false })
function save() { if (!form.title.trim()) return; const hasExactDate = Boolean(form.date); emit('save', { title: form.title.trim(), date: form.date || null, time: hasExactDate ? form.time || null : null, endTime: hasExactDate && form.time ? form.endTime || null : null, note: form.note || null, url: form.url || null, pinned: form.pinned, dateRange: form.date ? null : props.task?.dateRange ?? null }) }
const quickDate = (days: number | null) => { form.date = days == null ? '' : toDateKey(addDays(new Date(), days)); if (!form.date) { form.time = ''; form.endTime = '' } }
</script>
<template><BottomSheet :title="quick ? '快速添加任务' : '编辑任务'" @close="emit('close')">
  <form class="editor" @submit.prevent="save">
    <input v-model="form.title" class="title-input" placeholder="要做什么？" maxlength="240" autofocus />
    <div class="quick-dates"><button type="button" @click="quickDate(0)">今天</button><button type="button" @click="quickDate(1)">明天</button><button type="button" @click="quickDate(2)">后天</button><button type="button" @click="quickDate(null)">无日期</button></div>
    <div class="field-grid"><label>日期<input v-model="form.date" type="date" /></label><label>开始时间<input v-model="form.time" type="time" :disabled="!form.date" /></label><label>结束时间<input v-model="form.endTime" type="time" :disabled="!form.date || !form.time" /></label></div>
    <label>备注<textarea v-model="form.note" rows="3" placeholder="可选"></textarea></label>
    <label>链接<input v-model="form.url" type="url" placeholder="https://" /></label>
    <label class="toggle-row">全局置顶<input v-model="form.pinned" type="checkbox" /></label>
    <div class="editor-actions"><button v-if="task?.date && task.time" type="button" @click="emit('exportIcs', task)">导出日历</button><button v-if="task" type="button" class="danger-text" @click="emit('remove', task.id)">删除</button><button type="submit" class="primary">{{ quick ? '添加' : '保存' }}</button></div>
  </form>
</BottomSheet>
</template>
