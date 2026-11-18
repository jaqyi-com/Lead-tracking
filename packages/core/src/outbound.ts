/**
 * §4.3 outbound path: every outbound message is a row first, a send second.
 * The composer writes a `queued` row; the worker calls the provider; status webhooks move it
 * sent → delivered → read (or failed). Rules are revalidated server-side at send time (§5.3.4).
 */
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { env } from "@lead/config";
import {
  attachments,
  conversations,
  leads,
  mailboxConnections,
  messages,
  templates,
  users,
  type Db,
  type MediaRef,
  type MessageStatus,
} from "@lead/db";
import {
  explainProviderError,
  makeReplyAddress,
  makeUnsubscribeToken,
  missingTemplateValues,
  windowState,
} from "@lead/domain";
import { withTx, type Fx } from "./effects";
import { DomainError, NotFoundError, ProviderError } from "./errors";
import { consentStatus } from "./consent";
import { contactRoutes } from "./identity";
import { onHumanOutbound, onSystemTouch } from "./leads";
import { getMessagingProvider } from "./providers/messaging";
import { getSystemMailer, newMessageId, type OutboundEmail } from "./providers/email";
import { GmailClient } from "./providers/gmail";
import { getStorage } from "./providers/storage";
import { fillTemplateValues, orderedParams, renderTemplate, varContextForLead } from "./templates";
import { ORG_ID, notify, preview, type Actor } from "./support";

export type Message = typeof messages.$inferSelect;

export type QueueInput = {
  conversationId: string;
  actor: Actor;
  type: "text" | "template" | "media" | "email";
  body?: string;
  bodyHtml?: string;
  templateId?: string;
  templateValues?: Record<string, string>;
  attachmentIds?: string[];
  subject?: string;
  cc?: string[];
  sendAt?: Date | null;
  idempotencyKey?: string;
  isAuto?: boolean;
  sequenceEnrollmentId?: string;
  broadcastId?: string;
  replyToContextId?: string;
  /** Bulk/cadence mail respects email unsubscribes (List-Unsubscribe is added at send time). */
  bulk?: boolean;
};

export async function queueMessage(tx: Db, fx: Fx, input: QueueInput): Promise<Message> {
  if (input.idempotencyKey) {
    const [dupe] = await tx.select().from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey));
    if (dupe) return dupe;
  }
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId));
  if (!conv) throw new NotFoundError("Conversation");
  const routes = await contactRoutes(tx, conv.contactId);
  const consent = await consentStatus(tx, conv.contactId);
  const now = new Date();

  let kind = "text";
  let body = input.body ?? null;
  let templateId: string | null = null;
  let templateVars: Record<string, string> | null = null;
  let media: MediaRef[] = [];
  let subject: string | null = null;
  let emailTo: string[] | null = null;

  if (input.attachmentIds?.length) {
    const atts = await tx.select().from(attachments).where(inArray(attachments.id, input.attachmentIds));
    media = atts.map((a) => ({
      attachmentId: a.id,
      kind: (a.mime ?? "").startsWith("image/") ? "image" : (a.mime ?? "").startsWith("video/") ? "video" : (a.mime ?? "").startsWith("audio/") ? "audio" : "document",
      filename: a.filename ?? undefined,
      mime: a.mime ?? undefined,
    }));
  }

  if (conv.channel === "whatsapp") {
    if (!routes.waId && !routes.phone) throw new DomainError("no_whatsapp", "This contact has no WhatsApp number");
    const win = windowState(conv.lastInboundAt, now);
    if (input.type === "template") {
      if (!input.templateId) throw new DomainError("template_required", "Choose a template");
      const [t] = await tx.select().from(templates).where(eq(templates.id, input.templateId));
      if (!t) throw new NotFoundError("Template");
      if (t.approvalStatus !== "approved") {
        throw new DomainError("template_not_approved", `Template "${t.internalName}" is ${t.approvalStatus}, not approved by Meta yet.`);
      }
      const businessInitiated = !win.open;
      if (businessInitiated) {
        if (consent.whatsapp.optedOut) throw new DomainError("opted_out", explainProviderError("opted_out"));
        const ok = t.category === "marketing" ? consent.whatsapp.marketing : consent.whatsapp.utility || consent.whatsapp.marketing;
        if (!ok) throw new DomainError("no_consent", explainProviderError("no_consent"));
      } else if (t.category === "marketing" && (consent.whatsapp.optedOut || !consent.whatsapp.marketing)) {
        throw new DomainError("no_consent", "Marketing templates need a marketing opt-in.");
      }
      const values = fillTemplateValues(t, await varContextForLead(tx, conv.leadId), input.templateValues ?? {});
      const missing = missingTemplateValues(t.body, values);
      if (missing.length) throw new DomainError("template_vars_missing", `Fill template variables: ${missing.map((m) => `{{${m}}}`).join(", ")}`);
      kind = "template";
      templateId = t.id;
      templateVars = values;
      body = renderTemplate(t, values);
    } else {
      if (!win.open && !input.sendAt) throw new DomainError("window_closed", explainProviderError("window_closed"));
      if (input.type === "media" && !media.length) throw new DomainError("media_required", "Attach a file");
      kind = input.type === "media" ? media[0]!.kind : "text";
      if (kind === "text" && !body?.trim()) throw new DomainError("empty", "Message is empty");
    }
  } else {
    if (!routes.email) throw new DomainError("no_email", "This contact has no email address");
    if (routes.emailInvalid) throw new DomainError("invalid_email", explainProviderError("invalid_email"));
    if (input.bulk && consent.email.unsubscribed) throw new DomainError("unsubscribed", "This contact unsubscribed from email.");
    if (!body?.trim() && !input.bodyHtml) throw new DomainError("empty", "Email body is empty");
    kind = "email";
    subject = input.subject?.trim() || (conv.subject ? (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`) : `Your enquiry with Doott`);
    emailTo = [routes.email];
  }

  const [msg] = await tx
    .insert(messages)
    .values({
      orgId: ORG_ID,
      conversationId: conv.id,
      leadId: conv.leadId,
      direction: "outbound",
      channel: conv.channel,
      authorType: input.actor.type === "user" ? "user" : "system",
      authorUserId: input.actor.type === "user" ? (input.actor.id ?? null) : null,
      kind,
      body,
      bodyHtml: input.bodyHtml ?? null,
      subject,
      templateId,
      templateVars,
      media,
      status: "queued",
      isAuto: input.isAuto ?? input.actor.type !== "user",
      sequenceEnrollmentId: input.sequenceEnrollmentId ?? null,
      broadcastId: input.broadcastId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      sendAt: input.sendAt ?? null,
      queuedAt: now,
      emailTo,
      emailCc: input.cc ?? null,
      replyToContextId: input.replyToContextId ?? null,
      recipientCountry: conv.channel === "whatsapp" ? countryOf(routes.phone ?? (routes.waId ? "+" + routes.waId : null)) : null,
    })
    .onConflictDoNothing()
    .returning();
  if (!msg) {
    const [dupe] = await tx.select().from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey!));
    return dupe!;
  }

  fx.publish({ type: "message.created", orgId: ORG_ID, leadId: conv.leadId, conversationId: conv.id, messageId: msg.id });
  const delay = input.sendAt ? Math.max(0, input.sendAt.getTime() - now.getTime()) : 0;
  fx.enqueue("outbound.send", { messageId: msg.id }, { delay, jobId: `send-${msg.id}` });
  return msg;
}

function countryOf(e164: string | null): string | null {
  if (!e164) return null;
  if (e164.startsWith("+91")) return "IN";
  if (e164.startsWith("+1")) return "US";
  return null;
}

// ---------------------------------------------------------------------------
// Worker: send
// ---------------------------------------------------------------------------

export async function sendMessage(messageId: string, opts: { finalAttempt?: boolean } = {}): Promise<MessageStatus> {
  const { getDb } = await import("@lead/db");
  const db = getDb();
  // Claim: queued → sending (only one worker wins).
  const [msg] = await db
    .update(messages)
    .set({ status: "sending" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "queued")))
    .returning();
  if (!msg) {
    const [cur] = await db.select({ status: messages.status }).from(messages).where(eq(messages.id, messageId));
    return cur?.status ?? "cancelled";
  }
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, msg.conversationId));
  const routes = await contactRoutes(db, conv!.contactId);

  try {
    let providerMessageId: string;
    let emailMessageId: string | null = null;
    let threadRef: string | null = null;

    if (msg.channel === "whatsapp") {
      const provider = getMessagingProvider();
      const to = routes.waId ? `+${routes.waId}` : routes.phone!;
      if (msg.kind !== "template") {
        // Server-side window check at send time — never trust the client's clock.
        const [fresh] = await db.select({ lastInboundAt: conversations.lastInboundAt }).from(conversations).where(eq(conversations.id, conv!.id));
        if (!windowState(fresh?.lastInboundAt ?? null).open) throw new ProviderError("window_closed", explainProviderError("window_closed"), false);
      }
      if (msg.kind === "template") {
        const [t] = await db.select().from(templates).where(eq(templates.id, msg.templateId!));
        if (!t || t.approvalStatus !== "approved") throw new ProviderError("132001", explainProviderError("132001"), false);
        const values = { ...(msg.templateVars ?? {}) };
        let headerDocument: { link: string; filename?: string } | undefined;
        if (t.header === "DOCUMENT" && msg.media[0]) {
          const [a] = await db.select().from(attachments).where(eq(attachments.id, msg.media[0].attachmentId));
          if (a?.storageKey) headerDocument = { link: await getStorage().signedUrl(a.storageKey, 3600), filename: a.filename ?? undefined };
        }
        ({ providerMessageId } = await provider.sendTemplate(to, {
          name: t.providerName,
          language: t.language,
          bodyParams: orderedParams(t, values),
          headerDocument,
        }));
        await db.update(templates).set({ usageCount: sql`${templates.usageCount} + 1` }).where(eq(templates.id, t.id));
      } else if (msg.media.length) {
        const ref = msg.media[0]!;
        const [a] = await db.select().from(attachments).where(eq(attachments.id, ref.attachmentId));
        if (!a?.storageKey) throw new ProviderError("media_missing", "Attachment is not stored yet", true);
        const data = await getStorage().get(a.storageKey);
        const mediaId = await provider.uploadMedia(data, a.mime ?? "application/octet-stream", a.filename ?? "file");
        ({ providerMessageId } = await provider.sendMedia(to, {
          kind: ref.kind as "image" | "document" | "audio" | "video",
          mediaId,
          caption: msg.body ?? undefined,
          filename: a.filename ?? undefined,
        }));
      } else {
        ({ providerMessageId } = await provider.sendText(to, msg.body ?? "", { replyToContextId: msg.replyToContextId ?? undefined }));
      }
    } else {
      const r = await sendEmailMessage(db, msg, conv!, routes.email!);
      providerMessageId = r.providerMessageId;
      emailMessageId = r.messageId;
      threadRef = r.threadId ?? null;
    }

    await withTx(async (tx, fx) => {
      const sentAt = new Date();
      await tx
        .update(messages)
        .set({ status: "sent", providerMessageId, sentAt, emailMessageId: emailMessageId ?? msg.emailMessageId, errorCode: null, errorMessage: null })
        .where(eq(messages.id, msg.id));
      await tx
        .update(conversations)
        .set({
          lastOutboundAt: sentAt,
          lastMessageAt: sentAt,
          lastMessagePreview: preview(msg.body ?? msg.subject),
          lastDirection: "outbound",
          // Only a human reply hands the ball to the client; an auto-ack or cadence touch leaves the
          // conversation waiting on us, so it stays in "Awaiting our reply".
          ...(msg.authorType === "user" ? { state: "waiting_client" as const } : {}),
          providerThreadRef: conv!.providerThreadRef ?? threadRef,
          updatedAt: sentAt,
        })
        .where(eq(conversations.id, conv!.id));
      if (msg.authorType === "user") await onHumanOutbound(tx, fx, msg.leadId, sentAt, msg.authorUserId);
      else await onSystemTouch(tx, msg.leadId);
      fx.publish({ type: "message.updated", orgId: ORG_ID, leadId: msg.leadId, conversationId: msg.conversationId, messageId: msg.id });
      if (msg.channel === "whatsapp" && getMessagingProvider().name === "fake") {
        fx.enqueue("outbound.simulate_status", { providerMessageId, status: "delivered" }, { delay: 1500 });
        fx.enqueue("outbound.simulate_status", { providerMessageId, status: "read" }, { delay: 4000 });
      }
    });
    return "sent";
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError("internal", (err as Error).message, true);
    if (pe.retryable && !opts.finalAttempt) {
      await db.update(messages).set({ status: "queued", errorCode: pe.code, errorMessage: pe.message }).where(eq(messages.id, msg.id));
      throw pe; // BullMQ retries with backoff
    }
    await markFailed(msg, pe.code, pe.message);
    return "failed";
  }
}

export async function markFailed(msg: Message, code: string, raw: string): Promise<void> {
  await withTx(async (tx, fx) => {
    await tx
      .update(messages)
      .set({ status: "failed", errorCode: code, errorMessage: explainProviderError(code, raw), failedAt: new Date() })
      .where(eq(messages.id, msg.id));
    fx.publish({ type: "message.updated", orgId: ORG_ID, leadId: msg.leadId, conversationId: msg.conversationId, messageId: msg.id });
    if (msg.authorUserId) {
      await notify(tx, fx, {
        userIds: [msg.authorUserId],
        type: "message_failed",
        title: "Message failed to send",
        body: explainProviderError(code, raw),
        leadId: msg.leadId,
        conversationId: msg.conversationId,
        push: false,
      });
    }
  });
}

async function sendEmailMessage(db: Db, msg: Message, conv: typeof conversations.$inferSelect, to: string) {
  // Thread onto the latest message in the conversation that has a Message-ID.
  const prior = await db
    .select({ mid: messages.emailMessageId })
    .from(messages)
    .where(and(eq(messages.conversationId, conv.id), isNotNull(messages.emailMessageId)))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  const refs = prior.map((p) => p.mid!).reverse();
  const inReplyTo = refs[refs.length - 1] ?? null;
  const replyAddress = makeReplyAddress(conv.leadId, env.APP_SECRET, env.INBOUND_DOMAIN);

  const atts: OutboundEmail["attachments"] = [];
  for (const ref of msg.media) {
    const [a] = await db.select().from(attachments).where(eq(attachments.id, ref.attachmentId));
    if (a?.storageKey) atts.push({ filename: a.filename ?? "attachment", content: await getStorage().get(a.storageKey), contentType: a.mime ?? "application/octet-stream" });
  }

  const headers: Record<string, string> = {};
  const bulk = !!msg.sequenceEnrollmentId || !!msg.broadcastId;
  if (bulk) {
    const [conRow] = await db.select({ contactId: conversations.contactId }).from(conversations).where(eq(conversations.id, conv.id));
    const token = makeUnsubscribeToken(conRow!.contactId, env.APP_SECRET);
    headers["List-Unsubscribe"] = `<${env.INGEST_PUBLIC_URL}/unsubscribe/${token}>, <mailto:${replyAddress}?subject=unsubscribe>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const author = msg.authorUserId ? (await db.select().from(users).where(eq(users.id, msg.authorUserId)))[0] : undefined;
  const [lead] = await db.select({ ownerId: leads.ownerId }).from(leads).where(eq(leads.id, conv.leadId));
  const mailboxOwner = msg.authorUserId ?? lead?.ownerId ?? null;
  const mailbox =
    (conv.mailboxConnectionId
      ? (await db.select().from(mailboxConnections).where(eq(mailboxConnections.id, conv.mailboxConnectionId)))[0]
      : undefined) ??
    (mailboxOwner
      ? (await db.select().from(mailboxConnections).where(and(eq(mailboxConnections.userId, mailboxOwner), eq(mailboxConnections.status, "active"))))[0]
      : undefined);

  const base: OutboundEmail = {
    from: "",
    to: [to],
    cc: msg.emailCc ?? undefined,
    subject: msg.subject ?? "Your enquiry with Doott",
    text: msg.body ?? "",
    html: msg.bodyHtml ?? undefined,
    inReplyTo,
    references: refs,
    headers,
    attachments: atts,
  };

  // One-to-one rep mail goes through the rep's own mailbox (§6.4) when connected.
  if (mailbox && mailbox.status === "active" && !bulk && msg.authorType === "user") {
    const client = new GmailClient(db, mailbox);
    const fromName = author?.name ?? "";
    return client.send(
      { ...base, from: fromName ? `"${fromName}" <${mailbox.email}>` : mailbox.email, messageId: newMessageId(mailbox.email.split("@")[1]) },
      conv.providerThreadRef ?? undefined,
    );
  }
  const display = author?.name ? `${author.name} at Doott` : "Doott Sales";
  const fromAddr = env.SYSTEM_MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? env.SYSTEM_MAIL_FROM;
  return getSystemMailer().send({ ...base, from: `"${display}" <${fromAddr}>`, replyTo: replyAddress, messageId: newMessageId() });
}

// ---------------------------------------------------------------------------
// Status webhooks
// ---------------------------------------------------------------------------

const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

export type WaStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
  pricing?: { billable?: boolean; category?: string; pricing_model?: string; type?: string };
};

export async function applyWhatsAppStatus(tx: Db, fx: Fx, s: WaStatus): Promise<boolean> {
  const [msg] = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.channel, "whatsapp"), eq(messages.providerMessageId, s.id)));
  if (!msg) return false;
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  const set: Partial<Message> = {};
  if (s.pricing) {
    if (s.pricing.category) set.pricingCategory = s.pricing.category;
    if (s.pricing.billable !== undefined) set.billable = s.pricing.billable;
  }
  if (s.status === "failed") {
    const e = s.errors?.[0];
    set.status = "failed";
    set.failedAt = at;
    set.errorCode = String(e?.code ?? "unknown");
    set.errorMessage = explainProviderError(e?.code, e?.error_data?.details ?? e?.title ?? e?.message);
  } else if ((RANK[s.status] ?? 0) > (RANK[msg.status] ?? 0) && msg.status !== "failed") {
    set.status = s.status as MessageStatus;
  }
  if (s.status === "sent" && !msg.sentAt) set.sentAt = at;
  if (s.status === "delivered" && !msg.deliveredAt) set.deliveredAt = at;
  if (s.status === "read") {
    if (!msg.readAt) set.readAt = at;
    if (!msg.deliveredAt) set.deliveredAt = at;
  }
  if (!Object.keys(set).length) return true;
  await tx.update(messages).set(set).where(eq(messages.id, msg.id));
  fx.publish({ type: "message.updated", orgId: ORG_ID, leadId: msg.leadId, conversationId: msg.conversationId, messageId: msg.id });
  if (set.status === "failed" && msg.authorUserId) {
    await notify(tx, fx, {
      userIds: [msg.authorUserId],
      type: "message_failed",
      title: "WhatsApp message failed",
      body: set.errorMessage ?? undefined,
      leadId: msg.leadId,
      conversationId: msg.conversationId,
      push: false,
    });
  }
  return true;
}

/** Stuck in "sending" for 10 minutes = the worker died mid-call. Fail visibly rather than risk a double send. */
export async function failStaleSending(): Promise<number> {
  const { getDb } = await import("@lead/db");
  const db = getDb();
  const stale = await db
    .select()
    .from(messages)
    .where(and(eq(messages.status, "sending"), lt(messages.queuedAt, new Date(Date.now() - 10 * 60_000))));
  for (const m of stale) await markFailed(m, "send_interrupted", "Send was interrupted — check WhatsApp/email before retrying.");
  return stale.length;
}

/** Rep clicked "retry" on a failed message: clone it as a new queued row. */
export async function retryMessage(tx: Db, fx: Fx, messageId: string, actor: Actor): Promise<Message> {
  const [m] = await tx.select().from(messages).where(eq(messages.id, messageId));
  if (!m) throw new NotFoundError("Message");
  if (m.status !== "failed") throw new DomainError("not_failed", "Only failed messages can be retried");
  return queueMessage(tx, fx, {
    conversationId: m.conversationId,
    actor,
    type: m.kind === "template" ? "template" : m.channel === "email" ? "email" : m.media.length ? "media" : "text",
    body: m.body ?? undefined,
    templateId: m.templateId ?? undefined,
    templateValues: m.templateVars ?? undefined,
    attachmentIds: m.media.map((x) => x.attachmentId),
    subject: m.subject ?? undefined,
  });
}

export async function cancelScheduled(tx: Db, messageId: string): Promise<void> {
  const r = await tx
    .update(messages)
    .set({ status: "cancelled" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "queued"), isNotNull(messages.sendAt)))
    .returning({ id: messages.id });
  if (!r.length) throw new DomainError("not_cancellable", "Only scheduled, unsent messages can be cancelled");
}

