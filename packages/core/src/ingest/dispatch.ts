/**
 * Queue entry point for raw webhook events (§4.2). The ingest endpoint only stores + enqueues;
 * everything here runs in the worker, and failures are recorded on the row for replay.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb, mailboxConnections, webhookEvents, type Db } from "@lead/db";
import { logger } from "@lead/config";
import { getMessagingProvider } from "../providers/messaging";
import { getStorage } from "../providers/storage";
import { attachments } from "@lead/db";
import { fromPostmark, fromRawMime, processEmail, type PostmarkInbound } from "./email";
import { processForm, formSchema } from "./form";
import { processWhatsAppPayload, type WhatsAppPayload } from "./whatsapp";
import { GmailClient } from "../providers/gmail";
import { ProviderError } from "../errors";
import type { Fx } from "../effects";

export type StoredEvent = typeof webhookEvents.$inferSelect;

export async function storeWebhookEvent(
  db: Db,
  e: { provider: string; externalId: string; payload: unknown; headers?: Record<string, unknown>; signatureOk: boolean },
): Promise<{ id: string; duplicate: boolean }> {
  const [row] = await db
    .insert(webhookEvents)
    .values({ provider: e.provider, externalId: e.externalId, payload: e.payload as object, headers: e.headers ?? {}, signatureOk: e.signatureOk })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (row) return { id: row.id, duplicate: false };
  const [existing] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, e.provider), eq(webhookEvents.externalId, e.externalId)));
  return { id: existing!.id, duplicate: true };
}

export async function processWebhookEvent(id: string): Promise<void> {
  const db = getDb();
  const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  if (!ev || ev.processedAt) return;
  if (!ev.signatureOk) {
    await db.update(webhookEvents).set({ processedAt: new Date(), error: "signature rejected" }).where(eq(webhookEvents.id, id));
    return;
  }
  await db.update(webhookEvents).set({ attempts: sql`${webhookEvents.attempts} + 1` }).where(eq(webhookEvents.id, id));
  try {
    switch (ev.provider) {
      case "whatsapp":
        await processWhatsAppPayload(ev.payload as WhatsAppPayload, ev.id);
        break;
      case "postmark":
        await processEmail(fromPostmark(ev.payload as PostmarkInbound), null, ev.id);
        break;
      case "form": {
        const p = ev.payload as { form: unknown; ip?: string };
        await processForm(formSchema.parse(p.form), { eventId: ev.id, ip: p.ip, receivedAt: ev.receivedAt });
        break;
      }
      case "gmail": {
        const p = ev.payload as { emailAddress: string; historyId: string };
        await syncMailbox(p.emailAddress, p.historyId);
        break;
      }
      default:
        throw new Error(`unknown provider ${ev.provider}`);
    }
    await db.update(webhookEvents).set({ processedAt: new Date(), error: null }).where(eq(webhookEvents.id, id));
  } catch (err) {
    logger.error({ err, webhookEventId: id, provider: ev.provider }, "webhook processing failed");
    await db.update(webhookEvents).set({ error: String((err as Error).stack ?? err).slice(0, 4000) }).where(eq(webhookEvents.id, id));
    throw err;
  }
}

/** Sweeper (plan §3.1): re-enqueue events that never got processed (Redis loss, crash). */
export async function unprocessedEventIds(olderThanMs = 60_000, maxAttempts = 8): Promise<string[]> {
  const rows = await getDb()
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        isNull(webhookEvents.processedAt),
        lt(webhookEvents.receivedAt, new Date(Date.now() - olderThanMs)),
        lt(webhookEvents.attempts, maxAttempts),
      ),
    )
    .limit(500);
  return rows.map((r) => r.id);
}

/** Admin replay after a bug fix (dead-letter replay, §5.7). */
export async function replayEvent(id: string, fx: Fx): Promise<void> {
  await getDb().update(webhookEvents).set({ processedAt: null, attempts: 0, error: null }).where(eq(webhookEvents.id, id));
  fx.enqueue("ingest.process", { webhookEventId: id }, { jobId: `replay-${id}-${Date.now()}` });
}

// ---------------------------------------------------------------------------
// Media worker
// ---------------------------------------------------------------------------

export async function fetchMedia(attachmentId: string, contentBase64?: string): Promise<void> {
  const db = getDb();
  const [a] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!a || a.status === "stored") return;
  try {
    let data: Buffer;
    let mime = a.mime ?? "application/octet-stream";
    if (contentBase64) data = Buffer.from(contentBase64, "base64");
    else if (a.providerMediaId) {
      const r = await getMessagingProvider().fetchMedia(a.providerMediaId);
      data = r.data;
      mime = r.mime || mime;
    } else throw new Error("no media source");
    const ext = (a.filename?.split(".").pop() ?? mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const now = new Date();
    const key = `media/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${a.id}.${ext}`;
    await getStorage().put(key, data, mime);
    await db.update(attachments).set({ storageKey: key, mime, size: data.length, status: "stored", error: null }).where(eq(attachments.id, a.id));
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : true;
    await db.update(attachments).set({ status: retryable ? "pending" : "failed", error: (err as Error).message }).where(eq(attachments.id, a.id));
    if (retryable) throw err;
  }
}

// ---------------------------------------------------------------------------
// Gmail mailbox sync (§6.1 B)
// ---------------------------------------------------------------------------

export async function syncMailbox(emailAddress: string, _pushedHistoryId?: string): Promise<number> {
  const db = getDb();
  const [conn] = await db.select().from(mailboxConnections).where(eq(mailboxConnections.email, emailAddress.toLowerCase()));
  if (!conn || conn.status === "disconnected") return 0;
  const client = new GmailClient(db, conn);
  let ids: string[];
  let newHistoryId: string | undefined;
  try {
    if (!conn.historyId) throw new ProviderError("404", "no history id", false);
    const h = await client.historySince(conn.historyId);
    ids = h.messageIds;
    newHistoryId = h.historyId;
  } catch (err) {
    if (!(err instanceof ProviderError) || err.code !== "404") throw err;
    // History too old or first sync: fall back to recent messages.
    ids = await client.recentMessageIds();
    newHistoryId = (await client.profile()).historyId;
  }
  let n = 0;
  for (const id of ids) {
    const { raw, labelIds, threadId } = await client.getRaw(id);
    if (labelIds.includes("SPAM") || labelIds.includes("DRAFT")) continue;
    const e = await fromRawMime(raw, id, { gmailThreadId: threadId, isSentByMailboxOwner: labelIds.includes("SENT") });
    await processEmail(e, { id: conn.id, email: conn.email, userId: conn.userId });
    n++;
  }
  if (newHistoryId) await db.update(mailboxConnections).set({ historyId: newHistoryId }).where(eq(mailboxConnections.id, conn.id));
  return n;
}

export async function renewMailboxWatches(): Promise<number> {
  const db = getDb();
  const conns = await db.select().from(mailboxConnections).where(eq(mailboxConnections.status, "active"));
  let n = 0;
  for (const c of conns) {
    if (c.watchExpiresAt && c.watchExpiresAt.getTime() > Date.now() + 2 * 86_400_000) continue;
    try {
      const w = await new GmailClient(db, c).watch();
      await db
        .update(mailboxConnections)
        .set({ watchExpiresAt: w.expiration, historyId: c.historyId ?? w.historyId, lastError: null })
        .where(eq(mailboxConnections.id, c.id));
      n++;
    } catch (err) {
      await db.update(mailboxConnections).set({ lastError: (err as Error).message }).where(eq(mailboxConnections.id, c.id));
    }
  }
  return n;
}
