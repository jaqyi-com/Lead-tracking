/**
 * Job handler registry shared by the BullMQ worker and the inline test runner.
 */
import { eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { env, logger } from "@lead/config";
import { conversations, getDb, users } from "@lead/db";
import type { JobName } from "./effects";
import { withTx } from "./effects";
import { fetchMedia, processWebhookEvent, syncMailbox } from "./ingest/dispatch";
import { applyWhatsAppStatus, sendMessage } from "./outbound";
import { processTimer } from "./sla";
import { runEnrollment } from "./cadence";
import { enrichLead, scoreLeadById } from "./intelligence";
import { fanoutBroadcast } from "./broadcasts";
import { getSystemMailer } from "./providers/email";
import { ORG_ID } from "./support";

export type Handler = (data: Record<string, unknown>, meta: { attemptsMade: number; maxAttempts: number }) => Promise<unknown>;

let vapidReady = false;
function ensureVapid() {
  if (!vapidReady && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    vapidReady = true;
  }
  return vapidReady;
}

export const handlers: Record<JobName, Handler> = {
  "ingest.process": (d) => processWebhookEvent(String(d.webhookEventId)),
  "media.fetch": (d) => fetchMedia(String(d.attachmentId), d.contentBase64 as string | undefined),
  "mailbox.sync": (d) => syncMailbox(String(d.email)),
  "outbound.send": (d, meta) => sendMessage(String(d.messageId), { finalAttempt: meta.attemptsMade + 1 >= meta.maxAttempts }),
  "outbound.simulate_status": (d) =>
    withTx((tx, fx) =>
      applyWhatsAppStatus(tx, fx, {
        id: String(d.providerMessageId),
        status: String(d.status),
        timestamp: String(Math.floor(Date.now() / 1000)),
        pricing: { billable: true, category: "service" },
      }),
    ),
  "sla.check": (d) => processTimer(String(d.timerId)),
  "cadence.run": (d) => runEnrollment(String(d.enrollmentId)),
  "lead.enrich": async (d) => {
    await enrichLead(String(d.leadId));
    await scoreLeadById(getDb(), String(d.leadId));
  },
  "lead.score": (d) => scoreLeadById(getDb(), String(d.leadId)),
  "broadcast.fanout": (d) => fanoutBroadcast(getDb(), String(d.broadcastId)),
  "conversation.unsnooze": async (d) => {
    await withTx(async (tx, fx) => {
      const [c] = await tx.select().from(conversations).where(eq(conversations.id, String(d.conversationId)));
      if (!c || c.state !== "snoozed" || (c.snoozedUntil && c.snoozedUntil > new Date())) return;
      await tx.update(conversations).set({ state: "waiting_us", snoozedUntil: null }).where(eq(conversations.id, c.id));
      fx.publish({ type: "conversation.updated", orgId: ORG_ID, leadId: c.leadId, conversationId: c.id });
    });
  },
  "notify.push": async (d) => {
    if (!ensureVapid()) return;
    const ids = d.userIds as string[];
    const rows = await getDb().select({ id: users.id, subs: users.pushSubscriptions }).from(users).where(inArray(users.id, ids));
    const payload = JSON.stringify({ title: d.title, body: d.body, url: d.leadId ? `${env.APP_URL}/leads/${d.leadId}` : env.APP_URL });
    for (const r of rows) {
      const alive: unknown[] = [];
      for (const sub of r.subs) {
        try {
          await webpush.sendNotification(sub as webpush.PushSubscription, payload, { TTL: 3600 });
          alive.push(sub);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== 404 && status !== 410) alive.push(sub);
        }
      }
      if (alive.length !== r.subs.length) await getDb().update(users).set({ pushSubscriptions: alive }).where(eq(users.id, r.id));
    }
  },
  "notify.email": async (d) => {
    const ids = d.userIds as string[];
    const rows = await getDb().select({ email: users.email, name: users.name }).from(users).where(inArray(users.id, ids));
    for (const u of rows) {
      await getSystemMailer().send({
        from: env.SYSTEM_MAIL_FROM,
        to: [u.email],
        subject: String(d.title),
        text: `${d.body ?? ""}\n\nOpen: ${env.APP_URL}${d.leadId ? `/leads/${d.leadId}` : ""}`,
      });
    }
  },
};

export async function runJob(name: JobName, data: Record<string, unknown>, meta = { attemptsMade: 0, maxAttempts: 1 }) {
  const h = handlers[name];
  if (!h) throw new Error(`no handler for ${name}`);
  try {
    return await h(data, meta);
  } catch (err) {
    logger.error({ err, job: name }, "job failed");
    throw err;
  }
}
