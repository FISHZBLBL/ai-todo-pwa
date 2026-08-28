export type TaskSource = 'manual' | 'ai'

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
  reminderEnabled: boolean
  reminderAt?: string | null
  reminderEventId?: string | null
  reminderSentAt?: string | null
  pinned: boolean
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

export interface TodoExport {
  schemaVersion: number
  exportedAt: string
  tasks: Task[]
  drafts: Draft[]
  settings: Settings
}

export interface ParsedTask {
  title: string
  dueDate: string | null
  dateRange: DateRange | null
  startTime: string | null
  endTime: string | null
  url: string | null
  selected?: boolean
}

export interface SyncChange { entity: 'task' | 'draft' | 'settings'; value: Task | Draft | Settings; queuedAt: string }
