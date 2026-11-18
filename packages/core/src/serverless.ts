/**
 * Serverless mode (e.g. Vercel). There is no long-running BullMQ worker, so:
 *  - immediate jobs run in the background of the same invocation (waitUntil) after the response;
 *  - delayed jobs are dropped — every delayed job has a Postgres-backed sweeper that `runTick` runs;
 *  - realtime events are dropped (the web app polls instead).
 *
 * Correctness is unchanged because Postgres was always the durability layer (plan §3.1, §3.4).
 */
import { and, eq, isNotNull, lt, lte, or, sql, isNull } from "drizzle-orm";
import { logger } from "@lead/config";
import { attachments, conversations, getDb, messages, orgs } from "@lead/db";
import type { EffectSink, Job, RealtimeEvent } from "./effects";
import { runJob } from "./jobs";
import { sweepTimers } from "./sla";
import { sweepEnrollments } from "./cadence";
import { failStaleSending, sendMessage } from "./outbound";
import { fetchMedia, processWebhookEvent, renewMailboxWatches, unprocessedEventIds } from "./ingest/dispatch";
import { refreshReportViews } from "./reports";
import { purgeWebhookEvents } from "./admin";
import { ORG_ID } from "./support";

type WaitUntil = (p: Promise<unknown>) => void;

/** Vercel exposes waitUntil on a global request context (what @vercel/functions reads). */
export function vercelWaitUntil(): WaitUntil | null {
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: WaitUntil } } | undefined>)[Symbol.for("@vercel/request-context")];
  const fn = ctx?.get?.()?.waitUntil;
  return fn ? fn.bind(ctx) : null;
}

export function background(p: Promise<unknown>): void {
  const wait = vercelWaitUntil();
  const guarded = p.catch((err) => logger.error({ err }, "background task failed"));
  if (wait) wait(guarded);
}

export class ServerlessSink implements EffectSink {
  async enqueue(jobs: Job[]): Promise<void> {
    for (const j of jobs) {
      // Delayed work (SLA checks, cadence steps, scheduled sends, snoozes) is picked up by runTick.
      if (j.opts?.delay && j.opts.delay > 1000) continue;
      if (j.name === "outbound.simulate_status") continue;
      background(runJob(j.name, j.data, { attemptsMade: 0, maxAttempts: 1 }));
    }
  }
  async publish(_events: RealtimeEvent[]): Promise<void> {}
}

/**
 * One scheduler tick: every sweeper the BullMQ worker runs on intervals. Safe to call often and
 * concurrently — each step is idempotent and row-locked.
 */
export async function runTick(opts: { heavy?: boolean } = {}): Promise<Record<string, number>> {
  const db = getDb();
  const out: Record<string, number> = {};
  const step = async (name: string, fn: () => Promise<number | void>) => {
    try {
      out[name] = (await fn()) ?? 0;
    } catch (err) {
      logger.error({ err, step: name }, "tick step failed");
      out[name] = -1;
    }
  };

  await step("webhooks", async () => {
    const ids = await unprocessedEventIds(30_000);
    for (const id of ids) await processWebhookEvent(id).catch(() => undefined);
    return ids.length;
  });
  await step("outbound", async () => {
    // Scheduled sends that are now due, and retryable failures left in "queued".
    const due = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.status, "queued"),
          or(and(isNotNull(messages.sendAt), lte(messages.sendAt, new Date())), and(isNull(messages.sendAt), lt(messages.queuedAt, new Date(Date.now() - 20_000)))),
        ),
      )
      .limit(100);
    for (const m of due) await sendMessage(m.id).catch(() => undefined);
    return due.length;
  });
  await step("stale_sending", () => failStaleSending());
  await step("sla", () => sweepTimers());
  await step("cadence", () => sweepEnrollments());
  await step("media", async () => {
    const pending = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.status, "pending"), isNotNull(attachments.providerMediaId), lt(attachments.createdAt, new Date(Date.now() - 30_000))))
      .limit(50);
    for (const a of pending) await fetchMedia(a.id).catch(() => undefined);
    return pending.length;
  });
  await step("unsnooze", async () => {
    const r = await db
      .update(conversations)
      .set({ state: "waiting_us", snoozedUntil: null })
      .where(and(eq(conversations.state, "snoozed"), lte(conversations.snoozedUntil, new Date())))
      .returning({ id: conversations.id });
    return r.length;
  });
  if (opts.heavy) {
    await step("reports", async () => void (await refreshReportViews(db)));
    await step("gmail_watch", () => renewMailboxWatches());
    await step("retention", () => purgeWebhookEvents(db, 30));
  }
  return out;
}

/**
 * Piggy-back scheduler for plans without per-minute crons: at most one tick per `everyMs` across
 * all instances, claimed with a conditional UPDATE so only one request wins.
 */
export async function maybeTick(everyMs = 60_000): Promise<boolean> {
  const db = getDb();
  const cutoff = new Date(Date.now() - everyMs).toISOString();
  const claimed = await db
    .update(orgs)
    .set({ settings: sql`jsonb_set(${orgs.settings}, '{lastTickAt}', to_jsonb(now()::text))` })
    .where(and(eq(orgs.id, ORG_ID), sql`coalesce((${orgs.settings}->>'lastTickAt')::timestamptz, 'epoch') < ${cutoff}::timestamptz`))
    .returning({ id: orgs.id });
  if (!claimed.length) return false;
  const heavyCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const heavy = await db
    .update(orgs)
    .set({ settings: sql`jsonb_set(${orgs.settings}, '{lastHeavyTickAt}', to_jsonb(now()::text))` })
    .where(and(eq(orgs.id, ORG_ID), sql`coalesce((${orgs.settings}->>'lastHeavyTickAt')::timestamptz, 'epoch') < ${heavyCutoff}::timestamptz`))
    .returning({ id: orgs.id });
  await runTick({ heavy: heavy.length > 0 });
  return true;
}
