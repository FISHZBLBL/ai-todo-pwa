<script setup lang="ts">
import { ref } from 'vue'
import BottomSheet from './BottomSheet.vue'
import type { Task } from '../types'
import { addDays, toDateKey } from '../utils/date'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{ close: []; save: [string | null] }>()
const custom = ref(props.task.date ?? '')
const choose = (days: number) => emit('save', toDateKey(addDays(new Date(), days)))
</script>
<template><BottomSheet title="修改日期" @close="emit('close')"><div class="date-choices"><button @click="choose(0)"><strong>今天</strong><span>{{ toDateKey(new Date()) }}</span></button><button @click="choose(1)"><strong>明天</strong><span>{{ toDateKey(addDays(new Date(), 1)) }}</span></button><button @click="choose(2)"><strong>后天</strong><span>{{ toDateKey(addDays(new Date(), 2)) }}</span></button><label><strong>选择日期</strong><input v-model="custom" type="date" @change="emit('save', custom || null)"/></label><button class="danger-text" @click="emit('save', null)"><strong>清除日期</strong></button></div></BottomSheet></template>
