// Durable alarms retry the individual failed event. No recurring maintenance
// function or empty-queue scan is needed.
export default async () => new Response(null, { status: 410 })
