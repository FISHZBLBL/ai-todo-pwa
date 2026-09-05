<script setup lang="ts">
import { useTaskStore } from '../stores/tasks'
import TaskRow from '../components/TaskRow.vue'
import type { Task } from '../types'
const emit = defineEmits<{ close: []; edit: [Task] }>(); const store = useTaskStore()
</script>
<template><main class="full-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>已完成</h1><span /></header><section class="history"><TaskRow v-for="task in store.completed" :key="task.id" :task="task" completed-view @edit="emit('edit', task)" @date="emit('edit', task)" @complete="()=>{}" @restore="store.restore" @remove="store.softDelete"/><p v-if="!store.completed.length" class="empty">完成的任务会安静地留在这里。</p></section></main></template>
