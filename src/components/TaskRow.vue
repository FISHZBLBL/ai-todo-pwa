<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Task } from '../types'
import { formatTaskDate } from '../utils/date'
import IconButton from './IconButton.vue'
import { resolveSwipeReveal, type SwipeReveal } from '../utils/swipe'
import { listenForSwipeClose, requestCloseSwipeActions } from '../utils/swipeCoordinator'
import { Bell, GripVertical } from '@lucide/vue'
import { getTaskAttention } from '../utils/taskAttention'

const props = defineProps<{ task: Task; now?: Date; completedView?: boolean; reorderable?: boolean; reordering?: boolean; isDragSource?: boolean }>()
const emit = defineEmits<{ edit: [Task]; date: [Task]; complete: [string]; restore: [string]; remove: [string]; 'reorder-start': [string, number, number]; 'reorder-move': [string, number, number]; 'reorder-end': [string] }>()
const attention = computed(() => getTaskAttention(props.task, props.now ?? new Date()))
const startX = ref(0), startY = ref(0), delta = ref(0), horizontal = ref(false), revealed = ref<SwipeReveal>(null), suppressClick = ref(false), dragging = ref(false)
let longPressTimer: number | undefined
let activePointerId: number | undefined
function clearLongPress() { window.clearTimeout(longPressTimer); longPressTimer = undefined }
function resetReveal() { revealed.value = null; delta.value = 0 }
let stopListening: (() => void) | undefined
onMounted(() => { stopListening = listenForSwipeClose(props.task.id, resetReveal) })
onUnmounted(() => { stopListening?.(); stopGlobalDrag() })
function onStart(event: PointerEvent) {
  if (props.reordering) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.url-link,.desktop-actions,.drag-handle')) return
  requestCloseSwipeActions(props.task.id); startX.value = event.clientX; startY.value = event.clientY; horizontal.value = false
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent) {
  if (props.reordering) return
  const dx = event.clientX - startX.value, dy = event.clientY - startY.value
  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { horizontal.value = true; const origin = revealed.value === 'complete' ? 92 : revealed.value === 'delete' ? -92 : 0; delta.value = Math.max(-92, Math.min(92, origin + dx)); event.preventDefault() }
}
function onEnd() { if (props.reordering) return; const next = resolveSwipeReveal(delta.value, 0, !props.completedView); revealed.value = next; delta.value = next === 'complete' ? 92 : next === 'delete' ? -92 : 0; suppressClick.value = horizontal.value }
function runAction(action: Exclude<SwipeReveal, null>) { action === 'complete' ? emit('complete', props.task.id) : emit('remove', props.task.id); resetReveal() }
function closeRevealed(event: MouseEvent) { if (suppressClick.value) { suppressClick.value = false; event.preventDefault(); event.stopPropagation(); return } if (!revealed.value) return; event.preventDefault(); event.stopPropagation(); resetReveal() }
function beginDrag() { dragging.value = true; resetReveal(); navigator.vibrate?.(12); emit('reorder-start', props.task.id, startX.value, startY.value); window.addEventListener('pointermove', onGlobalDragMove, true); window.addEventListener('pointerup', onGlobalDragEnd, true); window.addEventListener('pointercancel', onGlobalDragEnd, true) }
function onDragStart(event: PointerEvent) { if (!props.reorderable || props.completedView) return; event.preventDefault(); event.stopPropagation(); requestCloseSwipeActions(props.task.id); startX.value = event.clientX; startY.value = event.clientY; activePointerId = event.pointerId; event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId); longPressTimer = window.setTimeout(beginDrag, 350) }
function emitDragMove(event: PointerEvent) { event.preventDefault(); event.stopPropagation(); emit('reorder-move', props.task.id, event.clientX, event.clientY) }
function onDragMove(event: PointerEvent) { const moved = Math.abs(event.clientX - startX.value) > 7 || Math.abs(event.clientY - startY.value) > 7; if (!dragging.value && moved) { clearLongPress(); return } if (dragging.value) emitDragMove(event) }
function stopGlobalDrag() { window.removeEventListener('pointermove', onGlobalDragMove, true); window.removeEventListener('pointerup', onGlobalDragEnd, true); window.removeEventListener('pointercancel', onGlobalDragEnd, true) }
function endDragging() { clearLongPress(); stopGlobalDrag(); activePointerId = undefined; if (!dragging.value) return; dragging.value = false; suppressClick.value = true; emit('reorder-end', props.task.id) }
function onGlobalDragMove(event: PointerEvent) { if (dragging.value && event.pointerId === activePointerId) emitDragMove(event) }
function onGlobalDragEnd(event: PointerEvent) { if (event.pointerId === activePointerId) endDragging() }
function finishDrag(event: PointerEvent) { event.preventDefault(); event.stopPropagation(); endDragging() }
</script>
<template>
  <div class="task-swipe" :class="{ overdue: attention?.overdue, 'drag-source': isDragSource }" :data-task-id="task.id">
    <button v-if="!reordering && !completedView" class="swipe-action complete-action" @click="runAction('complete')">完成</button><button v-if="!reordering" class="swipe-action delete-action" @click="runAction('delete')">删除</button>
    <article class="task-row" :style="{ transform: `translateX(${delta}px)` }" @click.capture="closeRevealed" @pointerdown="onStart" @pointermove="onMove" @pointerup="onEnd" @pointercancel="onEnd">
      <div class="task-main"><button class="task-title-button" @click="emit('edit', task)"><span class="task-title" :class="{ done: completedView }">{{ task.title }}</span></button><button class="task-date-button task-meta" :class="{ overdue: attention?.overdue, 'reminder-attention': attention?.reminderStatus }" @click="emit('date', task)">{{ formatTaskDate(task, now) }}<template v-if="task.startTime"> · {{ task.startTime }}<template v-if="task.endTime">–{{ task.endTime }}</template></template><Bell v-if="task.reminders?.length" class="task-reminder-icon" :class="{ attention: attention?.reminderStatus }" :size="13" :stroke-width="1.8" :aria-hidden="Boolean(attention?.reminderStatus)" :aria-label="attention?.reminderStatus ? undefined : '任务提醒'"/><template v-if="attention?.reminderStatus === 'sent'"> · 已提醒</template><template v-else-if="attention?.reminderStatus === 'unsent'"> · 提醒未送达</template><template v-if="attention?.overdue"> · 已过期</template></button></div>
      <button v-if="reorderable && !completedView" class="drag-handle" aria-label="长按并拖动以排序" title="长按拖动排序" @contextmenu.prevent @pointerdown.stop="onDragStart" @pointermove.stop="onDragMove" @pointerup.stop="finishDrag" @pointercancel.stop="finishDrag"><GripVertical :size="19" :stroke-width="1.8"/></button>
      <a v-if="task.url" class="url-link" :href="task.url" target="_blank" rel="noopener" aria-label="打开链接">↗</a><span v-if="task.pinned" class="pin" aria-label="已置顶">★</span>
      <div class="desktop-actions"><IconButton v-if="completedView" label="恢复" @click="emit('restore', task.id)">↺</IconButton><IconButton v-else label="完成" @click="emit('complete', task.id)">✓</IconButton><IconButton label="删除" danger @click="emit('remove', task.id)">×</IconButton></div>
    </article>
  </div>
</template>
