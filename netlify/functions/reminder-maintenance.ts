import type { Config } from '@netlify/functions'
import { maintainReminderSchedules } from '../../server/reminders/maintenance.js'

export default async () => {
  await maintainReminderSchedules()
  return new Response(null, { status: 204 })
}

export const config: Config = { schedule: '*/5 * * * *' }
