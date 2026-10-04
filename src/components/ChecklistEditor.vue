<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChecklistContent, ChecklistSection } from '../types'
import { checklistInputError, createChecklistItem, createChecklistSection, normalizeChecklistContent } from '../utils/checklist'
import { INPUT_LIMITS } from '../../shared/limits'
import BottomSheet from './BottomSheet.vue'
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/vue'

const emit = defineEmits<{ close: []; save: [{ title: string; checklist: ChecklistContent }] }>()
const title = ref('')
const sections = ref<ChecklistSection[]>([createChecklistSection()])
const validationError = computed(() => checklistInputError(title.value, { sections: sections.value }))
const canSave = computed(() => !validationError.value)
function addSection() { if (sections.value.length < INPUT_LIMITS.checklistSections) sections.value.push(createChecklistSection(`分组 ${sections.value.length + 1}`)) }
function removeSection(index: number) { if (sections.value.length > 1) sections.value.splice(index, 1) }
function addItem(section: ChecklistSection) { if (section.items.length < INPUT_LIMITS.checklistItems) section.items.push(createChecklistItem()) }
function removeItem(section: ChecklistSection, index: number) { section.items.splice(index, 1) }
function moveItem(section: ChecklistSection, index: number, offset: number) { const target = index + offset; if (target < 0 || target >= section.items.length) return; const [item] = section.items.splice(index, 1); section.items.splice(target, 0, item) }
function save() {
  if (!canSave.value) return
  const checklist = normalizeChecklistContent({ sections: sections.value })
  emit('save', { title: title.value.trim(), checklist })
}
</script>

<template>
  <BottomSheet title="创建清单" @close="emit('close')">
    <form class="checklist-editor" @submit.prevent="save">
      <input v-model="title" class="title-input" maxlength="240" placeholder="清单名称，例如四川旅行" autofocus />
      <section v-for="(section, sectionIndex) in sections" :key="section.id" class="checklist-editor-section">
        <div class="checklist-editor-section-title"><input v-model="section.title" maxlength="120" aria-label="分组名称"/><button type="button" aria-label="删除分组" :disabled="sections.length === 1" @click="removeSection(sectionIndex)"><Trash2 :size="17"/></button></div>
        <textarea v-model="section.note" rows="2" maxlength="2000" placeholder="分组说明（可选，不会显示复选框）"/>
        <div v-for="(item, itemIndex) in section.items" :key="item.id" class="checklist-editor-item">
          <input v-model="item.text" maxlength="500" :placeholder="`清单项 ${itemIndex + 1}`" />
          <button type="button" aria-label="上移" :disabled="itemIndex === 0" @click="moveItem(section, itemIndex, -1)"><ArrowUp :size="16"/></button>
          <button type="button" aria-label="下移" :disabled="itemIndex === section.items.length - 1" @click="moveItem(section, itemIndex, 1)"><ArrowDown :size="16"/></button>
          <button type="button" aria-label="删除清单项" @click="removeItem(section, itemIndex)"><Trash2 :size="16"/></button>
        </div>
        <button type="button" class="checklist-add-row" :disabled="section.items.length >= INPUT_LIMITS.checklistItems" @click="addItem(section)"><Plus :size="16"/> 添加项目</button>
      </section>
      <button type="button" class="checklist-add-section" :disabled="sections.length >= INPUT_LIMITS.checklistSections" @click="addSection"><Plus :size="17"/> 添加分组</button>
      <p v-if="validationError && title.trim()" class="reminder-error" role="alert">{{ validationError }}</p>
      <div class="editor-actions"><span/><button type="submit" class="primary" :disabled="!canSave">创建清单</button></div>
    </form>
  </BottomSheet>
</template>
