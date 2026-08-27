<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTaskStore } from '../stores/tasks'
import TaskRow from '../components/TaskRow.vue'
import type { Task } from '../types'
const emit = defineEmits<{ close: []; edit: [Task] }>(); const store = useTaskStore(); const query = ref('')
const results = computed(() => store.completed.filter(task => [task.title, task.note, task.url].some(value => value?.toLowerCase().includes(query.value.toLowerCase()))))
</script>
<template><main class="full-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>已完成</h1><span /></header><div class="search-field"><span>⌕</span><input v-model="query" placeholder="搜索已完成任务" /></div><section class="history"><TaskRow v-for="task in results" :key="task.id" :task="task" completed-view @edit="emit('edit', task)" @date="emit('edit', task)" @complete="()=>{}" @restore="store.restore" @remove="store.softDelete"/><p v-if="!results.length" class="empty">完成的任务会安静地留在这里。</p></section></main></template>
