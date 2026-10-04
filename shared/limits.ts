export const INPUT_LIMITS = {
  taskTitle: 240,
  taskNote: 50_000,
  draftContent: 10_000,
  profileTitle: 240,
  profileContent: 50_000,
  checklistSections: 30,
  checklistItems: 200,
  checklistText: 500,
  checklistSectionTitle: 120,
  checklistNote: 2000,
  reminders: 32
} as const

export const MAX_SYNC_CHANGES = 1000
export const MAX_SYNC_BATCH_BYTES = 240 * 1024
export const MAX_SYNC_ENTITY_BYTES = 220 * 1024
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
