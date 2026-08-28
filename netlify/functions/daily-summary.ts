import type { Config } from '@netlify/functions'
import { sendDailySummary } from '../../server/push.js'

export default async function dailySummary() {
  const result = await sendDailySummary(new Date())
  console.log('[daily-summary]', result)
  return new Response(null, { status: 204 })
}

export const config: Config = {
  schedule: '0 0 * * *'
}
