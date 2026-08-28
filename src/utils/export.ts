import type { TodoExport, Task } from '../types'
import { draftRepository } from '../repositories/draftRepository'
import { taskRepository } from '../repositories/taskRepository'
import { db, getSettings, saveSettings, SCHEMA_VERSION } from '../storage/database'
export { migrateExport } from '../storage/migrations'
import { migrateExport } from '../storage/migrations'

export async function createExport(): Promise<TodoExport> {
  return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tasks: await taskRepository.list(true), drafts: await draftRepository.list(true), settings: await getSettings() }
}

export async function importData(raw: unknown, mode: 'merge' | 'replace') {
  const data = migrateExport(raw)
  if (mode === 'replace') {
    const importedAt = new Date().toISOString()
    const database = await db()
    await database.clear('syncQueue')
    const taskIds = new Set(data.tasks.map(item => item.id))
    const draftIds = new Set(data.drafts.map(item => item.id))
    for (const item of await taskRepository.list(true)) if (!taskIds.has(item.id)) await taskRepository.save({ ...item, deletedAt: importedAt, updatedAt: importedAt })
    for (const item of await draftRepository.list(true)) if (!draftIds.has(item.id)) await draftRepository.save({ ...item, deletedAt: importedAt, updatedAt: importedAt })
    for (const incoming of data.tasks) await taskRepository.save({ ...incoming, updatedAt: importedAt })
    for (const incoming of data.drafts) await draftRepository.save({ ...incoming, updatedAt: importedAt })
    await saveSettings({ ...data.settings, updatedAt: importedAt }, true)
    return
  }
  const existingTasks = new Map((await taskRepository.list(true)).map(item => [item.id, item]))
  for (const incoming of data.tasks) {
    const existing = existingTasks.get(incoming.id)
    if (!existing || incoming.updatedAt > existing.updatedAt) await taskRepository.save(incoming)
  }
  const existingDrafts = new Map((await draftRepository.list(true)).map(item => [item.id, item]))
  for (const incoming of data.drafts) {
    const existing = existingDrafts.get(incoming.id)
    if (!existing || incoming.updatedAt > existing.updatedAt) await draftRepository.save(incoming)
  }
  await saveSettings(data.settings, true)
}

const icsDate = (date: string, time: string) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`
const escapeIcs = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(',', '\\,').replaceAll(';', '\\;').replaceAll('\n', '\\n')
export function tasksToIcs(tasks: Task[], timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const eligible = tasks.filter(task => task.dueDate && task.startTime && !task.deletedAt)
  if (!eligible.length) throw new Error('请选择至少一个有明确日期和时间的任务')
  const events = eligible.map(task => {
    const start = new Date(`${task.dueDate}T${task.startTime}:00`)
    const endDate = new Date(start.getTime() + 30 * 60_000)
    const endDateKey = `${endDate.getFullYear()}-${`${endDate.getMonth() + 1}`.padStart(2, '0')}-${`${endDate.getDate()}`.padStart(2, '0')}`
    const fallbackEnd = `${`${endDate.getHours()}`.padStart(2, '0')}:${`${endDate.getMinutes()}`.padStart(2, '0')}`
    const end = task.endTime ? `${task.dueDate!.replaceAll('-', '')}T${task.endTime.replace(':', '')}00` : icsDate(endDateKey, fallbackEnd)
    return ['BEGIN:VEVENT', `UID:${task.id}@ai-todo`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`, `DTSTART;TZID=${timezone}:${icsDate(task.dueDate!, task.startTime!)}`, `DTEND;TZID=${timezone}:${end}`, `SUMMARY:${escapeIcs(task.title)}`, task.note ? `DESCRIPTION:${escapeIcs(task.note)}` : '', task.url ? `URL:${task.url}` : '', 'END:VEVENT'].filter(Boolean).join('\r\n')
  }).join('\r\n')
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//AI Todo//CN\r\nCALSCALE:GREGORIAN\r\n${events}\r\nEND:VCALENDAR\r\n`
}

export function downloadText(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
