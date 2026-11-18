/**
 * The channel-agnostic heart of ingestion (§3.1 steps 3–10, §4.2):
 * normalised inbound → identity → lead decision → conversation → message → routing → SLA →
 * acknowledgement → notify → realtime push. Runs in one transaction per message.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { attachments, channelIdentities, conversations, leads, messages, parseFailures, type Channel, type Db, type MediaRef } from "@lead/db";
import { detectLanguage, isOptInMessage, isOptOutMessage, windowExpiry } from "@lead/domain";
import { withTx, type Fx } from "../effects";
import { autoAcknowledge } from "../ack";
import { ensureEnquiryConsent, recordConsent, withdrawConsent } from "../consent";
import { bumpUnread, getOrCreateConversation, type Conversation } from "../conversations";
import { resolveContact, type IdentityInput } from "../identity";
import { createLead, decideLead, getLead, onClientMessage, onHumanOutbound, type Lead } from "../leads";
import { queueMessage } from "../outbound";
import { routeLead } from "../routing";
import { ORG_ID, SYSTEM, logActivity, notify, preview } from "../support";

export type PendingMedia = {
  providerMediaId?: string;
  content?: Buffer;
  mime?: string;
  filename?: string;
  caption?: string;
  kind: string;
};

export type InboundMessage = {
  channel: Channel;
  providerMessageId: string;
  receivedAt: Date;
  identities: IdentityInput[];
  name?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  city?: string | null;
  state?: string | null;
  kind: string;
  body: string | null;
  bodyFull?: string | null;
  bodyHtml?: string | null;
  subject?: string | null;
  media?: PendingMedia[];
  source: string;
  sourceDetail?: string | null;
  portalLeadId?: string | null;
  /** From reply-address or header threading: attach here if open. */
  threadLeadId?: string | null;
  waNumberId?: string | null;
  toAddress?: string | null;
  mailboxConnectionId?: string | null;
  providerThreadRef?: string | null;
  email?: { messageId?: string | null; inReplyTo?: string | null; references?: string[]; from?: string; to?: string[]; cc?: string[] };
  replyToContextId?: string | null;
  /** Inbound OOO / auto-responder: logged, never counts as a reply. */
  isAutoReply?: boolean;
  isJunk?: boolean;
  junkReason?: string | null;
  /** Form submissions don't open the WhatsApp window. */
  opensWindow?: boolean;
  parseFailure?: { parser: string; reason: string; raw: unknown; webhookEventId?: string } | null;
  isPortal?: boolean;
  /** Explicit marketing opt-in captured with this enquiry (e.g. form checkbox). */
  marketingOptIn?: { channel: "whatsapp" | "email" | "all"; noticeVersion?: string; ip?: string; evidence: Record<string, unknown> } | null;
  /** Skip auto-ack (e.g. historical sync). */
  historical?: boolean;
};

export type InboundResult = {
  status: "created_lead" | "attached" | "duplicate" | "auto_reply_logged";
  leadId?: string;
  conversationId?: string;
  messageId?: string;
};

export async function processInbound(msg: InboundMessage): Promise<InboundResult> {
  return withTx((tx, fx) => processInboundTx(tx, fx, msg));
}

export async function processInboundTx(tx: Db, fx: Fx, msg: InboundMessage): Promise<InboundResult> {
  // Idempotency on the provider's message id (duplicates and retries are normal).
  const [dupe] = await tx
    .select({ id: messages.id, leadId: messages.leadId, conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.channel, msg.channel), eq(messages.providerMessageId, msg.providerMessageId)));
  if (dupe) return { status: "duplicate", leadId: dupe.leadId, conversationId: dupe.conversationId, messageId: dupe.id };

  // Auto-replies only ever attach to an existing open lead — never create contacts or leads.
  if (msg.isAutoReply && !msg.threadLeadId) {
    const known = msg.identities.length
      ? await tx
          .select({ contactId: channelIdentities.contactId })
          .from(channelIdentities)
          .where(
            and(
              eq(channelIdentities.orgId, ORG_ID),
              inArray(channelIdentities.valueNormalised, msg.identities.map((i) => i.value)),
            ),
          )
          .limit(1)
      : [];
    if (!known.length) return { status: "auto_reply_logged" };
    const [open] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.contactId, known[0]!.contactId), isNull(leads.closedAt)))
      .limit(1);
    if (!open) return { status: "auto_reply_logged" };
  }

  const { contact, company } = await resolveContact(tx, {
    identities: msg.identities,
    name: msg.name,
    jobTitle: msg.jobTitle,
    companyName: msg.companyName,
    companyDomain: msg.companyDomain,
    city: msg.city,
    state: msg.state,
    source: msg.source,
  });

  // ---- Lead decision ----
  let lead: Lead | null = null;
  let isNewLead = false;
  if (msg.portalLeadId) {
    // Portals send duplicate notifications: same portal lead id → same lead.
    const [same] = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.orgId, ORG_ID), eq(leads.source, msg.source), eq(leads.portalLeadId, msg.portalLeadId)));
    if (same) lead = same;
  }
  let previousLeadId: string | null = null;
  if (!lead && msg.threadLeadId) {
    const threaded = await getLead(tx, msg.threadLeadId).catch(() => null);
    if (threaded && !threaded.closedAt && threaded.contactId === contact.id) lead = threaded;
    else if (threaded && !threaded.closedAt) lead = threaded; // reply from a colleague on the same thread
    else if (threaded) previousLeadId = threaded.id; // closed: new opportunity linked to it
  }
  if (!lead) {
    if (msg.isAutoReply) {
      // Never open a lead from an out-of-office reply.
      return { status: "auto_reply_logged" };
    }
    const decision = await decideLead(tx, fx, contact.id, msg.receivedAt);
    lead = decision.attachTo;
    previousLeadId = previousLeadId ?? decision.previousLeadId;
  }
  if (!lead) {
    lead = await createLead(tx, fx, {
      contactId: contact.id,
      companyId: company?.id ?? null,
      source: msg.source,
      sourceDetail: msg.sourceDetail ?? null,
      portalLeadId: msg.portalLeadId ?? null,
      enquiry: preview(msg.body, 500) || msg.subject || null,
      language: detectLanguage(msg.body),
      previousLeadId,
      firstInboundAt: msg.receivedAt,
      parseFailed: !!msg.parseFailure,
      isJunk: !!msg.isJunk,
    });
    isNewLead = true;
  }

  // ---- Conversation & message ----
  const { conversation } = await getOrCreateConversation(tx, {
    leadId: lead.id,
    contactId: contact.id,
    channel: msg.channel,
    assignedTo: lead.ownerId,
    subject: msg.subject ?? null,
    providerThreadRef: msg.providerThreadRef ?? null,
    waNumberId: msg.waNumberId ?? null,
    toAddress: msg.toAddress ?? null,
    mailboxConnectionId: msg.mailboxConnectionId ?? null,
    isJunk: !!msg.isJunk,
  });

  const priorClientMessages = isNewLead
    ? 0
    : (
        await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.leadId, lead.id), eq(messages.direction, "inbound"), eq(messages.isAutoReply, false)))
          .limit(1)
      ).length;

  const [row] = await tx
    .insert(messages)
    .values({
      orgId: ORG_ID,
      conversationId: conversation.id,
      leadId: lead.id,
      direction: "inbound",
      channel: msg.channel,
      authorType: "contact",
      providerMessageId: msg.providerMessageId,
      kind: msg.kind,
      body: msg.body,
      bodyFull: msg.bodyFull ?? null,
      bodyHtml: msg.bodyHtml ?? null,
      subject: msg.subject ?? null,
      status: "received",
      receivedAt: msg.receivedAt,
      isAutoReply: !!msg.isAutoReply,
      emailMessageId: msg.email?.messageId ?? null,
      inReplyTo: msg.email?.inReplyTo ?? null,
      references: msg.email?.references?.join(" ") ?? null,
      emailFrom: msg.email?.from ?? null,
      emailTo: msg.email?.to ?? null,
      emailCc: msg.email?.cc ?? null,
      replyToContextId: msg.replyToContextId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { status: "duplicate", leadId: lead.id, conversationId: conversation.id };

  // Media: create rows now, fetch in the media worker (never on the request path).
  const media: MediaRef[] = [];
  for (const m of msg.media ?? []) {
    const [a] = await tx
      .insert(attachments)
      .values({
        orgId: ORG_ID,
        ownerType: "message",
        ownerId: row.id,
        providerMediaId: m.providerMediaId ?? null,
        filename: m.filename ?? null,
        mime: m.mime ?? null,
        size: m.content?.length ?? null,
        status: "pending",
      })
      .returning();
    media.push({ attachmentId: a!.id, kind: m.kind, filename: m.filename, mime: m.mime, caption: m.caption });
    fx.enqueue("media.fetch", {
      attachmentId: a!.id,
      ...(m.content ? { contentBase64: m.content.toString("base64") } : {}),
    });
  }
  if (media.length) await tx.update(messages).set({ media }).where(eq(messages.id, row.id));

  const convPatch: Partial<Conversation> = {
    lastMessageAt: msg.receivedAt,
    lastMessagePreview: preview(msg.body ?? msg.subject ?? `[${msg.kind}]`),
    lastDirection: "inbound",
    updatedAt: new Date(),
  };
  if (!msg.isAutoReply) {
    convPatch.state = "waiting_us";
    if (msg.opensWindow !== false) {
      convPatch.lastInboundAt = msg.receivedAt;
      if (msg.channel === "whatsapp") convPatch.windowExpiresAt = windowExpiry(msg.receivedAt);
    }
    if (conversation.state === "snoozed" || conversation.state === "closed") convPatch.snoozedUntil = null;
  }
  await tx.update(conversations).set(convPatch).where(eq(conversations.id, conversation.id));
  await bumpUnread(tx, conversation.id);

  await logActivity(tx, lead.id, msg.isAutoReply ? "auto_reply_received" : "message_received", { type: "contact", id: contact.id }, {
    channel: msg.channel,
    messageId: row.id,
    preview: preview(msg.body, 200),
  }, msg.receivedAt);

  if (msg.parseFailure) {
    await tx.insert(parseFailures).values({
      orgId: ORG_ID,
      leadId: lead.id,
      parser: msg.parseFailure.parser,
      reason: msg.parseFailure.reason,
      raw: msg.parseFailure.raw as object,
      webhookEventId: msg.parseFailure.webhookEventId ?? null,
    });
  }

  // ---- Consent ----
  if (msg.channel === "whatsapp" && !msg.isAutoReply && msg.opensWindow !== false) {
    if (isOptOutMessage(msg.body)) {
      await withdrawConsent(tx, contact.id, "whatsapp", "keyword_stop", { messageId: row.id, text: msg.body });
      await logActivity(tx, lead.id, "opted_out", { type: "contact", id: contact.id }, { channel: "whatsapp", text: msg.body });
      // Confirmation is a free-form reply inside the window the STOP just opened.
      await queueMessage(tx, fx, {
        conversationId: conversation.id,
        actor: SYSTEM,
        type: "text",
        body: "You've been unsubscribed from Doott updates on WhatsApp. Reply START to opt back in. You can still message us any time.",
        isAuto: true,
        idempotencyKey: `optout:${row.id}`,
      }).catch(() => undefined);
    } else if (isOptInMessage(msg.body)) {
      await recordConsent(tx, { contactId: contact.id, channel: "whatsapp", purpose: "all", state: "granted", basis: "whatsapp_opt_in", evidence: { messageId: row.id, text: msg.body } });
    } else {
      await ensureEnquiryConsent(tx, contact.id, "whatsapp", { messageId: row.id });
    }
  } else if (isNewLead && !msg.isJunk) {
    const phoneRoute = msg.identities.find((i) => i.kind === "phone");
    if (phoneRoute) await ensureEnquiryConsent(tx, contact.id, "whatsapp", { source: msg.source, messageId: row.id });
    if (msg.identities.some((i) => i.kind === "email")) await ensureEnquiryConsent(tx, contact.id, "email", { source: msg.source, messageId: row.id });
  }
  if (msg.marketingOptIn) {
    await recordConsent(tx, {
      contactId: contact.id,
      channel: msg.marketingOptIn.channel,
      purpose: "marketing",
      state: "granted",
      basis: "form_opt_in",
      evidence: msg.marketingOptIn.evidence,
      noticeVersion: msg.marketingOptIn.noticeVersion,
      ip: msg.marketingOptIn.ip,
    });
  }

  // ---- Routing, SLA, acknowledgement, notifications ----
  if (isNewLead) {
    if (!lead.isJunk) {
      await routeLead(tx, fx, lead.id, { text: msg.body, channel: msg.channel, language: detectLanguage(msg.body) });
      lead = await getLead(tx, lead.id);
      if (!msg.historical) {
        const [freshConv] = await tx.select().from(conversations).where(eq(conversations.id, conversation.id));
        await autoAcknowledge(tx, fx, {
          lead,
          conversation: freshConv!,
          isPortal: msg.isPortal,
          portalEmail: msg.identities.find((i) => i.kind === "email")?.value ?? null,
        });
      }
      if (!lead.ownerId) {
        const { managerIds } = await import("../support");
        await notify(tx, fx, {
          userIds: await managerIds(tx),
          type: "lead_unassigned",
          title: `New ${msg.source.replace(/_/g, " ")} lead L-${lead.number} is unassigned`,
          body: preview(msg.body, 120),
          leadId: lead.id,
          conversationId: conversation.id,
        });
      }
    }
  } else if (!msg.isAutoReply) {
    await onClientMessage(tx, fx, lead, msg.receivedAt, conversation.id, priorClientMessages === 0 && !lead.touchCount);
    await notify(tx, fx, {
      userIds: [lead.ownerId],
      type: "client_message",
      title: `${contact.displayName ?? "Client"} replied on ${msg.channel === "whatsapp" ? "WhatsApp" : "email"}`,
      body: preview(msg.body, 120),
      leadId: lead.id,
      conversationId: conversation.id,
    });
  }

  fx.enqueue("lead.score", { leadId: lead.id });
  fx.publish({ type: "message.created", orgId: ORG_ID, leadId: lead.id, conversationId: conversation.id, messageId: row.id });
  fx.publish({ type: "conversation.updated", orgId: ORG_ID, leadId: lead.id, conversationId: conversation.id });
  return { status: isNewLead ? "created_lead" : "attached", leadId: lead.id, conversationId: conversation.id, messageId: row.id };
}

/**
 * Outbound messages we didn't send from the app: WhatsApp coexistence echoes (rep replied from the
 * phone app) and Gmail-synced mail the rep sent from Gmail directly. Recorded as human outbound so
 * timelines stay complete and SLA measurement is honest (§5.7).
 */
export type ExternalOutbound = {
  channel: Channel;
  providerMessageId: string;
  sentAt: Date;
  identities: IdentityInput[];
  authorType: "phone_app" | "user";
  authorUserId?: string | null;
  kind: string;
  body: string | null;
  bodyFull?: string | null;
  subject?: string | null;
  threadLeadId?: string | null;
  email?: { messageId?: string | null; inReplyTo?: string | null; references?: string[]; from?: string; to?: string[]; cc?: string[] };
  mailboxConnectionId?: string | null;
  providerThreadRef?: string | null;
  waNumberId?: string | null;
  media?: PendingMedia[];
};

export async function recordExternalOutbound(o: ExternalOutbound): Promise<InboundResult> {
  return withTx(async (tx, fx) => {
    const [dupe] = await tx
      .select({ id: messages.id, leadId: messages.leadId })
      .from(messages)
      .where(and(eq(messages.channel, o.channel), eq(messages.providerMessageId, o.providerMessageId)));
    if (dupe) return { status: "duplicate", leadId: dupe.leadId, messageId: dupe.id };
    // Also dedupe Gmail copies of mail we sent through the app.
    if (o.email?.messageId) {
      const [ours] = await tx.select({ id: messages.id, leadId: messages.leadId }).from(messages).where(eq(messages.emailMessageId, o.email.messageId));
      if (ours) return { status: "duplicate", leadId: ours.leadId, messageId: ours.id };
    }

    const { contact, company } = await resolveContact(tx, { identities: o.identities, source: "manual" });
    let lead: Lead | null = null;
    if (o.threadLeadId) {
      const l = await getLead(tx, o.threadLeadId).catch(() => null);
      if (l && !l.closedAt) lead = l;
    }
    if (!lead) lead = (await decideLead(tx, fx, contact.id, o.sentAt)).attachTo;
    if (!lead) {
      if (o.channel === "email") {
        // A rep emailing someone new from Gmail isn't an inbound enquiry — don't invent a lead.
        return { status: "auto_reply_logged" };
      }
      lead = await createLead(tx, fx, {
        contactId: contact.id,
        companyId: company?.id ?? null,
        source: "manual",
        sourceDetail: "Started from the WhatsApp phone app",
        ownerId: o.authorUserId ?? null,
        stage: "attempting",
        startTimers: false,
      });
    }
    const { conversation } = await getOrCreateConversation(tx, {
      leadId: lead.id,
      contactId: contact.id,
      channel: o.channel,
      assignedTo: lead.ownerId,
      subject: o.subject ?? null,
      providerThreadRef: o.providerThreadRef ?? null,
      mailboxConnectionId: o.mailboxConnectionId ?? null,
      waNumberId: o.waNumberId ?? null,
    });
    const [row] = await tx
      .insert(messages)
      .values({
        orgId: ORG_ID,
        conversationId: conversation.id,
        leadId: lead.id,
        direction: "outbound",
        channel: o.channel,
        authorType: o.authorType,
        authorUserId: o.authorUserId ?? null,
        providerMessageId: o.providerMessageId,
        kind: o.kind,
        body: o.body,
        bodyFull: o.bodyFull ?? null,
        subject: o.subject ?? null,
        status: "sent",
        sentAt: o.sentAt,
        queuedAt: o.sentAt,
        emailMessageId: o.email?.messageId ?? null,
        inReplyTo: o.email?.inReplyTo ?? null,
        references: o.email?.references?.join(" ") ?? null,
        emailFrom: o.email?.from ?? null,
        emailTo: o.email?.to ?? null,
        emailCc: o.email?.cc ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return { status: "duplicate", leadId: lead.id };
    const media: MediaRef[] = [];
    for (const m of o.media ?? []) {
      const [a] = await tx
        .insert(attachments)
        .values({ orgId: ORG_ID, ownerType: "message", ownerId: row.id, providerMediaId: m.providerMediaId ?? null, filename: m.filename ?? null, mime: m.mime ?? null, status: "pending" })
        .returning();
      media.push({ attachmentId: a!.id, kind: m.kind, filename: m.filename, mime: m.mime, caption: m.caption });
      fx.enqueue("media.fetch", { attachmentId: a!.id, ...(m.content ? { contentBase64: m.content.toString("base64") } : {}) });
    }
    if (media.length) await tx.update(messages).set({ media }).where(eq(messages.id, row.id));
    await tx
      .update(conversations)
      .set({ lastOutboundAt: o.sentAt, lastMessageAt: o.sentAt, lastMessagePreview: preview(o.body ?? o.subject), lastDirection: "outbound", state: "waiting_client", updatedAt: new Date() })
      .where(eq(conversations.id, conversation.id));
    await logActivity(tx, lead.id, "message_sent_externally", { type: o.authorType, id: o.authorUserId ?? null }, {
      channel: o.channel,
      via: o.authorType === "phone_app" ? "WhatsApp Business app" : "Gmail",
      messageId: row.id,
    }, o.sentAt);
    await onHumanOutbound(tx, fx, lead.id, o.sentAt, o.authorUserId ?? null);
    fx.publish({ type: "message.created", orgId: ORG_ID, leadId: lead.id, conversationId: conversation.id, messageId: row.id });
    return { status: "attached", leadId: lead.id, conversationId: conversation.id, messageId: row.id };
  });
}
