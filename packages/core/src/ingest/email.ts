/**
 * §6 email ingestion. Two capture paths feed one processor:
 *  A. Inbound parse domain (Postmark Inbound JSON) — sales@, info@, per-lead reply addresses
 *  B. Gmail mailbox sync (raw MIME via mailparser) — mail sent to a rep's own address
 *
 * Threading (§6.3), in order: reply-address tag → In-Reply-To/References → subject heuristic.
 * Edge cases (§6.5): auto-replies, bounces, internal forwards, spam, portal leads.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import { env } from "@lead/config";
import { leads, messages, notes, getDb } from "@lead/db";
import {
  classifySpam,
  htmlToText,
  isAutoReply,
  isPortalSender,
  normaliseEmail,
  normalisePhone,
  normaliseSubject,
  parseAddressList,
  parsePortalEmail,
  parseReplyAddress,
  stripQuotedReply,
} from "@lead/domain";
import { withTx } from "../effects";
import { markEmailInvalid, type IdentityInput } from "../identity";
import { markFailed } from "../outbound";
import { ORG_ID, SYSTEM, logActivity } from "../support";
import { processInbound, recordExternalOutbound, type InboundResult, type PendingMedia } from "./inbound";

export type NormalizedEmail = {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { email: string; name: string | null };
  to: string[];
  cc: string[];
  replyTo: string | null;
  deliveredTo: string[];
  subject: string;
  text: string;
  html: string | null;
  date: Date;
  headers: Record<string, string>;
  attachments: { filename: string; mime: string; content: Buffer }[];
  providerId: string;
  gmailThreadId?: string | null;
  isSentByMailboxOwner?: boolean;
};

export type MailboxContext = { id: string; email: string; userId: string | null } | null;

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

type PostmarkAddress = { Email: string; Name?: string; MailboxHash?: string };
export type PostmarkInbound = {
  MessageID: string;
  From: string;
  FromFull?: PostmarkAddress;
  FromName?: string;
  To?: string;
  ToFull?: PostmarkAddress[];
  Cc?: string;
  CcFull?: PostmarkAddress[];
  ReplyTo?: string;
  OriginalRecipient?: string;
  Subject?: string;
  Date?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; Content: string; ContentType: string; ContentLength: number }[];
};

const splitIds = (v: string | undefined | null) => (v ?? "").match(/<[^>]+>/g) ?? [];

export function fromPostmark(p: PostmarkInbound): NormalizedEmail {
  const headers: Record<string, string> = {};
  for (const h of p.Headers ?? []) headers[h.Name.toLowerCase()] = h.Value;
  const mid = headers["message-id"] ?? null;
  return {
    messageId: mid ? (splitIds(mid)[0] ?? mid) : `<${p.MessageID}@postmark>`,
    inReplyTo: splitIds(headers["in-reply-to"])[0] ?? null,
    references: splitIds(headers["references"]),
    from: { email: normaliseEmail(p.FromFull?.Email ?? p.From) ?? p.From, name: p.FromFull?.Name || p.FromName || null },
    to: (p.ToFull ?? parseAddressList(p.To).map((a) => ({ Email: a.email }))).map((a) => normaliseEmail(a.Email)!).filter(Boolean),
    cc: (p.CcFull ?? parseAddressList(p.Cc).map((a) => ({ Email: a.email }))).map((a) => normaliseEmail(a.Email)!).filter(Boolean),
    replyTo: normaliseEmail(p.ReplyTo ?? ""),
    deliveredTo: [p.OriginalRecipient, headers["delivered-to"], headers["x-original-to"]].map((x) => normaliseEmail(x ?? "")).filter((x): x is string => !!x),
    subject: p.Subject ?? "",
    text: p.TextBody ?? "",
    html: p.HtmlBody ?? null,
    date: p.Date ? new Date(p.Date) : new Date(),
    headers,
    attachments: (p.Attachments ?? [])
      .filter((a) => a.ContentLength <= MAX_ATTACHMENT_BYTES)
      .map((a) => ({ filename: a.Name, mime: a.ContentType, content: Buffer.from(a.Content, "base64") })),
    providerId: p.MessageID,
  };
}

const addrs = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => normaliseEmail(v.address ?? "")).filter((e): e is string => !!e));

export async function fromRawMime(raw: Buffer, providerId: string, extra: Partial<NormalizedEmail> = {}): Promise<NormalizedEmail> {
  const m = await simpleParser(raw);
  const headers: Record<string, string> = {};
  for (const [k, v] of m.headers) headers[k.toLowerCase()] = typeof v === "string" ? v : JSON.stringify(v);
  const from = m.from?.value?.[0];
  const refs = Array.isArray(m.references) ? m.references : m.references ? splitIds(m.references) : [];
  return {
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ? (splitIds(m.inReplyTo)[0] ?? m.inReplyTo) : null,
    references: refs,
    from: { email: normaliseEmail(from?.address ?? "") ?? "", name: from?.name || null },
    to: addrs(m.to),
    cc: addrs(m.cc),
    replyTo: addrs(m.replyTo)[0] ?? null,
    deliveredTo: [headers["delivered-to"], headers["x-original-to"]].map((x) => normaliseEmail(x ?? "")).filter((x): x is string => !!x),
    subject: m.subject ?? "",
    text: m.text ?? "",
    html: typeof m.html === "string" ? m.html : null,
    date: m.date ?? new Date(),
    headers,
    attachments: m.attachments
      .filter((a) => a.size <= MAX_ATTACHMENT_BYTES && a.contentDisposition !== "inline")
      .map((a) => ({ filename: a.filename ?? "attachment", mime: a.contentType, content: a.content })),
    providerId,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

function isInternal(email: string): boolean {
  const d = email.split("@")[1] ?? "";
  return env.INTERNAL_DOMAINS.includes(d) || d === env.INBOUND_DOMAIN || d.endsWith("." + (env.INTERNAL_DOMAINS[0] ?? "__none__"));
}

/** §6.3 threading. Returns the lead id the email belongs to, if any. */
export async function threadEmail(e: NormalizedEmail, contactEmail: string | null): Promise<string | null> {
  for (const addr of [...e.to, ...e.cc, ...e.deliveredTo]) {
    const leadId = parseReplyAddress(addr, env.APP_SECRET);
    if (leadId) return leadId;
  }
  const db = getDb();
  const ids = [e.inReplyTo, ...e.references.slice().reverse()].filter((x): x is string => !!x);
  if (ids.length) {
    const [hit] = await db
      .select({ leadId: messages.leadId })
      .from(messages)
      .where(inArray(messages.emailMessageId, ids))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (hit) return hit.leadId;
  }
  // Fallback heuristic: same participant + subject within 30 days, never across companies.
  const subj = normaliseSubject(e.subject);
  if (contactEmail && subj.length >= 4) {
    const rows = await db.execute(sql`
      select c.lead_id from los_conversations c
      join los_channel_identities ci on ci.contact_id = c.contact_id and ci.kind = 'email' and ci.value_normalised = ${contactEmail}
      join los_leads l on l.id = c.lead_id and l.closed_at is null
      where c.channel = 'email' and c.updated_at > now() - interval '30 days'
        and lower(regexp_replace(coalesce(c.subject, ''), '^((re|fwd?|aw)\\s*:\\s*)+', '', 'i')) = ${subj}
      order by c.updated_at desc limit 1`);
    const r = rows.rows[0] as { lead_id?: string } | undefined;
    if (r?.lead_id) return r.lead_id;
  }
  return null;
}

function isBounce(e: NormalizedEmail): boolean {
  return (
    /mailer-daemon|postmaster/i.test(e.from.email) ||
    /multipart\/report/i.test(e.headers["content-type"] ?? "") ||
    /^(undeliverable|delivery status notification|mail delivery failed|returned mail)/i.test(e.subject)
  );
}

async function handleBounce(e: NormalizedEmail): Promise<InboundResult> {
  const body = `${e.text}\n${e.html ?? ""}`;
  const ids = body.match(/<[^<>\s]+@[^<>\s]+>/g) ?? [];
  const db = getDb();
  const [orig] = ids.length
    ? await db.select().from(messages).where(and(inArray(messages.emailMessageId, ids), eq(messages.direction, "outbound"))).limit(1)
    : [];
  if (!orig) return { status: "auto_reply_logged" };
  const hard = /5\.\d\.\d|user unknown|does not exist|no such user|address rejected|mailbox unavailable/i.test(body);
  await markFailed(orig, hard ? "hard_bounce" : "soft_bounce", hard ? "Hard bounce — address does not exist" : "Soft bounce");
  if (hard && orig.emailTo?.[0]) {
    await withTx(async (tx) => {
      await markEmailInvalid(tx, orig.emailTo![0]!);
      await tx.update(leads).set({ tags: sql`array_append(${leads.tags}, 'email_bounced')` }).where(eq(leads.id, orig.leadId));
      await logActivity(tx, orig.leadId, "email_bounced", SYSTEM, { email: orig.emailTo![0], messageId: orig.id });
    });
  }
  return { status: "auto_reply_logged", leadId: orig.leadId };
}

/** Pull the original sender out of a forwarded email body ("From: Name <x@y.com>"). */
function forwardedSender(e: NormalizedEmail): { email: string; name: string | null } | null {
  const text = e.text || htmlToText(e.html);
  const m = text.match(/(?:^|\n)\s*\*?From:\*?\s*(?:"?([^"<\n]*)"?\s*)?<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/i);
  if (!m) return null;
  const email = normaliseEmail(m[2]!);
  if (!email || isInternal(email)) return null;
  return { email, name: m[1]?.trim() || null };
}

export async function processEmail(e: NormalizedEmail, mailbox: MailboxContext = null, webhookEventId?: string): Promise<InboundResult> {
  const fromEmail = e.from.email;
  const bodyText = e.text || htmlToText(e.html);
  const stripped = stripQuotedReply(bodyText);

  // Mail the mailbox owner sent from Gmail directly → outbound human message.
  if (mailbox && (e.isSentByMailboxOwner || fromEmail === mailbox.email)) {
    const counterpart = [...e.to, ...e.cc].find((x) => x !== mailbox.email && !isInternal(x));
    if (!counterpart) return { status: "auto_reply_logged" };
    return recordExternalOutbound({
      channel: "email",
      providerMessageId: `gmail:${e.providerId}`,
      sentAt: e.date,
      identities: [{ kind: "email", value: counterpart }],
      authorType: "user",
      authorUserId: mailbox.userId,
      kind: "email",
      body: stripped,
      bodyFull: bodyText,
      subject: e.subject,
      threadLeadId: await threadEmail(e, counterpart),
      email: { messageId: e.messageId, inReplyTo: e.inReplyTo, references: e.references, from: fromEmail, to: e.to, cc: e.cc },
      mailboxConnectionId: mailbox.id,
      providerThreadRef: e.gmailThreadId ?? null,
    });
  }

  if (isBounce(e)) return handleBounce(e);

  const autoReply = isAutoReply({ headers: e.headers, subject: e.subject, from: fromEmail });
  const media: PendingMedia[] = e.attachments.map((a) => ({
    kind: a.mime.startsWith("image/") ? "image" : "document",
    content: a.content,
    mime: a.mime,
    filename: a.filename,
  }));
  const base = {
    channel: "email" as const,
    providerMessageId: e.messageId ?? `pm:${e.providerId}`,
    receivedAt: e.date > new Date() ? new Date() : e.date,
    kind: "email",
    body: stripped || bodyText.slice(0, 5000),
    bodyFull: bodyText,
    bodyHtml: e.html,
    subject: e.subject,
    media,
    email: { messageId: e.messageId, inReplyTo: e.inReplyTo, references: e.references, from: fromEmail, to: e.to, cc: e.cc },
    mailboxConnectionId: mailbox?.id ?? null,
    providerThreadRef: e.gmailThreadId ?? null,
    toAddress: mailbox?.email ?? e.to.find((t) => env.SHARED_MAILBOXES.includes(t)) ?? e.deliveredTo[0] ?? e.to[0] ?? null,
  };

  // Internal forward ("FYI, see this enquiry"): attach as a note, not as a client message.
  if (isInternal(fromEmail)) {
    const threadLeadId = await threadEmail(e, null);
    const original = forwardedSender(e);
    if (threadLeadId) {
      await withTx(async (tx) => {
        await tx.insert(notes).values({ orgId: ORG_ID, leadId: threadLeadId, body: `Forwarded by ${fromEmail}:\n\n${bodyText.slice(0, 8000)}` });
        await logActivity(tx, threadLeadId, "note_added", SYSTEM, { via: "internal_forward", from: fromEmail });
      });
      return { status: "attached", leadId: threadLeadId };
    }
    if (!original) return { status: "auto_reply_logged" };
    // Zero lost enquiries: a colleague forwarded a client's mail — create the lead for the client.
    const r = await processInbound({
      ...base,
      providerMessageId: `fwd:${base.providerMessageId}`,
      identities: [{ kind: "email", value: original.email }],
      name: original.name,
      source: mailbox ? "email_rep" : "email_shared",
      sourceDetail: `Forwarded by ${fromEmail}`,
    });
    if (r.leadId) {
      await withTx(async (tx) => {
        await tx.insert(notes).values({ orgId: ORG_ID, leadId: r.leadId!, body: `Forwarded internally by ${fromEmail}.` });
      });
    }
    return r;
  }

  // Portal / marketplace notifications → fully populated leads (§6.2).
  const portal = parsePortalEmail({ from: fromEmail, subject: e.subject, text: e.text, html: e.html, replyTo: e.replyTo });
  if (portal.matched) {
    const lead = portal.ok ? portal.lead : portal.partial;
    const identities: IdentityInput[] = [];
    const phone = lead.phone ? normalisePhone(lead.phone) : null;
    if (phone) identities.push({ kind: "phone", value: phone.e164, raw: lead.phone });
    const em = lead.email ? normaliseEmail(lead.email) : null;
    if (em && !isPortalSender(em)) identities.push({ kind: "email", value: em });
    return processInbound({
      ...base,
      identities,
      name: lead.name ?? (portal.ok ? null : `Unknown (${portal.parser})`),
      companyName: lead.company,
      city: lead.city,
      state: lead.state,
      body: [lead.product && `Product: ${lead.product}`, lead.quantity && `Quantity: ${lead.quantity}`, lead.message, !portal.ok ? stripped : null]
        .filter(Boolean)
        .join("\n") || stripped,
      source: lead.source,
      sourceDetail: lead.sourceDetail ?? lead.product ?? null,
      portalLeadId: lead.portalLeadId ?? null,
      isPortal: true,
      // Replies to a portal's noreply sender go nowhere; don't treat it as the client's window.
      opensWindow: false,
      parseFailure: portal.ok ? null : { parser: portal.parser, reason: portal.reason, raw: { subject: e.subject, from: fromEmail, text: bodyText.slice(0, 20000) }, webhookEventId },
    });
  }

  const contactEmail = (e.replyTo && !isInternal(e.replyTo) ? e.replyTo : null) ?? fromEmail;
  const threadLeadId = await threadEmail(e, contactEmail);
  const spam = threadLeadId ? { junk: false } : classifySpam({ fromEmail, subject: e.subject, body: bodyText });

  return processInbound({
    ...base,
    identities: [{ kind: "email", value: contactEmail }],
    name: e.from.name,
    source: mailbox ? "email_rep" : "email_shared",
    sourceDetail: base.toAddress,
    threadLeadId,
    isAutoReply: autoReply,
    isJunk: spam.junk,
    junkReason: spam.junk ? (spam as { reason?: string }).reason : null,
  });
}
