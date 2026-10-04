<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ChecklistContent, ChecklistSection, Task } from '../types'
import { checklistInputError, checklistProgress, cloneChecklist, createChecklistItem, createChecklistSection, normalizeChecklistContent } from '../utils/checklist'
import { INPUT_LIMITS } from '../../shared/limits'
import { ChevronDown, GripVertical, Plus, Trash2 } from '@lucide/vue'

const props = defineProps<{ task: Task; archived?: boolean }>()
const emit = defineEmits<{ close: []; update: [Partial<Task>]; archive: []; restore: []; remove: [] }>()
const title = ref(props.task.title)
const content = ref<ChecklistContent>(cloneChecklist(props.task.checklist) ?? { sections: [] })
const collapsed = ref(new Set<string>())
const editing = ref(false)
const editError = ref('')
watch(() => props.task, task => { if (!editing.value) { title.value = task.title; content.value = cloneChecklist(task.checklist) ?? { sections: [] } } }, { deep: true })
const progress = computed(() => checklistProgress({ checklist: content.value }))
function sectionProgress(section: ChecklistSection) { return { completed: section.items.filter(item => item.completed).length, total: section.items.length } }
function toggleSection(id: string) { const next = new Set(collapsed.value); next.has(id) ? next.delete(id) : next.add(id); collapsed.value = next }
function persist() { emit('update', { title: title.value.trim() || props.task.title, checklist: cloneChecklist(content.value) }) }
function toggleItem(sectionId: string, itemId: string) { const item = content.value.sections.find(section => section.id === sectionId)?.items.find(value => value.id === itemId); if (!item) return; item.completed = !item.completed; item.completedAt = item.completed ? new Date().toISOString() : null; persist() }
function addSection() { if (content.value.sections.length < INPUT_LIMITS.checklistSections) content.value.sections.push(createChecklistSection(`分组 ${content.value.sections.length + 1}`)) }
function removeSection(index: number) { content.value.sections.splice(index, 1) }
function addItem(section: ChecklistSection) { if (section.items.length < INPUT_LIMITS.checklistItems) section.items.push(createChecklistItem()) }
function removeItem(section: ChecklistSection, index: number) { section.items.splice(index, 1) }
function finishEditing() {
  editError.value = checklistInputError(title.value, content.value) ?? ''
  if (editError.value) return
  content.value = normalizeChecklistContent(content.value)
  title.value = title.value.trim()
  editing.value = false
  persist()
}

const dragging = ref<{ sectionId: string; itemId: string }>()
function startDrag(event: PointerEvent, sectionId: string, itemId: string) { event.preventDefault(); dragging.value = { sectionId, itemId }; window.addEventListener('pointermove', moveDrag, { passive: false }); window.addEventListener('pointerup', endDrag, { once: true }); window.addEventListener('pointercancel', endDrag, { once: true }) }
function moveDrag(event: PointerEvent) {
  if (!dragging.value) return
  event.preventDefault()
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-checklist-item]')
  if (!target || target.dataset.sectionId !== dragging.value.sectionId || target.dataset.checklistItem === dragging.value.itemId) return
  const section = content.value.sections.find(value => value.id === dragging.value?.sectionId); if (!section) return
  const from = section.items.findIndex(item => item.id === dragging.value?.itemId), to = section.items.findIndex(item => item.id === target.dataset.checklistItem)
  if (from < 0 || to < 0) return
  const [item] = section.items.splice(from, 1); section.items.splice(to, 0, item)
}
function endDrag() { window.removeEventListener('pointermove', moveDrag); window.removeEventListener('pointerup', endDrag); window.removeEventListener('pointercancel', endDrag); dragging.value = undefined }
onUnmounted(endDrag)
</script>

<template>
  <main class="full-view checklist-view">
    <header class="view-header checklist-header"><button @click="emit('close')">返回</button><h1>清单</h1><button v-if="archived" class="header-action" @click="emit('restore')">恢复</button><button v-else class="header-action" @click="emit('archive')">归档</button></header>
    <section class="checklist-hero">
      <input v-if="editing" v-model="title" class="checklist-title-input" maxlength="240" aria-label="清单名称"/>
      <h2 v-else>{{ title }}</h2>
      <div class="checklist-progress"><span>{{ progress.completed }} / {{ progress.total }} 已准备</span><div><i :style="{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }"/></div></div>
      <button v-if="!archived" class="checklist-edit-toggle" @click="editing ? finishEditing() : editing = true">{{ editing ? '保存编辑' : '编辑清单' }}</button>
      <p v-if="editError" class="reminder-error" role="alert">{{ editError }}</p>
    </section>
    <section class="checklist-sections">
      <article v-for="(section, sectionIndex) in content.sections" :key="section.id" class="checklist-section">
        <div class="checklist-section-heading">
          <button class="checklist-section-toggle" :aria-expanded="!collapsed.has(section.id)" @click="toggleSection(section.id)"><ChevronDown :size="18" :class="{ collapsed: collapsed.has(section.id) }"/><input v-if="editing" v-model="section.title" maxlength="120" aria-label="分组名称" @click.stop/><strong v-else>{{ section.title }}</strong><small>{{ sectionProgress(section).completed }}/{{ sectionProgress(section).total }}</small></button>
          <button v-if="editing" class="checklist-remove" aria-label="删除分组" @click="removeSection(sectionIndex)"><Trash2 :size="17"/></button>
        </div>
        <template v-if="!collapsed.has(section.id)">
          <textarea v-if="editing" v-model="section.note" class="checklist-note-editor" rows="2" maxlength="2000" placeholder="分组说明（可选）"/>
          <p v-else-if="section.note" class="checklist-note">{{ section.note }}</p>
          <div class="checklist-items">
            <div v-for="(item, itemIndex) in section.items" :key="item.id" class="checklist-item" :class="{ done: item.completed, dragging: dragging?.itemId === item.id }" :data-checklist-item="item.id" :data-section-id="section.id">
              <template v-if="editing"><button class="checklist-drag" aria-label="拖动排序" @pointerdown="startDrag($event, section.id, item.id)"><GripVertical :size="18"/></button><input v-model="item.text" maxlength="500" aria-label="清单项"/><button class="checklist-remove" aria-label="删除清单项" @click="removeItem(section, itemIndex)"><Trash2 :size="16"/></button></template>
              <label v-else><input type="checkbox" :checked="item.completed" :disabled="archived" @change="toggleItem(section.id, item.id)"/><span>{{ item.text }}</span></label>
            </div>
          </div>
          <button v-if="editing" class="checklist-add-row" :disabled="section.items.length >= INPUT_LIMITS.checklistItems" @click="addItem(section)"><Plus :size="16"/> 添加项目</button>
        </template>
      </article>
      <button v-if="editing" class="checklist-add-section" :disabled="content.sections.length >= INPUT_LIMITS.checklistSections" @click="addSection"><Plus :size="17"/> 添加分组</button>
      <p v-if="!content.sections.length" class="empty">这份清单还没有内容。</p>
    </section>
    <footer v-if="editing" class="checklist-danger-zone"><button class="danger-text" @click="emit('remove')">删除整份清单</button></footer>
  </main>
</template>
