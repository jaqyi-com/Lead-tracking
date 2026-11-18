/**
 * Leads (§7.1, §8.1): list, detail with the full cross-channel timeline, edits with the §8.4 rules,
 * stage changes, assignment/claiming, notes with @mentions, tasks, pipeline board, My day.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activities,
  companies,
  contacts,
  conversations,
  duplicateSuggestions,
  enrichmentResults,
  enrollmentEvents,
  enrollments,
  getDb,
  leads,
  lostReasons,
  notes,
  slaTimers,
  tasks,
  users,
  type Stage,
} from "@lead/db";
import { OPEN_STAGES, STAGES, QUALIFICATION_FIELDS, normaliseEmail, normalisePhone, cleanName } from "@lead/domain";
import {
  ForbiddenError,
  NotFoundError,
  assignLead,
  changeStage,
  claimLead,
  consentStatus,
  createLead,
  getOrCreateConversation,
  identitiesOf,
  logActivity,
  notify,
  resolveContact,
  routeLead,
  updateLead,
  withTx,
  ORG_ID,
  audit,
  recordConsent,
  type IdentityInput,
} from "@lead/core";
import { actorOf, canSeeLead, idParam, isManager, parse, requireRole, requireUser } from "../http";

export async function leadRoutes(app: FastifyInstance) {
  const db = getDb();

  async function loadLead(u: ReturnType<typeof requireUser>, id: string) {
    const [l] = await db.select().from(leads).where(eq(leads.id, id));
    if (!l) throw new NotFoundError("Lead");
    if (!canSeeLead(u, l)) throw new ForbiddenError();
    return l;
  }

  app.get("/api/meta", async (req) => {
    requireUser(req);
    const reasons = await db.select().from(lostReasons).where(eq(lostReasons.active, true));
    const people = await db
      .select({ id: users.id, name: users.name, role: users.role, isAvailable: users.isAvailable, teamId: users.teamId })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.name));
    const sources = (await db.execute(sql`select key, label from los_lead_sources where active order by label`)).rows;
    return { stages: STAGES, openStages: OPEN_STAGES, lostReasons: reasons, users: people, sources, qualificationFields: QUALIFICATION_FIELDS };
  });

  app.get("/api/leads", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const q = parse(
      z.object({
        stage: z.string().optional(),
        owner: z.string().optional(), // uuid | "me" | "none"
        source: z.string().optional(),
        q: z.string().max(100).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        open: z.enum(["true", "false"]).optional(),
        parseFailed: z.enum(["true"]).optional(),
        sort: z.enum(["recent", "score", "activity", "next_step"]).default("recent"),
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(200).default(50),
      }),
      req.query,
    );
    const conds = [sql`l.org_id = ${ORG_ID}`, sql`not l.is_junk`];
    if (!isManager(u)) conds.push(sql`(l.owner_id = ${u.id}::uuid or l.owner_id is null)`);
    if (q.stage) conds.push(sql`l.stage in (${sql.join(q.stage.split(",").map((s) => sql`${s}`), sql`, `)})`);
    if (q.owner === "me") conds.push(sql`l.owner_id = ${u.id}::uuid`);
    else if (q.owner === "none") conds.push(sql`l.owner_id is null`);
    else if (q.owner) conds.push(sql`l.owner_id = ${q.owner}::uuid`);
    if (q.source) conds.push(sql`l.source in (${sql.join(q.source.split(",").map((s) => sql`${s}`), sql`, `)})`);
    if (q.from) conds.push(sql`l.created_at >= ${q.from}::timestamptz`);
    if (q.to) conds.push(sql`l.created_at <= ${q.to}::timestamptz`);
    if (q.open === "true") conds.push(sql`l.closed_at is null`);
    if (q.open === "false") conds.push(sql`l.closed_at is not null`);
    if (q.parseFailed) conds.push(sql`l.parse_failed`);
    if (q.q) {
      const like = `%${q.q}%`;
      conds.push(sql`(ct.display_name ilike ${like} or co.name ilike ${like} or l.enquiry ilike ${like} or ('L-' || l.number) ilike ${like})`);
    }
    const order = {
      recent: sql`l.created_at desc`,
      score: sql`l.score desc, l.created_at desc`,
      activity: sql`l.last_activity_at desc`,
      next_step: sql`l.next_step_at asc nulls last`,
    }[q.sort];
    const where = sql.join(conds, sql` and `);
    const rows = await db.execute(sql`
      select l.id, l.number, l.stage, l.source, l.source_detail, l.score, l.value_estimate, l.owner_id, l.created_at, l.last_activity_at,
             l.next_step, l.next_step_at, l.first_response_business_minutes, l.parse_failed, l.tags, l.enquiry,
             ct.display_name as contact_name, co.name as company_name, u.name as owner_name
      from los_leads l join los_contacts ct on ct.id = l.contact_id left join los_companies co on co.id = l.company_id left join los_users u on u.id = l.owner_id
      where ${where} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
    const [{ total }] = (await db.execute(sql`select count(*)::int as total from los_leads l join los_contacts ct on ct.id = l.contact_id left join los_companies co on co.id = l.company_id where ${where}`)).rows as { total: number }[];
    return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
  });

  /** Manual entry (§3.1.1). */
  app.post("/api/leads", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const b = parse(
      z.object({
        name: z.string().max(200).optional(),
        email: z.string().max(320).optional(),
        phone: z.string().max(40).optional(),
        company: z.string().max(200).optional(),
        jobTitle: z.string().max(200).optional(),
        source: z.string().default("manual"),
        sourceDetail: z.string().max(500).optional(),
        enquiry: z.string().max(5000).optional(),
        assignToMe: z.boolean().default(true),
        consent: z.object({ marketing: z.boolean(), evidence: z.string().min(3) }).optional(),
      }),
      req.body,
    );
    const ids: IdentityInput[] = [];
    const email = normaliseEmail(b.email);
    const phone = normalisePhone(b.phone);
    if (email) ids.push({ kind: "email", value: email, raw: b.email });
    if (phone) ids.push({ kind: "phone", value: phone.e164, raw: b.phone });
    if (!ids.length) throw new ForbiddenError("A valid email or phone is required");
    const lead = await withTx(async (tx, fx) => {
      const { contact, company } = await resolveContact(tx, { identities: ids, name: cleanName(b.name), jobTitle: b.jobTitle, companyName: b.company, source: b.source });
      const l = await createLead(tx, fx, {
        contactId: contact.id,
        companyId: company?.id ?? null,
        source: b.source,
        sourceDetail: b.sourceDetail,
        enquiry: b.enquiry,
        actor: actorOf(req),
        startTimers: false,
      });
      if (email) await getOrCreateConversation(tx, { leadId: l.id, contactId: contact.id, channel: "email" });
      if (phone) await getOrCreateConversation(tx, { leadId: l.id, contactId: contact.id, channel: "whatsapp" });
      if (b.consent) {
        await recordConsent(tx, {
          contactId: contact.id,
          channel: "all",
          purpose: b.consent.marketing ? "all" : "utility",
          state: "granted",
          basis: "verbal",
          evidence: { note: b.consent.evidence, recordedBy: u.id },
          actor: actorOf(req),
          ip: req.ip,
        });
      }
      if (b.assignToMe && u.role === "rep") await assignLead(tx, fx, l.id, u.id, actorOf(req), { reason: "manual entry" });
      else await routeLead(tx, fx, l.id);
      return l;
    });
    return { lead };
  });

  app.get("/api/leads/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const lead = await loadLead(u, id);
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
    const [company] = lead.companyId ? await db.select().from(companies).where(eq(companies.id, lead.companyId)) : [];
    const [owner] = lead.ownerId ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, lead.ownerId)) : [];
    const [timeline, leadNotes, leadTasks, convs, timers, enr, identities, consent, enrichment, history] = await Promise.all([
      db.select().from(activities).where(eq(activities.leadId, id)).orderBy(desc(activities.occurredAt)).limit(300),
      db.select().from(notes).where(eq(notes.leadId, id)).orderBy(desc(notes.createdAt)),
      db.select().from(tasks).where(eq(tasks.leadId, id)).orderBy(asc(tasks.dueAt)),
      db.select().from(conversations).where(eq(conversations.leadId, id)),
      db.select().from(slaTimers).where(eq(slaTimers.leadId, id)).orderBy(desc(slaTimers.startedAt)),
      db.select().from(enrollments).where(eq(enrollments.leadId, id)).orderBy(desc(enrollments.startedAt)),
      identitiesOf(db, lead.contactId),
      consentStatus(db, lead.contactId),
      db.select().from(enrichmentResults).where(eq(enrichmentResults.contactId, lead.contactId)).orderBy(desc(enrichmentResults.fetchedAt)).limit(1),
      db
        .select({ id: leads.id, number: leads.number, stage: leads.stage, openedAt: leads.openedAt, closedAt: leads.closedAt, lostReason: leads.lostReason })
        .from(leads)
        .where(and(eq(leads.contactId, lead.contactId), sql`${leads.id} <> ${id}`))
        .orderBy(desc(leads.openedAt)),
    ]);
    const enrEvents = enr[0] ? await db.select().from(enrollmentEvents).where(eq(enrollmentEvents.enrollmentId, enr[0].id)).orderBy(asc(enrollmentEvents.occurredAt)) : [];
    const dupes = await db
      .select()
      .from(duplicateSuggestions)
      .where(and(eq(duplicateSuggestions.status, "open"), sql`(${duplicateSuggestions.contactA} = ${lead.contactId} or ${duplicateSuggestions.contactB} = ${lead.contactId})`));
    const actorIds = [...new Set([...timeline.map((a) => a.actorId), ...leadNotes.map((n) => n.authorId)].filter((x): x is string => !!x))];
    const names = actorIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds)) : [];
    return {
      lead,
      contact,
      company: company ?? null,
      owner: owner ?? null,
      identities,
      consent: { whatsapp: consent.whatsapp, email: consent.email, records: consent.records.slice(0, 20) },
      conversations: convs,
      timeline,
      notes: leadNotes.map((n) => ({ ...n, search: undefined })),
      tasks: leadTasks,
      slaTimers: timers,
      enrollment: enr[0] ? { ...enr[0], events: enrEvents } : null,
      enrichment: enrichment[0] ?? null,
      history,
      duplicates: dupes,
      userNames: Object.fromEntries(names.map((n) => [n.id, n.name])),
    };
  });

  app.patch("/api/leads/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadLead(u, id);
    const b = parse(
      z.object({
        qualification: z.record(z.unknown()).optional(),
        nextStep: z.string().max(500).nullable().optional(),
        nextStepAt: z.string().datetime().nullable().optional(),
        valueEstimate: z.union([z.number(), z.string()]).nullable().optional(),
        tags: z.array(z.string().max(40)).max(30).optional(),
        sourceDetail: z.string().max(500).nullable().optional(),
        enquiry: z.string().max(5000).nullable().optional(),
      }),
      req.body,
    );
    return { lead: await withTx((tx, fx) => updateLead(tx, fx, id, b, actorOf(req))) };
  });

  app.patch("/api/contacts/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [lead] = await db.select().from(leads).where(eq(leads.contactId, id)).limit(1);
    if (!lead || !canSeeLead(u, lead)) throw new ForbiddenError();
    const b = parse(
      z.object({
        displayName: z.string().max(200).optional(),
        firstName: z.string().max(100).nullable().optional(),
        lastName: z.string().max(100).nullable().optional(),
        jobTitle: z.string().max(200).nullable().optional(),
        city: z.string().max(100).nullable().optional(),
        state: z.string().max(100).nullable().optional(),
        timezone: z.string().max(60).optional(),
        doNotContact: z.boolean().optional(),
      }),
      req.body,
    );
    await withTx(async (tx) => {
      const [before] = await tx.select().from(contacts).where(eq(contacts.id, id));
      await tx.update(contacts).set({ ...b, updatedAt: new Date() }).where(eq(contacts.id, id));
      await audit(tx, actorOf(req), "contact.update", "contact", id, before, b);
    });
    return { ok: true };
  });

  app.patch("/api/companies/:id", async (req) => {
    requireRole(req, "admin", "manager", "rep");
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        name: z.string().max(200).optional(),
        website: z.string().max(300).nullable().optional(),
        industry: z.string().max(200).nullable().optional(),
        sizeBand: z.string().max(40).nullable().optional(),
        city: z.string().max(100).nullable().optional(),
        state: z.string().max(100).nullable().optional(),
      }),
      req.body,
    );
    await withTx(async (tx) => {
      const [before] = await tx.select().from(companies).where(eq(companies.id, id));
      await tx.update(companies).set({ ...b, updatedAt: new Date() }).where(eq(companies.id, id));
      await audit(tx, actorOf(req), "company.update", "company", id, before, b);
    });
    return { ok: true };
  });

  app.post("/api/leads/:id/stage", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadLead(u, id);
    const b = parse(
      z.object({
        stage: z.enum(STAGES as unknown as [Stage, ...Stage[]]),
        lostReason: z.string().optional(),
        lostNote: z.string().max(2000).optional(),
        revisitAt: z.string().datetime().optional(),
      }),
      req.body,
    );
    return {
      lead: await withTx((tx, fx) =>
        changeStage(tx, fx, id, b.stage, actorOf(req), { lostReason: b.lostReason, lostNote: b.lostNote, revisitAt: b.revisitAt ? new Date(b.revisitAt) : null }),
      ),
    };
  });

  app.post("/api/leads/:id/assign", async (req) => {
    requireRole(req, "admin", "manager");
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ userId: z.string().uuid(), reason: z.string().min(2).max(300) }), req.body);
    return { lead: await withTx((tx, fx) => assignLead(tx, fx, id, b.userId, actorOf(req), { reason: b.reason })) };
  });

  app.post("/api/leads/:id/claim", async (req) => {
    const u = requireRole(req, "rep", "manager", "admin");
    const { id } = parse(idParam, req.params);
    await loadLead(u, id);
    return { lead: await withTx((tx, fx) => claimLead(tx, fx, id, actorOf(req))) };
  });

  app.post("/api/leads/:id/notes", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const lead = await loadLead(u, id);
    const b = parse(z.object({ body: z.string().min(1).max(10_000), conversationId: z.string().uuid().optional(), mentions: z.array(z.string().uuid()).max(20).default([]) }), req.body);
    const note = await withTx(async (tx, fx) => {
      const [n] = await tx
        .insert(notes)
        .values({ orgId: ORG_ID, leadId: id, conversationId: b.conversationId ?? null, authorId: u.id, body: b.body, mentions: b.mentions })
        .returning();
      await logActivity(tx, id, "note_added", actorOf(req), { noteId: n!.id, mentions: b.mentions });
      if (b.mentions.length) {
        await notify(tx, fx, {
          userIds: b.mentions.filter((m) => m !== u.id),
          type: "mention",
          title: `${u.name} mentioned you on L-${lead.number}`,
          body: b.body.slice(0, 200),
          leadId: id,
          conversationId: b.conversationId,
        });
      }
      fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId: id, conversationId: b.conversationId });
      return n!;
    });
    return { note: { ...note, search: undefined } };
  });

  app.post("/api/leads/:id/tasks", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const lead = await loadLead(u, id);
    const b = parse(z.object({ title: z.string().min(1).max(300), dueAt: z.string().datetime().optional(), assigneeId: z.string().uuid().optional(), type: z.string().default("follow_up") }), req.body);
    const task = await withTx(async (tx, fx) => {
      const [t] = await tx
        .insert(tasks)
        .values({ orgId: ORG_ID, leadId: id, assigneeId: b.assigneeId ?? lead.ownerId ?? u.id, title: b.title, type: b.type, dueAt: b.dueAt ? new Date(b.dueAt) : null, createdBy: u.id })
        .returning();
      await logActivity(tx, id, "task_created", actorOf(req), { taskId: t!.id, title: b.title, dueAt: b.dueAt });
      fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId: id });
      return t!;
    });
    return { task };
  });

  app.get("/api/tasks", async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ assignee: z.string().optional(), open: z.enum(["true", "false"]).default("true") }), req.query);
    const assignee = q.assignee && isManager(u) ? q.assignee : u.id;
    const rows = await db.execute(sql`
      select t.*, l.number as lead_number, ct.display_name as contact_name
      from los_tasks t left join los_leads l on l.id = t.lead_id left join los_contacts ct on ct.id = l.contact_id
      where t.assignee_id = ${assignee}::uuid ${q.open === "true" ? sql`and t.completed_at is null` : sql``}
      order by t.due_at asc nulls last limit 200`);
    return { items: rows.rows };
  });

  app.patch("/api/tasks/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ completed: z.boolean().optional(), dueAt: z.string().datetime().nullable().optional(), title: z.string().max(300).optional() }), req.body);
    await withTx(async (tx, fx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, id));
      if (!t) throw new NotFoundError("Task");
      if (t.assigneeId !== u.id && !isManager(u)) throw new ForbiddenError();
      await tx
        .update(tasks)
        .set({
          ...(b.completed !== undefined ? { completedAt: b.completed ? new Date() : null } : {}),
          ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
          ...(b.title ? { title: b.title } : {}),
        })
        .where(eq(tasks.id, id));
      if (t.leadId && b.completed) {
        await logActivity(tx, t.leadId, "task_completed", actorOf(req), { taskId: id, title: t.title });
        fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId: t.leadId });
      }
    });
    return { ok: true };
  });

  /** Pipeline Kanban (§8.1): value and count per column. */
  app.get("/api/pipeline", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const q = parse(z.object({ owner: z.string().optional(), source: z.string().optional(), days: z.coerce.number().default(90) }), req.query);
    const conds = [sql`l.org_id = ${ORG_ID}`, sql`not l.is_junk`, sql`(l.closed_at is null or l.closed_at > now() - interval '30 days')`, sql`l.created_at > now() - make_interval(days => ${q.days})`];
    if (!isManager(u)) conds.push(sql`(l.owner_id = ${u.id}::uuid or l.owner_id is null)`);
    if (q.owner === "me") conds.push(sql`l.owner_id = ${u.id}::uuid`);
    else if (q.owner) conds.push(sql`l.owner_id = ${q.owner}::uuid`);
    if (q.source) conds.push(sql`l.source = ${q.source}`);
    const rows = await db.execute(sql`
      select l.id, l.number, l.stage, l.score, l.value_estimate, l.source, l.next_step, l.next_step_at, l.last_activity_at, l.owner_id,
             ct.display_name as contact_name, co.name as company_name, u.name as owner_name,
             (select max(case when t.breached_at is not null then 2 when t.warned_at is not null then 1 else 0 end) from los_sla_timers t where t.lead_id = l.id and t.state = 'running') as sla_level
      from los_leads l join los_contacts ct on ct.id = l.contact_id left join los_companies co on co.id = l.company_id left join los_users u on u.id = l.owner_id
      where ${sql.join(conds, sql` and `)}
      order by l.score desc, l.last_activity_at desc limit 1000`);
    const columns = STAGES.map((stage) => {
      const cards = (rows.rows as { stage: string; value_estimate: string | null }[]).filter((r) => r.stage === stage);
      return { stage, count: cards.length, value: cards.reduce((s, c) => s + Number(c.value_estimate ?? 0), 0), cards };
    });
    return { columns };
  });

  /** "My day" (§8.1): the first screen of the morning. */
  app.get("/api/my-day", async (req) => {
    const u = requireUser(req);
    const [overdue, today, slaRisk, unanswered, nextSteps] = await Promise.all([
      db.execute(sql`select t.*, l.number as lead_number, ct.display_name as contact_name from los_tasks t left join los_leads l on l.id = t.lead_id left join los_contacts ct on ct.id = l.contact_id
        where t.assignee_id = ${u.id}::uuid and t.completed_at is null and t.due_at < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' order by t.due_at limit 100`),
      db.execute(sql`select t.*, l.number as lead_number, ct.display_name as contact_name from los_tasks t left join los_leads l on l.id = t.lead_id left join los_contacts ct on ct.id = l.contact_id
        where t.assignee_id = ${u.id}::uuid and t.completed_at is null and t.due_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
          and t.due_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata' order by t.due_at limit 100`),
      db.execute(sql`select tm.kind, tm.breach_at, tm.warned_at, tm.breached_at, l.id as lead_id, l.number as lead_number, ct.display_name as contact_name,
          (select c.id from los_conversations c where c.lead_id = l.id order by c.last_message_at desc nulls last limit 1) as conversation_id
        from los_sla_timers tm join los_leads l on l.id = tm.lead_id join los_contacts ct on ct.id = l.contact_id
        where tm.state = 'running' and (l.owner_id = ${u.id}::uuid ${isManager(u) ? sql`or true` : sql``}) and tm.breach_at < now() + interval '30 minutes' order by tm.breach_at limit 50`),
      db.execute(sql`select c.id as conversation_id, c.channel, c.last_message_at, c.last_message_preview, l.id as lead_id, l.number as lead_number, ct.display_name as contact_name
        from los_conversations c join los_leads l on l.id = c.lead_id join los_contacts ct on ct.id = c.contact_id
        where c.state = 'waiting_us' and not c.is_junk and l.owner_id = ${u.id}::uuid order by c.last_message_at asc limit 50`),
      db.execute(sql`select l.id as lead_id, l.number as lead_number, l.next_step, l.next_step_at, l.stage, ct.display_name as contact_name
        from los_leads l join los_contacts ct on ct.id = l.contact_id
        where l.owner_id = ${u.id}::uuid and l.closed_at is null and l.next_step_at < now() + interval '1 day' order by l.next_step_at limit 50`),
    ]);
    const missingNextStep = await db
      .select({ id: leads.id, number: leads.number, stage: leads.stage })
      .from(leads)
      .where(and(eq(leads.ownerId, u.id), isNull(leads.closedAt), isNull(leads.nextStepAt), inArray(leads.stage, ["engaged", "qualified", "quoted", "negotiation"])))
      .limit(50);
    return { overdue: overdue.rows, today: today.rows, slaRisk: slaRisk.rows, unanswered: unanswered.rows, nextSteps: nextSteps.rows, missingNextStep };
  });
}
