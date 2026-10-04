export type TaskSource = 'manual' | 'ai'
export type TaskKind = 'task' | 'checklist'
export type ReminderMode = 'auto' | 'explicit' | 'off'
export type ReminderSource = 'auto' | 'explicit'
export type ReminderRecurrenceUnit = 'day' | 'week'
export type ReminderRecurrenceEnd = 'never' | 'count' | 'date'
export interface ReminderRecurrence {
  unit: ReminderRecurrenceUnit
  interval: number
  end: ReminderRecurrenceEnd
  count: number | null
  until: string | null
  occurrence: number
  timezone: string
  /** Show a decreasing amount of time until the final occurrence. */
  countdown: boolean
}
export interface TaskReminder { id: string; at: string; eventId: string | null; sentAt: string | null; source: ReminderSource; recurrence?: ReminderRecurrence | null }

export interface DateRange { start: string; end: string }

export interface ChecklistItem {
  id: string
  text: string
  completed: boolean
  completedAt?: string | null
}

export interface ChecklistSection {
  id: string
  title: string
  note?: string | null
  items: ChecklistItem[]
}

export interface ChecklistContent { sections: ChecklistSection[] }

export interface Task {
  id: string
  /** Missing on legacy records; repositories normalize them to ordinary tasks. */
  kind?: TaskKind
  title: string
  note?: string | null
  url?: string | null
  dueDate?: string | null
  dateRange?: DateRange | null
  startTime?: string | null
  endTime?: string | null
  reminderMode: ReminderMode
  reminders: TaskReminder[]
  pinned: boolean
  /** Manual position within the current date group; omitted for legacy tasks. */
  sortOrder?: number | null
  completed: boolean
  completedAt?: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  recurrence?: null
  source: TaskSource
  checklist?: ChecklistContent | null
}

export type DraftStatus = 'idle' | 'parsing' | 'failed' | 'parsed'
export interface Draft {
  id: string
  content: string
  createdAt: string
  updatedAt: string
  aiParseStatus: DraftStatus
  lastError?: string | null
  deletedAt?: string | null
}

/** A private, free-form personal record. Titles are intentionally optional. */
export interface ProfileEntry {
  id: string
  title: string | null
  content: string
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
}

export interface Settings {
  id: 'settings'
  dailySummaryTime: string
  timezone: string
  schemaVersion: number
  updatedAt: string
  lastSyncAt?: string | null
  notificationPermission?: NotificationPermission | 'unsupported'
}

export type ReminderPeriod = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night'
export interface ParsedReminder {
  requested: true
  date: string | null
  time: string | null
  /** Preview-only wording for an explicitly requested but still ambiguous reminder. */
  period: ReminderPeriod | null
  recurrence?: Omit<ReminderRecurrence, 'occurrence' | 'timezone'> | null
}

export interface ParsedTask {
  kind?: 'task'
  title: string
  dueDate: string | null
  dateRange: DateRange | null
  startTime: string | null
  endTime: string | null
  url: string | null
  reminders?: ParsedReminder[]
  selected?: boolean
}

export interface ParsedChecklistItem { text: string; selected?: boolean }
export interface ParsedChecklistSection { title: string; note?: string | null; items: ParsedChecklistItem[] }
export interface ParsedChecklist {
  kind: 'checklist'
  title: string
  sections: ParsedChecklistSection[]
  selected?: boolean
}
export type ParsedInboxItem = ParsedTask | ParsedChecklist

export interface SyncChange { entity: 'task' | 'draft' | 'profile' | 'settings'; value: Task | Draft | ProfileEntry | Settings; queuedAt: string }
