<script setup lang="ts">
import { ref } from 'vue'
import BottomSheet from '../components/BottomSheet.vue'
import { useProfileStore } from '../stores/profiles'
import type { ProfileEntry } from '../types'

const emit = defineEmits<{ close: [] }>()
const store = useProfileStore()
const editing = ref<ProfileEntry>()
const editorOpen = ref(false)
const title = ref('')
const content = ref('')
const message = ref('')
const saving = ref(false)

function startEdit(profile?: ProfileEntry) {
  editing.value = profile
  editorOpen.value = true
  title.value = profile?.title ?? ''
  content.value = profile?.content ?? ''
  message.value = ''
}
function closeEditor() { editorOpen.value = false; editing.value = undefined; title.value = ''; content.value = ''; message.value = '' }
async function save() {
  if (!content.value.trim()) { message.value = '请填写正文'; return }
  saving.value = true
  try { await store.save({ id: editing.value?.id, title: title.value || null, content: content.value }); closeEditor() }
  catch (error) { message.value = error instanceof Error ? error.message : '保存失败' }
  finally { saving.value = false }
}
async function copy(profile: ProfileEntry) {
  const value = profile.title ? `${profile.title}\n${profile.content}` : profile.content
  try { await navigator.clipboard.writeText(value); message.value = '已复制'; window.setTimeout(() => { if (message.value === '已复制') message.value = '' }, 1800) }
  catch { message.value = '复制失败，请检查浏览器权限' }
}
async function remove(profile: ProfileEntry) {
  if (!confirm(`删除${profile.title ? `“${profile.title}”` : '这条资料'}？`)) return
  await store.remove(profile.id)
}
</script>

<template>
  <main class="full-view profile-view">
    <header class="view-header"><button @click="emit('close')">返回</button><h1>资料</h1><button class="profile-add" @click="startEdit()">新增</button></header>
    <p v-if="message" class="profile-message">{{ message }}</p>
    <section v-if="store.active.length" class="profile-list">
      <article v-for="profile in store.active" :key="profile.id" class="profile-card">
        <h2 :class="{ untitled: !profile.title }">{{ profile.title || '未命名资料' }}</h2>
        <p>{{ profile.content }}</p>
        <footer><small>{{ new Date(profile.updatedAt).toLocaleString() }}</small><div><button @click="copy(profile)">复制</button><button @click="startEdit(profile)">查看 / 编辑</button><button class="danger-text" @click="remove(profile)">删除</button></div></footer>
      </article>
    </section>
    <p v-else class="empty">暂无资料</p>
    <BottomSheet v-if="editorOpen" :title="editing ? '编辑资料' : '新增资料'" @close="closeEditor">
      <form class="profile-editor" @submit.prevent="save">
        <label>标题（可选）<input v-model="title" maxlength="240" placeholder="例如：DeepSeek API Key" autocomplete="off" /></label>
        <label>正文<textarea v-model="content" required maxlength="50000" placeholder="输入需要保存的内容" autocomplete="off" /></label>
        <small v-if="message" class="profile-message">{{ message }}</small>
        <div class="editor-actions"><button type="button" @click="closeEditor">取消</button><button class="primary" :disabled="saving || !content.trim()">{{ saving ? '保存中…' : '保存' }}</button></div>
      </form>
    </BottomSheet>
  </main>
</template>
