/**
 * Unified inbox (§8.2): conversation list with the filters that matter, thread view, composer
 * sends, snooze/close/junk, read state.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  attachments,
  conversations,
  getDb,
  leads,
  messages,
  notes,
  users,
  type Db,
} from "@lead/db";
import {
  NotFoundError,
  ForbiddenError,
  cancelScheduled,
  getOrCreateConversation,
  getStorage,
  logActivity,
  markConversationRead,
  queueMessage,
  retryMessage,
  withTx,
  ORG_ID,
} from "@lead/core";
import { windowState } from "@lead/domain";
import { actorOf, canSeeLead, idParam, isManager, parse, requireUser, type SessionUser } from "../http";

const FILTERS = ["all", "unassigned", "mine", "team", "awaiting", "window_closing", "sla", "unread", "junk", "snoozed", "closed"] as const;

export async function loadConversationForUser(db: Db, u: SessionUser, id: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!c) throw new NotFoundError("Conversation");
  const [l] = await db.select().from(leads).where(eq(leads.id, c.leadId));
  if (!l || !canSeeLead(u, l)) throw new ForbiddenError();
  return { conversation: c, lead: l };
}

export async function signedMedia(db: Db, refs: { attachmentId: string }[]) {
  if (!refs.length) return [];
  const rows = await db.select().from(attachments).where(inArray(attachments.id, refs.map((r) => r.attachmentId)));
  return Promise.all(
    rows.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      mime: a.mime,
      size: a.size,
      status: a.status,
      url: a.storageKey ? await getStorage().signedUrl(a.storageKey, 900, a.filename ?? undefined) : null,
    })),
  );
}

export async function inboxRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/api/conversations", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError("Viewers can't see message content");
    const qs = parse(
      z.object({
        filter: z.enum(FILTERS).default("all"),
        channel: z.enum(["whatsapp", "email"]).optional(),
        q: z.string().max(100).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
      }),
      req.query,
    );
    const conds = [sql`c.org_id = ${ORG_ID}`];
    if (!isManager(u)) conds.push(sql`(l.owner_id = ${u.id}::uuid or l.owner_id is null)`);
    switch (qs.filter) {
      case "unassigned":
        conds.push(sql`l.owner_id is null and not c.is_junk and l.closed_at is null`);
        break;
      case "mine":
        conds.push(sql`l.owner_id = ${u.id}::uuid and c.state <> 'closed'`);
        break;
      case "team":
        conds.push(sql`l.team_id = ${u.teamId}::uuid and c.state <> 'closed'`);
        break;
      case "awaiting":
        conds.push(sql`c.state = 'waiting_us' and not c.is_junk`);
        break;
      case "window_closing":
        conds.push(sql`c.channel = 'whatsapp' and c.window_expires_at between now() and now() + interval '2 hours' and c.last_direction = 'inbound'`);
        break;
      case "sla":
        conds.push(sql`exists (select 1 from los_sla_timers t where t.lead_id = l.id and t.state = 'running' and t.warned_at is not null)`);
        break;
      case "unread":
        conds.push(sql`c.unread_count > 0 and not c.is_junk`);
        break;
      case "junk":
        conds.push(sql`c.is_junk`);
        break;
      case "snoozed":
        conds.push(sql`c.state = 'snoozed'`);
        break;
      case "closed":
        conds.push(sql`c.state = 'closed'`);
        break;
      default:
        conds.push(sql`not c.is_junk and c.state not in ('closed', 'snoozed')`);
    }
    if (qs.channel) conds.push(sql`c.channel = ${qs.channel}`);
    if (qs.before) conds.push(sql`c.last_message_at < ${qs.before}::timestamptz`);
    if (qs.q) {
      const like = `%${qs.q}%`;
      conds.push(sql`(ct.display_name ilike ${like} or co.name ilike ${like} or c.last_message_preview ilike ${like} or c.subject ilike ${like})`);
    }
    const order = qs.filter === "unassigned" ? sql`l.score desc, c.last_message_at asc` : sql`c.last_message_at desc nulls last`;
    const r = await db.execute(sql`
      select c.id, c.lead_id, c.channel, c.state, c.subject, c.unread_count, c.last_message_at, c.last_message_preview,
             c.last_direction, c.last_inbound_at, c.window_expires_at, c.is_junk, c.snoozed_until,
             l.number as lead_number, l.stage, l.score, l.owner_id, l.source, l.next_step_at,
             ct.display_name as contact_name, ct.id as contact_id, co.name as company_name,
             u.name as owner_name,
             (select max(case when t.breached_at is not null then 2 when t.warned_at is not null then 1 else 0 end)
                from los_sla_timers t where t.lead_id = l.id and t.state = 'running') as sla_level,
             (select min(t.breach_at) from los_sla_timers t where t.lead_id = l.id and t.state = 'running') as sla_due_at
      from los_conversations c
      join los_leads l on l.id = c.lead_id
      join los_contacts ct on ct.id = c.contact_id
      left join los_companies co on co.id = l.company_id
      left join los_users u on u.id = l.owner_id
      where ${sql.join(conds, sql` and `)}
      order by ${order}
      limit ${qs.limit}`);
    const counts = await db.execute(sql`
      select
        count(*) filter (where l.owner_id is null and not c.is_junk and l.closed_at is null)::int as unassigned,
        count(*) filter (where l.owner_id = ${u.id}::uuid and c.state = 'waiting_us')::int as mine_waiting,
        count(*) filter (where c.state = 'waiting_us' and not c.is_junk)::int as awaiting,
        count(*) filter (where c.unread_count > 0 and not c.is_junk)::int as unread,
        count(*) filter (where c.channel = 'whatsapp' and c.window_expires_at between now() and now() + interval '2 hours' and c.last_direction = 'inbound')::int as window_closing
      from los_conversations c join los_leads l on l.id = c.lead_id
      where c.org_id = ${ORG_ID} ${isManager(u) ? sql`` : sql`and (l.owner_id = ${u.id}::uuid or l.owner_id is null)`}`);
    return { items: r.rows, counts: counts.rows[0] };
  });

  app.get("/api/conversations/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { conversation, lead } = await loadConversationForUser(db, u, id);
    const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt)).limit(500);
    const authorIds = [...new Set(msgs.map((m) => m.authorUserId).filter((x): x is string => !!x))];
    const authors = authorIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, authorIds)) : [];
    const authorName = new Map(authors.map((a) => [a.id, a.name]));
    const convNotes = await db.select().from(notes).where(eq(notes.leadId, lead.id)).orderBy(asc(notes.createdAt));
    const noteAuthors = new Map(
      (convNotes.length ? await db.select({ id: users.id, name: users.name }).from(users) : []).map((x) => [x.id, x.name]),
    );
    const items = await Promise.all(
      msgs.map(async (m) => ({
        ...m,
        search: undefined,
        bodyFull: undefined,
        hasFullBody: !!m.bodyFull && m.bodyFull !== m.body,
        authorName: m.authorUserId ? authorName.get(m.authorUserId) : m.authorType === "phone_app" ? "WhatsApp phone app" : m.authorType === "system" ? "Doott (automatic)" : null,
        media: await signedMedia(db, m.media),
      })),
    );
    const win = windowState(conversation.lastInboundAt);
    return {
      conversation,
      lead,
      window: conversation.channel === "whatsapp" ? { open: win.open, expiresAt: win.expiresAt, msRemaining: win.msRemaining } : null,
      messages: items,
      notes: convNotes.map((n) => ({ ...n, search: undefined, authorName: n.authorId ? noteAuthors.get(n.authorId) : "System" })),
    };
  });

  app.get("/api/messages/:id/full", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    if (!m) throw new NotFoundError("Message");
    await loadConversationForUser(db, u, m.conversationId);
    return { bodyFull: m.bodyFull, bodyHtml: m.bodyHtml };
  });

  app.post("/api/conversations/:id/read", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadConversationForUser(db, u, id);
    await markConversationRead(db, id);
    return { ok: true };
  });

  const sendSchema = z.object({
    type: z.enum(["text", "template", "media", "email"]),
    body: z.string().max(20_000).optional(),
    bodyHtml: z.string().max(200_000).optional(),
    templateId: z.string().uuid().optional(),
    templateValues: z.record(z.string()).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    subject: z.string().max(500).optional(),
    cc: z.array(z.string().email()).max(10).optional(),
    sendAt: z.string().datetime().optional(),
    idempotencyKey: z.string().max(100).optional(),
    replyToContextId: z.string().max(200).optional(),
  });

  app.post("/api/conversations/:id/messages", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const { id } = parse(idParam, req.params);
    const body = parse(sendSchema, req.body);
    const { lead } = await loadConversationForUser(db, u, id);
    if (lead.ownerId && lead.ownerId !== u.id && !isManager(u)) throw new ForbiddenError("Claim the lead before replying");
    const msg = await withTx((tx, fx) =>
      queueMessage(tx, fx, {
        conversationId: id,
        actor: actorOf(req),
        type: body.type,
        body: body.body,
        bodyHtml: body.bodyHtml,
        templateId: body.templateId,
        templateValues: body.templateValues,
        attachmentIds: body.attachmentIds,
        subject: body.subject,
        cc: body.cc,
        sendAt: body.sendAt ? new Date(body.sendAt) : null,
        idempotencyKey: body.idempotencyKey ? `ui:${u.id}:${body.idempotencyKey}` : undefined,
        replyToContextId: body.replyToContextId,
      }),
    );
    return { message: msg };
  });

  app.post("/api/messages/:id/retry", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    if (!m) throw new NotFoundError("Message");
    await loadConversationForUser(db, u, m.conversationId);
    return { message: await withTx((tx, fx) => retryMessage(tx, fx, id, actorOf(req))) };
  });

  app.post("/api/messages/:id/cancel", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [m] = await db.select().from(messages).where(eq(messages.id, id));
    if (!m) throw new NotFoundError("Message");
    await loadConversationForUser(db, u, m.conversationId);
    await withTx((tx) => cancelScheduled(tx, id));
    return { ok: true };
  });

  app.post("/api/conversations/:id/snooze", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { until } = parse(z.object({ until: z.string().datetime() }), req.body);
    const { lead } = await loadConversationForUser(db, u, id);
    await withTx(async (tx, fx) => {
      await tx.update(conversations).set({ state: "snoozed", snoozedUntil: new Date(until) }).where(eq(conversations.id, id));
      await logActivity(tx, lead.id, "snoozed", actorOf(req), { until, conversationId: id });
      fx.enqueueAt("conversation.unsnooze", { conversationId: id }, new Date(until));
      fx.publish({ type: "conversation.updated", orgId: ORG_ID, conversationId: id, leadId: lead.id });
    });
    return { ok: true };
  });

  app.post("/api/conversations/:id/state", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { state } = parse(z.object({ state: z.enum(["open", "waiting_client", "waiting_us", "closed"]) }), req.body);
    const { lead } = await loadConversationForUser(db, u, id);
    await withTx(async (tx, fx) => {
      await tx.update(conversations).set({ state, snoozedUntil: null, updatedAt: new Date() }).where(eq(conversations.id, id));
      await logActivity(tx, lead.id, "conversation_state", actorOf(req), { state, conversationId: id });
      fx.publish({ type: "conversation.updated", orgId: ORG_ID, conversationId: id, leadId: lead.id });
    });
    return { ok: true };
  });

  app.post("/api/conversations/:id/junk", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { junk } = parse(z.object({ junk: z.boolean() }), req.body);
    const { lead } = await loadConversationForUser(db, u, id);
    await withTx(async (tx, fx) => {
      await tx.update(conversations).set({ isJunk: junk }).where(eq(conversations.id, id));
      await tx.update(leads).set({ isJunk: junk }).where(eq(leads.id, lead.id));
      await logActivity(tx, lead.id, junk ? "marked_junk" : "unmarked_junk", actorOf(req), {});
      if (!junk && !lead.ownerId) {
        const { routeLead } = await import("@lead/core");
        await routeLead(tx, fx, lead.id);
      }
      fx.publish({ type: "conversation.updated", orgId: ORG_ID, conversationId: id, leadId: lead.id });
    });
    return { ok: true };
  });

  /** Start a conversation on another channel (e.g. email a WhatsApp lead). */
  app.post("/api/leads/:id/conversations", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { channel } = parse(z.object({ channel: z.enum(["whatsapp", "email"]) }), req.body);
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    if (!l || !canSeeLead(u, l)) throw new ForbiddenError();
    const { conversation } = await withTx((tx) => getOrCreateConversation(tx, { leadId: l.id, contactId: l.contactId, channel, assignedTo: l.ownerId }));
    return { conversation };
  });

  app.get("/api/leads/:id/conversations", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    if (!l || !canSeeLead(u, l)) throw new ForbiddenError();
    return { items: await db.select().from(conversations).where(eq(conversations.leadId, id)).orderBy(desc(conversations.lastMessageAt)) };
  });

}
