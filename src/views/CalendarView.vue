<script setup lang="ts">
import { computed, ref } from 'vue'
import { CalendarDays, ChevronLeft, ChevronRight } from '@lucide/vue'
import TaskRow from '../components/TaskRow.vue'
import { useTaskStore } from '../stores/tasks'
import type { Task } from '../types'
import { activeCalendarTaskCounts, activeTasksForDate, dateFromKey, monthGrid, taskDotCount } from '../utils/calendar'
import { toDateKey } from '../utils/date'

const emit = defineEmits<{ close: []; edit: [Task] }>()
const store = useTaskStore()
const today = new Date()
const todayKey = toDateKey(today)
const selectedDate = ref(todayKey)
const visibleMonth = ref(new Date(today.getFullYear(), today.getMonth(), 1))

const days = computed(() => monthGrid(visibleMonth.value))
const taskCounts = computed(() => activeCalendarTaskCounts(store.tasks, days.value))
const selectedTasks = computed(() => activeTasksForDate(store.tasks, selectedDate.value))
const selectedDateLabel = computed(() => new Intl.DateTimeFormat('zh-CN', {
  month: 'long', day: 'numeric', weekday: 'long',
}).format(dateFromKey(selectedDate.value)))
const monthLabel = computed(() => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long',
}).format(visibleMonth.value))

function changeMonth(offset: number) {
  visibleMonth.value = new Date(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth() + offset, 1)
}

function selectDay(day: { date: Date; key: string; inVisibleMonth: boolean }) {
  selectedDate.value = day.key
  if (!day.inVisibleMonth) visibleMonth.value = new Date(day.date.getFullYear(), day.date.getMonth(), 1)
}

function goToday() {
  selectedDate.value = todayKey
  visibleMonth.value = new Date(today.getFullYear(), today.getMonth(), 1)
}
</script>

<template>
  <main class="full-view calendar-view">
    <header class="view-header">
      <button @click="emit('close')">返回</button>
      <h1>日历</h1>
      <span />
    </header>

    <div class="calendar-layout">
      <section class="calendar-panel" aria-label="任务日历">
        <div class="calendar-month-controls">
          <button aria-label="上个月" @click="changeMonth(-1)"><ChevronLeft :size="20" /></button>
          <strong>{{ monthLabel }}</strong>
          <button aria-label="下个月" @click="changeMonth(1)"><ChevronRight :size="20" /></button>
          <button class="calendar-today" @click="goToday">今天</button>
        </div>
        <div class="calendar-weekdays" aria-hidden="true"><span v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday">{{ weekday }}</span></div>
        <div class="calendar-grid">
          <button
            v-for="day in days"
            :key="day.key"
            class="calendar-day"
            :class="{ selected: day.key === selectedDate, today: day.key === todayKey && day.key !== selectedDate, outside: !day.inVisibleMonth }"
            :aria-label="day.key"
            :aria-pressed="day.key === selectedDate"
            @click="selectDay(day)"
          >
            <span>{{ day.date.getDate() }}</span>
            <i v-if="taskDotCount(taskCounts.get(day.key))" class="calendar-dots" aria-hidden="true"><b v-for="dot in taskDotCount(taskCounts.get(day.key))" :key="dot" /></i>
          </button>
        </div>
      </section>

      <section class="calendar-tasks">
        <div class="calendar-task-heading"><div><CalendarDays :size="18" /><h2>{{ selectedDateLabel }}</h2></div><span>{{ selectedTasks.length ? `${selectedTasks.length} 项待办` : '暂无待办' }}</span></div>
        <div v-if="selectedTasks.length" class="calendar-task-rows">
          <TaskRow
            v-for="task in selectedTasks"
            :key="task.id"
            :task="task"
            @edit="emit('edit', task)"
            @date="emit('edit', task)"
            @complete="store.complete"
            @restore="store.restore"
            @remove="store.softDelete"
          />
        </div>
        <p v-else class="calendar-empty">这一天还没有未完成的任务。</p>
      </section>
    </div>
  </main>
</template>
