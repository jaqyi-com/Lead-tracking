/**
 * Worker pool + scheduler (§4.1). Executes queued jobs and runs the sweepers that make Postgres —
 * not Redis — the durability layer (plan §3.1, §3.4).
 */
import { Worker, type Job } from "bullmq";
import { and, eq, gt, lte } from "drizzle-orm";
import { env, logger } from "@lead/config";
import { conversations, getDb, waNumbers } from "@lead/db";
import {
  BullSink,
  ORG_ID,
  failStaleSending,
  getMessagingProvider,
  purgeWebhookEvents,
  redisConnection,
  refreshReportViews,
  renewMailboxWatches,
  runJob,
  setEffectSink,
  sweepEnrollments,
  sweepTimers,
  syncTemplatesFromProvider,
  unprocessedEventIds,
  type JobName,
} from "@lead/core";

const connection = redisConnection();
const sink = new BullSink(connection.duplicate());
setEffectSink(sink);

const concurrency: Record<string, number> = { ingest: 8, outbound: 4, default: 8 };
const workers = (["ingest", "outbound", "default"] as const).map(
  (name) =>
    new Worker(
      name,
      async (job: Job) => runJob(job.name as JobName, job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 }),
      {
        connection: connection.duplicate(),
        concurrency: concurrency[name],
        // Outbound: protect quality rating with a hard per-worker cap (§11.2).
        ...(name === "outbound" ? { limiter: { max: 20, duration: 1000 } } : {}),
      },
    ),
);
for (const w of workers) {
  w.on("failed", (job, err) => logger.warn({ job: job?.name, id: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"));
  w.on("error", (err) => logger.error({ err }, "worker error"));
}

// ---------------------------------------------------------------------------
// Scheduler (single-leader via Redis lock so multiple worker instances don't double-run)
// ---------------------------------------------------------------------------

async function leader(name: string, ttlMs: number): Promise<boolean> {
  return (await connection.set(`lead-os:lock:${name}`, process.pid.toString(), "PX", ttlMs, "NX")) === "OK";
}

function every(name: string, ms: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    try {
      if (await leader(name, Math.max(ms - 500, 1000))) {
        const r = await fn();
        if (r) logger.debug({ task: name, result: r }, "scheduled task");
      }
    } catch (err) {
      logger.error({ err, task: name }, "scheduled task failed");
    }
  };
  setTimeout(tick, 2000);
  return setInterval(tick, ms);
}

const db = getDb();
const timers = [
  every("sweep-webhooks", 30_000, async () => {
    const ids = await unprocessedEventIds();
    if (ids.length) await sink.enqueue(ids.map((id) => ({ name: "ingest.process" as const, data: { webhookEventId: id }, opts: { jobId: `evt-${id}` } })));
    return ids.length;
  }),
  every("sweep-sla", 60_000, () => sweepTimers()),
  every("sweep-cadence", 60_000, () => sweepEnrollments()),
  every("sweep-stale-sending", 120_000, () => failStaleSending()),
  every("sweep-windows", 60_000, async () => {
    // Push "window closed" to open inboxes so composers flip to template mode (§5.3.3).
    const now = new Date();
    const closed = await db
      .select({ id: conversations.id, leadId: conversations.leadId })
      .from(conversations)
      .where(and(lte(conversations.windowExpiresAt, now), gt(conversations.windowExpiresAt, new Date(now.getTime() - 61_000))));
    if (closed.length) await sink.publish(closed.map((c) => ({ type: "conversation.updated" as const, orgId: ORG_ID, conversationId: c.id, leadId: c.leadId, data: { windowClosed: true } })));
    // Wake snoozed conversations.
    const due = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.state, "snoozed"), lte(conversations.snoozedUntil, now)));
    if (due.length) await sink.enqueue(due.map((c) => ({ name: "conversation.unsnooze" as const, data: { conversationId: c.id } })));
    return closed.length + due.length;
  }),
  every("refresh-reports", 5 * 60_000, () => refreshReportViews(db)),
  every("gmail-watch-renewal", 6 * 3600_000, () => renewMailboxWatches()),
  every("whatsapp-sync", 6 * 3600_000, async () => {
    if (env.MESSAGING_PROVIDER !== "cloud") return;
    await syncTemplatesFromProvider(db);
    const info = await getMessagingProvider().phoneNumberInfo();
    await db
      .insert(waNumbers)
      .values({ orgId: ORG_ID, phoneNumberId: env.WA_PHONE_NUMBER_ID, wabaId: env.WA_WABA_ID, displayNumber: info.displayNumber, qualityRating: info.qualityRating, messagingLimit: info.messagingLimit, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: waNumbers.phoneNumberId,
        set: { displayNumber: info.displayNumber, qualityRating: info.qualityRating, messagingLimit: info.messagingLimit, lastSyncedAt: new Date() },
      });
  }),
  every("retention", 24 * 3600_000, () => purgeWebhookEvents(db, 30)),
];

logger.info({ provider: env.MESSAGING_PROVIDER }, "worker started");

const shutdown = async () => {
  timers.forEach(clearInterval);
  await Promise.all(workers.map((w) => w.close()));
  await sink.close();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
