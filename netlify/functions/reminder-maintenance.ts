import type { Config } from '@netlify/functions'
import { maintainReminderSchedules } from '../../server/reminders/maintenance.js'

export default async () => {
  await maintainReminderSchedules()
  return new Response(null, { status: 204 })
}

// Normal changes and completed workloads schedule their own next events.
// Only scan the full state hourly to recover missed scheduling failures.
export const config: Config = { schedule: '0 * * * *' }
