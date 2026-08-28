<script setup lang="ts">
import { ref } from 'vue'
import type { Task } from '../types'
import { formatTaskDate, isOverdue } from '../utils/date'
import IconButton from './IconButton.vue'
import { resolveSwipeReveal, type SwipeReveal } from '../utils/swipe'
const props = defineProps<{ task: Task; selectionMode?: boolean; selectable?: boolean; selected?: boolean; completedView?: boolean }>()
const emit = defineEmits<{ edit: [Task]; date: [Task]; complete: [string]; restore: [string]; remove: [string]; select: [string] }>()
const startX = ref(0), startY = ref(0), delta = ref(0), horizontal = ref(false), revealed = ref<SwipeReveal>(null), suppressClick = ref(false)
function onStart(event: PointerEvent) { startX.value = event.clientX; startY.value = event.clientY; horizontal.value = false; event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId) }
function onMove(event: PointerEvent) { const dx = event.clientX - startX.value, dy = event.clientY - startY.value; if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { horizontal.value = true; const origin = revealed.value === 'complete' ? 92 : revealed.value === 'delete' ? -92 : 0; delta.value = Math.max(-92, Math.min(92, origin + dx)); event.preventDefault() } }
function onEnd() { const next = resolveSwipeReveal(delta.value, 0, !props.completedView); revealed.value = next; delta.value = next === 'complete' ? 92 : next === 'delete' ? -92 : 0; suppressClick.value = horizontal.value }
function runAction(action: Exclude<SwipeReveal, null>) { action === 'complete' ? emit('complete', props.task.id) : emit('remove', props.task.id); revealed.value = null; delta.value = 0 }
function closeRevealed(event: MouseEvent) { if (suppressClick.value) { suppressClick.value = false; event.preventDefault(); event.stopPropagation(); return } if (!revealed.value) return; event.preventDefault(); event.stopPropagation(); revealed.value = null; delta.value = 0 }
</script>
<template>
  <div class="task-swipe" :class="{ overdue: isOverdue(task) }">
    <button v-if="!completedView" class="swipe-action complete-action" @click="runAction('complete')">完成</button><button class="swipe-action delete-action" @click="runAction('delete')">删除</button>
    <article class="task-row" :style="{ transform: `translateX(${delta}px)` }" @click.capture="closeRevealed" @pointerdown="onStart" @pointermove="onMove" @pointerup="onEnd" @pointercancel="onEnd">
      <button v-if="selectionMode" class="check" :class="{ checked: selected }" :disabled="!selectable" :aria-label="selectable ? '选择任务' : '该任务没有明确时间'" @click="emit('select', task.id)">✓</button>
      <button v-else class="check" :class="{ checked: completedView }" :aria-label="completedView ? '恢复任务' : '完成任务'" @click="completedView ? emit('restore', task.id) : emit('complete', task.id)"><span v-if="completedView">✓</span></button>
      <div class="task-main"><button class="task-title-button" @click="emit('edit', task)"><span class="task-title" :class="{ done: completedView }">{{ task.title }}</span></button><button class="task-date-button task-meta" :class="{ overdue: isOverdue(task) }" @click="emit('date', task)">{{ formatTaskDate(task) }}<template v-if="task.startTime"> · {{ task.startTime }}<template v-if="task.endTime">–{{ task.endTime }}</template></template><template v-if="task.reminderEnabled"> · 🔔</template><template v-if="isOverdue(task)"> · 已过期</template></button></div>
      <a v-if="task.url" class="url-link" :href="task.url" target="_blank" rel="noopener" aria-label="打开链接">↗</a>
      <span v-if="task.pinned" class="pin" aria-label="已置顶">★</span>
      <div class="desktop-actions"><IconButton v-if="completedView" label="恢复" @click="emit('restore', task.id)">↺</IconButton><IconButton v-else label="完成" @click="emit('complete', task.id)">✓</IconButton><IconButton label="删除" danger @click="emit('remove', task.id)">×</IconButton></div>
    </article>
  </div>
</template>
