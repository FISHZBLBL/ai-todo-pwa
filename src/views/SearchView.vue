<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useTaskStore } from '../stores/tasks'
import { draftRepository } from '../repositories/draftRepository'
import TaskRow from '../components/TaskRow.vue'
import type { Draft, Task } from '../types'
const emit = defineEmits<{ close: []; edit: [Task]; openDraft: [] }>(); const store = useTaskStore(); const query = ref(''); const drafts = ref<Draft[]>([])
onMounted(async () => { drafts.value = await draftRepository.list() })
const match = (task: Task) => [task.title, task.note, task.url].some(value => value?.toLowerCase().includes(query.value.toLowerCase()))
const active = computed(() => query.value ? store.active.filter(match) : []); const completed = computed(() => query.value ? store.completed.filter(match) : []); const draftResults = computed(() => query.value ? drafts.value.filter(draft => draft.content.toLowerCase().includes(query.value.toLowerCase())) : [])
</script>
<template><main class="full-view search-view"><header class="view-header"><button @click="emit('close')">返回</button><h1>搜索</h1><span /></header><div class="search-field"><span>⌕</span><input v-model="query" placeholder="任务、备注、链接或草稿" autofocus/></div>
  <div v-if="query" class="search-results"><section><h2>任务 <span>{{ active.length }}</span></h2><TaskRow v-for="task in active" :key="task.id" :task="task" @edit="emit('edit', task)" @date="emit('edit', task)" @complete="store.complete" @restore="store.restore" @remove="store.softDelete"/></section><section><h2>已完成 <span>{{ completed.length }}</span></h2><TaskRow v-for="task in completed" :key="task.id" :task="task" completed-view @edit="emit('edit', task)" @date="emit('edit', task)" @complete="()=>{}" @restore="store.restore" @remove="store.softDelete"/></section><section><h2>草稿 <span>{{ draftResults.length }}</span></h2><button v-for="draft in draftResults" :key="draft.id" class="draft-result" @click="emit('openDraft')"><span>{{ draft.content }}</span><small>{{ new Date(draft.updatedAt).toLocaleString() }}</small></button></section></div>
  <p v-else class="empty">输入关键词，所有本地数据会即时搜索。</p>
</main></template>
