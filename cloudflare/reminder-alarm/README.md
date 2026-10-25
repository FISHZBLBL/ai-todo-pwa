# AI Todo reminder Alarm

This Worker replaces the Netlify Async Workloads scheduler. One SQLite-backed Durable Object stores reminder deadlines and arms its single Alarm for the earliest actual event. It has no Cron Trigger or interval. With no scheduled or in-flight event, its Alarm is deleted. The app, task database and Web Push sender remain on their existing hosts.

The Durable Object looks up the next deadline through a SQLite index, rather than loading or scanning the app's task database. Completed and cancelled event receipts are retained to make retries idempotent. A reminder ID should be a fresh UUID when its time changes.

## Configuration

`wrangler.jsonc` binds the `ReminderAlarm` SQLite class. Its nonsecret `REMINDER_CALLBACK_URL` must be the production HTTPS URL ending in `/api/reminders/deliver`. Store `REMINDER_SCHEDULER_SECRET` with Wrangler's secret manager and set the same secret in the Netlify function environment. Use at least 32 random bytes. Never put this secret in a Vite variable or commit it.

From this directory, install its separate development dependencies and use `npm run typecheck`, `npm run dev`, or `npm run deploy`. For local Wrangler development, put the secret in the ignored `.dev.vars` file. Run the repository's Vitest command to include `cloudflare/reminder-alarm/tests`.

The root application's deployment instructions describe activating this provider and migrating current reminders. Deploy and verify the Worker before switching the backend and removing the old Netlify schedulers.

## Authenticated API

All endpoints except `GET /health` require `Authorization: Bearer <REMINDER_SCHEDULER_SECRET>`. An unauthenticated request does not wake the Durable Object. Health exposes only a boolean `ready`; authenticated `GET /status` exposes counts (`active`, `dead`, `completed`, `cancelled`) and `nextAlarm`, without event data.

- `POST /events`: `{eventId,eventName,data,delayUntil}`; names are `todo.reminder` and `daily.summary`, and `delayUntil` is a Unix timestamp in milliseconds. Returns `{events:[{eventId,status}]}`. Replaying the same ID and payload leaves its original deadline and state unchanged; a conflicting payload returns 409. Cancelled IDs remain cancelled.
- `POST /events/import`: `{events:[...]}` with the same fields, at most 500 events. The whole import commits or fails atomically, preserving existing IDs for a migration.
- `DELETE /events`: `{eventIds:[...]}`, at most 500 IDs. Cancelling an unknown ID still saves a tombstone so a delayed registration cannot revive it.
- `GET /events/:id/steps/:stepKey`: returns `{found,value?}`.
- `PUT /events/:id/steps/:stepKey`: `{value}` saves a successful step once and returns `{found:true,value}`. A later write returns the original value. Both step endpoints also require `X-Reminder-Delivery-Token` from the current callback. Deleted events return 404; expired or superseded delivery tokens return 409. URL-encode IDs and step keys.

## Delivery and failure recovery

At a deadline the Worker posts `{eventId,eventName,eventData,attempt,deliveryToken,stepResults}` to the fixed callback URL, with the shared Bearer secret. `attempt` starts at zero. The backend uses the persistent step endpoints to cache successful Push and state-update steps before replying. No transaction is held during HTTP delivery, so callbacks can call the step API without deadlock.

A 2xx reply completes the event. Network failures, 429 and 5xx preserve the actual event and retry with exponential backoff capped at one hour, or with a JSON `retryAfterMs` value from the callback (clamped to 1 second–1 hour). These retries continue through an outage so a recurring reminder can resume when the backend recovers. They do not run when the queue is empty. Other HTTP statuses, including authentication failures, park the event as `dead` for configuration repair. A 90-second persisted delivery lease recovers interrupted executions. The outbound callback has a 70-second timeout and never follows redirects. At most four events are dispatched per Alarm; remaining due events arm another Alarm immediately.

Cloudflare Alarms provide at-least-once delivery. Persistent event IDs, leases, cancellation tombstones and step results prevent ordinary replay and state-save retries from repeating a successful step. An external Push request whose response is lost can still have an uncertain outcome; neither this queue nor the Web Push protocol provides a transaction spanning the push service and SQLite.

Relevant Cloudflare documentation: [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
