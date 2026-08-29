<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { Task } from '../types'
import { formatTaskDate, isOverdue } from '../utils/date'
import IconButton from './IconButton.vue'
import { resolveSwipeReveal, type SwipeReveal } from '../utils/swipe'
import { listenForSwipeClose, requestCloseSwipeActions } from '../utils/swipeCoordinator'
import { Bell, GripVertical } from '@lucide/vue'

const props = defineProps<{ task: Task; selectionMode?: boolean; selectable?: boolean; selected?: boolean; completedView?: boolean; reorderable?: boolean }>()
const emit = defineEmits<{ edit: [Task]; date: [Task]; complete: [string]; restore: [string]; remove: [string]; select: [string]; 'reorder-start': [string]; 'reorder-move': [string, number, number]; 'reorder-end': [string] }>()
const rowElement = ref<HTMLElement>()
const startX = ref(0), startY = ref(0), delta = ref(0), horizontal = ref(false), revealed = ref<SwipeReveal>(null), suppressClick = ref(false), dragging = ref(false)
const floatingStyle = ref<Record<string, string>>({})
let longPressTimer: number | undefined
let dragOffsetY = 0
function clearLongPress() { window.clearTimeout(longPressTimer); longPressTimer = undefined }
function resetReveal() { revealed.value = null; delta.value = 0 }
let stopListening: (() => void) | undefined
onMounted(() => { stopListening = listenForSwipeClose(props.task.id, resetReveal) })
onUnmounted(() => stopListening?.())

function onStart(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.check,.url-link,.desktop-actions,.drag-handle')) return
  requestCloseSwipeActions(props.task.id); startX.value = event.clientX; startY.value = event.clientY; horizontal.value = false
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent) {
  if (dragging.value) return
  const dx = event.clientX - startX.value, dy = event.clientY - startY.value
  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { horizontal.value = true; const origin = revealed.value === 'complete' ? 92 : revealed.value === 'delete' ? -92 : 0; delta.value = Math.max(-92, Math.min(92, origin + dx)); event.preventDefault() }
}
function onEnd() { if (dragging.value) return; const next = resolveSwipeReveal(delta.value, 0, !props.completedView); revealed.value = next; delta.value = next === 'complete' ? 92 : next === 'delete' ? -92 : 0; suppressClick.value = horizontal.value }
function runAction(action: Exclude<SwipeReveal, null>) { action === 'complete' ? emit('complete', props.task.id) : emit('remove', props.task.id); resetReveal() }
function closeRevealed(event: MouseEvent) { if (suppressClick.value) { suppressClick.value = false; event.preventDefault(); event.stopPropagation(); return } if (!revealed.value) return; event.preventDefault(); event.stopPropagation(); resetReveal() }

function beginDrag() {
  const row = rowElement.value
  if (!row) return
  const rect = row.getBoundingClientRect()
  dragOffsetY = startY.value - rect.top
  dragging.value = true
  floatingStyle.value = { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px` }
  navigator.vibrate?.(12)
  emit('reorder-start', props.task.id)
}
function onDragStart(event: PointerEvent) {
  if (!props.reorderable || props.completedView) return
  event.preventDefault(); event.stopPropagation(); requestCloseSwipeActions(props.task.id)
  startX.value = event.clientX; startY.value = event.clientY
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
  longPressTimer = window.setTimeout(beginDrag, 350)
}
function onDragMove(event: PointerEvent) {
  const moved = Math.abs(event.clientX - startX.value) > 7 || Math.abs(event.clientY - startY.value) > 7
  if (!dragging.value && moved) { clearLongPress(); return }
  if (!dragging.value) return
  event.preventDefault(); event.stopPropagation()
  floatingStyle.value = { ...floatingStyle.value, top: `${event.clientY - dragOffsetY}px` }
  emit('reorder-move', props.task.id, event.clientX, event.clientY)
}
function finishDrag(event: PointerEvent) {
  event.preventDefault(); event.stopPropagation(); clearLongPress()
  if (!dragging.value) return
  dragging.value = false; floatingStyle.value = {}; suppressClick.value = true; emit('reorder-end', props.task.id)
}
</script>
<template>
  <div class="task-swipe" :class="{ overdue: isOverdue(task), dragging }" :data-task-id="task.id">
    <button v-if="!completedView" class="swipe-action complete-action" @click="runAction('complete')">完成</button><button class="swipe-action delete-action" @click="runAction('delete')">删除</button>
    <article ref="rowElement" class="task-row" :class="{ dragging }" :style="dragging ? floatingStyle : { transform: `translateX(${delta}px)` }" @click.capture="closeRevealed" @pointerdown="onStart" @pointermove="onMove" @pointerup="onEnd" @pointercancel="onEnd">
      <button v-if="selectionMode" class="check" :class="{ checked: selected }" :disabled="!selectable" :aria-label="selectable ? '选择任务' : '该任务没有明确时间'" @click="emit('select', task.id)">✓</button>
      <button v-else class="check" :class="{ checked: completedView }" :aria-label="completedView ? '恢复任务' : '完成任务'" @click="completedView ? emit('restore', task.id) : emit('complete', task.id)"><span v-if="completedView">✓</span></button>
      <div class="task-main"><button class="task-title-button" @click="emit('edit', task)"><span class="task-title" :class="{ done: completedView }">{{ task.title }}</span></button><button class="task-date-button task-meta" :class="{ overdue: isOverdue(task) }" @click="emit('date', task)">{{ formatTaskDate(task) }}<template v-if="task.startTime"> · {{ task.startTime }}<template v-if="task.endTime">–{{ task.endTime }}</template></template><Bell v-if="task.reminderEnabled" class="task-reminder-icon" :size="13" :stroke-width="1.8" aria-label="开始时间提醒"/><template v-if="isOverdue(task)"> · 已过期</template></button></div>
      <button v-if="reorderable && !completedView" class="drag-handle" aria-label="长按并拖动以排序" title="长按拖动排序" @contextmenu.prevent @pointerdown.stop="onDragStart" @pointermove.stop="onDragMove" @pointerup.stop="finishDrag" @pointercancel.stop="finishDrag"><GripVertical :size="19" :stroke-width="1.8"/></button>
      <a v-if="task.url" class="url-link" :href="task.url" target="_blank" rel="noopener" aria-label="打开链接">↗</a>
      <span v-if="task.pinned" class="pin" aria-label="已置顶">★</span>
      <div class="desktop-actions"><IconButton v-if="completedView" label="恢复" @click="emit('restore', task.id)">↺</IconButton><IconButton v-else label="完成" @click="emit('complete', task.id)">✓</IconButton><IconButton label="删除" danger @click="emit('remove', task.id)">×</IconButton></div>
    </article>
  </div>
</template>
