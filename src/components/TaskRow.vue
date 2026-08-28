<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { Task } from '../types'
import { formatTaskDate, isOverdue } from '../utils/date'
import IconButton from './IconButton.vue'
import { resolveSwipeReveal, type SwipeReveal } from '../utils/swipe'
import { listenForSwipeClose, requestCloseSwipeActions } from '../utils/swipeCoordinator'
import { Bell } from '@lucide/vue'
const props = defineProps<{ task: Task; selectionMode?: boolean; selectable?: boolean; selected?: boolean; completedView?: boolean; reorderable?: boolean }>()
const emit = defineEmits<{ edit: [Task]; date: [Task]; complete: [string]; restore: [string]; remove: [string]; select: [string]; 'reorder-start': [string]; 'reorder-move': [string, number, number]; 'reorder-end': [string] }>()
const startX = ref(0), startY = ref(0), delta = ref(0), horizontal = ref(false), revealed = ref<SwipeReveal>(null), suppressClick = ref(false), dragging = ref(false)
let longPressTimer: number | undefined
function clearLongPress() { window.clearTimeout(longPressTimer); longPressTimer = undefined }
function resetReveal() { revealed.value = null; delta.value = 0 }
let stopListening: (() => void) | undefined
onMounted(() => { stopListening = listenForSwipeClose(props.task.id, resetReveal) })
onUnmounted(() => stopListening?.())
function onStart(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.check,.url-link,.desktop-actions')) return
  requestCloseSwipeActions(props.task.id); startX.value = event.clientX; startY.value = event.clientY; horizontal.value = false
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
  if (props.reorderable && !props.completedView) longPressTimer = window.setTimeout(() => { dragging.value = true; suppressClick.value = true; navigator.vibrate?.(12); emit('reorder-start', props.task.id) }, 450)
}
function onMove(event: PointerEvent) {
  const dx = event.clientX - startX.value, dy = event.clientY - startY.value
  if (dragging.value) { emit('reorder-move', props.task.id, event.clientX, event.clientY); event.preventDefault(); return }
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearLongPress()
  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { horizontal.value = true; const origin = revealed.value === 'complete' ? 92 : revealed.value === 'delete' ? -92 : 0; delta.value = Math.max(-92, Math.min(92, origin + dx)); event.preventDefault() }
}
function onEnd() { clearLongPress(); if (dragging.value) { dragging.value = false; emit('reorder-end', props.task.id); return } const next = resolveSwipeReveal(delta.value, 0, !props.completedView); revealed.value = next; delta.value = next === 'complete' ? 92 : next === 'delete' ? -92 : 0; suppressClick.value = horizontal.value }
function runAction(action: Exclude<SwipeReveal, null>) { action === 'complete' ? emit('complete', props.task.id) : emit('remove', props.task.id); resetReveal() }
function closeRevealed(event: MouseEvent) { if (suppressClick.value) { suppressClick.value = false; event.preventDefault(); event.stopPropagation(); return } if (!revealed.value) return; event.preventDefault(); event.stopPropagation(); resetReveal() }
</script>
<template>
  <div class="task-swipe" :class="{ overdue: isOverdue(task), dragging }" :data-task-id="task.id">
    <button v-if="!completedView" class="swipe-action complete-action" @click="runAction('complete')">完成</button><button class="swipe-action delete-action" @click="runAction('delete')">删除</button>
    <article class="task-row" :style="{ transform: `translateX(${delta}px)` }" @click.capture="closeRevealed" @pointerdown="onStart" @pointermove="onMove" @pointerup="onEnd" @pointercancel="onEnd">
      <button v-if="selectionMode" class="check" :class="{ checked: selected }" :disabled="!selectable" :aria-label="selectable ? '选择任务' : '该任务没有明确时间'" @click="emit('select', task.id)">✓</button>
      <button v-else class="check" :class="{ checked: completedView }" :aria-label="completedView ? '恢复任务' : '完成任务'" @click="completedView ? emit('restore', task.id) : emit('complete', task.id)"><span v-if="completedView">✓</span></button>
      <div class="task-main"><button class="task-title-button" @click="emit('edit', task)"><span class="task-title" :class="{ done: completedView }">{{ task.title }}</span></button><button class="task-date-button task-meta" :class="{ overdue: isOverdue(task) }" @click="emit('date', task)">{{ formatTaskDate(task) }}<template v-if="task.startTime"> · {{ task.startTime }}<template v-if="task.endTime">–{{ task.endTime }}</template></template><Bell v-if="task.reminderEnabled" class="task-reminder-icon" :size="13" :stroke-width="1.8" aria-label="开始时间提醒"/><template v-if="isOverdue(task)"> · 已过期</template></button></div>
      <a v-if="task.url" class="url-link" :href="task.url" target="_blank" rel="noopener" aria-label="打开链接">↗</a>
      <span v-if="task.pinned" class="pin" aria-label="已置顶">★</span>
      <div class="desktop-actions"><IconButton v-if="completedView" label="恢复" @click="emit('restore', task.id)">↺</IconButton><IconButton v-else label="完成" @click="emit('complete', task.id)">✓</IconButton><IconButton label="删除" danger @click="emit('remove', task.id)">×</IconButton></div>
    </article>
  </div>
</template>
