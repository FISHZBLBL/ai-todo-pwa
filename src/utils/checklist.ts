import type { ChecklistContent, ChecklistItem, ChecklistSection, ParsedChecklist, Task } from '../types'
import { INPUT_LIMITS } from '../../shared/limits'

export function isChecklist(task: Pick<Task, 'kind'>): boolean { return task.kind === 'checklist' }

export function checklistProgress(task: Pick<Task, 'checklist'>) {
  const items = task.checklist?.sections.flatMap(section => section.items) ?? []
  return { completed: items.filter(item => item.completed).length, total: items.length }
}

export function createChecklistItem(text = ''): ChecklistItem {
  return { id: crypto.randomUUID(), text, completed: false, completedAt: null }
}

export function createChecklistSection(title = '清单'): ChecklistSection {
  return { id: crypto.randomUUID(), title, note: null, items: [createChecklistItem()] }
}

export function parsedChecklistContent(value: ParsedChecklist): ChecklistContent {
  return {
    sections: value.sections.map(section => ({
      id: crypto.randomUUID(),
      title: section.title.trim() || '未分组',
      note: section.note?.trim() || null,
      items: section.items
        .filter(item => item.selected !== false && item.text.trim())
        .map(item => createChecklistItem(item.text.trim()))
    })).filter(section => section.items.length || section.note)
  }
}

export function cloneChecklist(content?: ChecklistContent | null): ChecklistContent | null {
  if (!content) return null
  return { sections: content.sections.map(section => ({ ...section, items: section.items.map(item => ({ ...item })) })) }
}

export function normalizeChecklistContent(content: ChecklistContent): ChecklistContent {
  return { sections: content.sections.map(section => ({
    ...section,
    title: section.title.trim() || '未分组',
    note: section.note?.trim() || null,
    items: section.items.filter(item => item.text.trim()).map(item => ({ ...item, text: item.text.trim() }))
  })).filter(section => section.items.length || section.note) }
}

export function checklistInputError(title: string, content: ChecklistContent): string | null {
  if (!title.trim()) return '请填写清单名称'
  if (title.trim().length > INPUT_LIMITS.taskTitle) return `清单名称最多 ${INPUT_LIMITS.taskTitle} 字`
  if (content.sections.length > INPUT_LIMITS.checklistSections) return `最多添加 ${INPUT_LIMITS.checklistSections} 个分组`
  if (!content.sections.some(section => section.note?.trim() || section.items.some(item => item.text.trim()))) return '请填写至少一项清单内容或分组说明'
  for (const section of content.sections) {
    if (section.title.trim().length > INPUT_LIMITS.checklistSectionTitle) return `分组名称最多 ${INPUT_LIMITS.checklistSectionTitle} 字`
    if ((section.note?.length ?? 0) > INPUT_LIMITS.checklistNote) return `分组说明最多 ${INPUT_LIMITS.checklistNote} 字`
    if (section.items.length > INPUT_LIMITS.checklistItems) return `每个分组最多 ${INPUT_LIMITS.checklistItems} 项`
    if (section.items.some(item => item.text.trim().length > INPUT_LIMITS.checklistText)) return `每个清单项最多 ${INPUT_LIMITS.checklistText} 字`
  }
  return null
}
