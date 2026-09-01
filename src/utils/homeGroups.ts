import type { Task } from '../types'
import { addDays, formatTaskDate, nextWeekRange, toDateKey, weekendRange } from './date'
import { getTaskAttention } from './taskAttention'

export interface HomeTaskGroup {
  label: string
  key: string
  tasks: Task[]
  attention: boolean
}

export function buildHomeTaskGroups(tasks: Task[], now = new Date()): HomeTaskGroup[] {
  const attention = tasks
    .flatMap((task, index) => {
      const state = getTaskAttention(task, now)
      return state ? [{ task, index, attentionAt: state.attentionAt }] : []
    })
    .sort((left, right) => right.attentionAt - left.attentionAt || left.index - right.index)
    .map(item => item.task)

  const attentionIds = new Set(attention.map(task => task.id))
  const today = toDateKey(now), tomorrow = toDateKey(addDays(now, 1)), weekend = weekendRange(now), next = nextWeekRange(now)
  const map = new Map<string, Task[]>()
  const add = (label: string, task: Task) => map.set(label, [...(map.get(label) ?? []), task])

  for (const task of tasks) {
    if (attentionIds.has(task.id)) continue
    if (task.pinned) add('置顶', task)
    else if (task.dueDate === today) add('今天', task)
    else if (task.dueDate === tomorrow) add('明天', task)
    else if (task.dateRange?.start === weekend.start && task.dateRange.end === weekend.end) add('本周末', task)
    else if (task.dateRange?.start === next.start && task.dateRange.end === next.end) add('下周', task)
    else if (task.dueDate || task.dateRange) add(formatTaskDate(task, now), task)
    else add('无日期', task)
  }

  const groups = [...map.entries()].map(([label, groupedTasks]) => ({ label, key: label, tasks: groupedTasks, attention: false }))
  return attention.length ? [{ label: '需处理', key: 'attention', tasks: attention, attention: true }, ...groups] : groups
}
