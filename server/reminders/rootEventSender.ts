// Delivery handlers persist the next occurrence directly in Cloudflare.
// No SDK event chain or polling scheduler is involved.
export { createAlarmEventSender as createRootEventSender } from './alarmClient.js'
