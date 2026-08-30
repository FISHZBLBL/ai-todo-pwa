export type TaskSource = 'manual' | 'ai'
export type ReminderMode = 'auto' | 'explicit' | 'off'
export type ReminderSource = 'auto' | 'explicit'
export interface TaskReminder { id: string; at: string; eventId: string | null; sentAt: string | null; source: ReminderSource }

export interface DateRange { start: string; end: string }

export interface Task {
  id: string
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
}

export interface ParsedTask {
  title: string
  dueDate: string | null
  dateRange: DateRange | null
  startTime: string | null
  endTime: string | null
  url: string | null
  reminders?: ParsedReminder[]
  selected?: boolean
}

export interface SyncChange { entity: 'task' | 'draft' | 'settings'; value: Task | Draft | Settings; queuedAt: string }
