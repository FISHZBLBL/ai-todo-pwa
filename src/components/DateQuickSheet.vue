<script setup lang="ts">
import { reactive } from 'vue'
import BottomSheet from './BottomSheet.vue'
import type { Task } from '../types'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{ close: []; save: [Partial<Task>] }>()
const form = reactive({ dueDate: props.task.dueDate ?? '', startTime: props.task.startTime ?? '', endTime: props.task.endTime ?? '' })

function save() {
  const dueDate = form.dueDate || null
  const startTime = dueDate ? form.startTime || null : null
  const endTime = startTime ? form.endTime || null : null
  emit('save', { dueDate, dateRange: null, startTime, endTime })
}
</script>
<template><BottomSheet title="设置时间" @close="emit('close')"><form class="time-editor" @submit.prevent="save"><label>日期<input v-model="form.dueDate" type="date" /></label><label>开始时间<input v-model="form.startTime" type="time" :disabled="!form.dueDate" /></label><label>结束时间<input v-model="form.endTime" type="time" :disabled="!form.startTime" /></label><p class="time-reminder">{{ form.dueDate && form.startTime ? '将在开始时间提醒' : '设置开始时间后会自动提醒' }}</p><button class="primary large">保存时间</button></form></BottomSheet></template>
