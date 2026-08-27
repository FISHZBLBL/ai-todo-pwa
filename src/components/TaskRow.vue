<script setup lang="ts">
import { ref } from 'vue'
import type { Task } from '../types'
import { formatTaskDate, isOverdue } from '../utils/date'
import IconButton from './IconButton.vue'
const props = defineProps<{ task: Task; selectionMode?: boolean; selectable?: boolean; selected?: boolean; completedView?: boolean }>()
const emit = defineEmits<{ edit: [Task]; date: [Task]; complete: [string]; restore: [string]; remove: [string]; select: [string] }>()
const startX = ref(0), startY = ref(0), delta = ref(0), horizontal = ref(false)
function onStart(event: TouchEvent) { startX.value = event.touches[0].clientX; startY.value = event.touches[0].clientY; delta.value = 0; horizontal.value = false }
function onMove(event: TouchEvent) { const dx = event.touches[0].clientX - startX.value, dy = event.touches[0].clientY - startY.value; if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { horizontal.value = true; delta.value = Math.max(-92, Math.min(92, dx)); event.preventDefault() } }
function onEnd() { if (delta.value > 64 && !props.completedView) emit('complete', props.task.id); else if (delta.value < -64) emit('remove', props.task.id); delta.value = 0 }
</script>
<template>
  <div class="task-swipe" :class="{ overdue: isOverdue(task) }">
    <div class="swipe-action complete-action">完成</div><div class="swipe-action delete-action">删除</div>
    <article class="task-row" :style="{ transform: `translateX(${delta}px)` }" @touchstart="onStart" @touchmove="onMove" @touchend="onEnd">
      <button v-if="selectionMode" class="check" :class="{ checked: selected }" :disabled="!selectable" :aria-label="selectable ? '选择任务' : '该任务没有明确时间'" @click="emit('select', task.id)">✓</button>
      <button v-else class="check" :class="{ checked: completedView }" :aria-label="completedView ? '恢复任务' : '完成任务'" @click="completedView ? emit('restore', task.id) : emit('complete', task.id)"><span v-if="completedView">✓</span></button>
      <div class="task-main"><button class="task-title-button" @click="emit('edit', task)"><span class="task-title" :class="{ done: completedView }">{{ task.title }}</span></button><button class="task-date-button task-meta" :class="{ overdue: isOverdue(task) }" @click="emit('date', task)">{{ formatTaskDate(task) }}<template v-if="task.time"> · {{ task.time }}<template v-if="task.endTime">–{{ task.endTime }}</template></template><template v-if="isOverdue(task)"> · 已过期</template></button></div>
      <a v-if="task.url" class="url-link" :href="task.url" target="_blank" rel="noopener" aria-label="打开链接">↗</a>
      <span v-if="task.pinned" class="pin" aria-label="已置顶">★</span>
      <div class="desktop-actions"><IconButton v-if="completedView" label="恢复" @click="emit('restore', task.id)">↺</IconButton><IconButton v-else label="完成" @click="emit('complete', task.id)">✓</IconButton><IconButton label="删除" danger @click="emit('remove', task.id)">×</IconButton></div>
    </article>
  </div>
</template>
