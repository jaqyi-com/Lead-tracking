/**
 * Admin (§8.1): users & roles, routing rules, business hours & holidays, SLA targets, templates,
 * sources, sequences, consent ledger, parser queue, duplicates, queue health & replay, broadcasts,
 * CSV import, DPDP data-rights requests, audit log, bulk export.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  broadcasts,
  businessHours,
  contacts,
  dataRightsRequests,
  duplicateSuggestions,
  getDb,
  holidays,
  leadSources,
  parseFailures,
  routingRules,
  sequenceSteps,
  sequences,
  slaPolicies,
  teams,
  templates,
  users,
  waNumbers,
  webhookEvents,
  mailboxConnections,
  type Role,
} from "@lead/db";
import { hashPassword, isOpen, describeHours } from "@lead/domain";
import {
  Fx,
  ForbiddenError,
  NotFoundError,
  DomainError,
  anonymiseContact,
  approveAndSend,
  audit,
  broadcastResults,
  chooseOwner,
  clearCalendarCache,
  consentStatus,
  createBroadcast,
  exportContactData,
  importLeads,
  mergeContacts,
  parseCsv,
  previewBroadcast,
  recordConsent,
  replayEvent,
  submitTemplate,
  syncTemplatesFromProvider,
  withTx,
  withdrawConsent,
  calendarById,
  ORG_ID,
} from "@lead/core";
import { actorOf, idParam, parse, requireRole, requireUser } from "../http";

const ROLES = ["admin", "manager", "rep", "viewer", "service"] as const;

export async function adminRoutes(app: FastifyInstance) {
  const db = getDb();
  const admin = (req: Parameters<typeof requireRole>[0]) => requireRole(req, "admin");
  const mgr = (req: Parameters<typeof requireRole>[0]) => requireRole(req, "admin", "manager");

  // ---- Users & teams ----
  app.get("/api/admin/users", async (req) => {
    mgr(req);
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, teamId: users.teamId, isAvailable: users.isAvailable, capacity: users.capacity, active: users.active, totpEnabled: users.totpEnabled, languages: users.languages, territories: users.territories, workingHoursId: users.workingHoursId, lastSeenAt: users.lastSeenAt })
      .from(users)
      .orderBy(asc(users.name));
    const open = await db.execute(sql`select owner_id, count(*)::int as n from los_leads where closed_at is null group by owner_id`);
    const counts = new Map((open.rows as { owner_id: string; n: number }[]).map((r) => [r.owner_id, r.n]));
    return { items: rows.map((r) => ({ ...r, openLeads: counts.get(r.id) ?? 0 })), teams: await db.select().from(teams) };
  });

  const userSchema = z.object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
    role: z.enum(ROLES),
    teamId: z.string().uuid().nullable().optional(),
    capacity: z.number().int().min(1).max(1000).optional(),
    password: z.string().min(10).max(200).optional(),
    languages: z.array(z.string()).optional(),
    territories: z.array(z.string()).optional(),
    workingHoursId: z.string().uuid().nullable().optional(),
  });

  app.post("/api/admin/users", async (req) => {
    admin(req);
    const b = parse(userSchema, req.body);
    const [u] = await withTx(async (tx) => {
      const rows = await tx
        .insert(users)
        .values({
          orgId: ORG_ID,
          name: b.name,
          email: b.email.toLowerCase(),
          role: b.role as Role,
          teamId: b.teamId ?? null,
          capacity: b.capacity ?? 60,
          passwordHash: b.password ? await hashPassword(b.password) : null,
          languages: b.languages ?? [],
          territories: b.territories ?? [],
          workingHoursId: b.workingHoursId ?? null,
        })
        .returning({ id: users.id, email: users.email });
      await audit(tx, actorOf(req), "user.create", "user", rows[0]!.id, null, { ...b, password: undefined });
      return rows;
    });
    return { user: u };
  });

  app.patch("/api/admin/users/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(userSchema.partial().extend({ active: z.boolean().optional(), isAvailable: z.boolean().optional() }), req.body);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, id));
      if (!before) throw new NotFoundError("User");
      const { password, ...rest } = b;
      await tx
        .update(users)
        .set({ ...rest, ...(rest.email ? { email: rest.email.toLowerCase() } : {}), ...(password ? { passwordHash: await hashPassword(password) } : {}) })
        .where(eq(users.id, id));
      if (b.active === false) await tx.execute(sql`delete from los_sessions where user_id = ${id}::uuid`);
      await audit(tx, actorOf(req), "user.update", "user", id, { role: before.role, active: before.active }, { ...rest });
    });
    return { ok: true };
  });

  app.post("/api/admin/teams", async (req) => {
    admin(req);
    const b = parse(z.object({ name: z.string().min(1), businessHoursId: z.string().uuid().nullable().optional() }), req.body);
    const [t] = await db.insert(teams).values({ orgId: ORG_ID, name: b.name, businessHoursId: b.businessHoursId ?? null }).returning();
    return { team: t };
  });

  // ---- Routing rules ----
  const conditions = z.object({
    sources: z.array(z.string()).optional(),
    sourceDetailContains: z.array(z.string()).optional(),
    sizeBands: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    cities: z.array(z.string()).optional(),
    states: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    channels: z.array(z.enum(["whatsapp", "email"])).optional(),
    minScore: z.number().optional(),
  });
  const ruleSchema = z.object({
    name: z.string().min(1).max(200),
    priority: z.number().int(),
    conditions,
    strategy: z.enum(["round_robin", "specific_user", "unassigned"]),
    targetTeamId: z.string().uuid().nullable().optional(),
    targetUserId: z.string().uuid().nullable().optional(),
    fallback: z.enum(["next_rule", "unassigned"]).default("next_rule"),
    active: z.boolean().default(true),
  });

  app.get("/api/admin/routing-rules", async (req) => {
    mgr(req);
    return { items: await db.select().from(routingRules).orderBy(asc(routingRules.priority)) };
  });
  app.post("/api/admin/routing-rules", async (req) => {
    admin(req);
    const b = parse(ruleSchema, req.body);
    const [r] = await withTx(async (tx) => {
      const rows = await tx.insert(routingRules).values({ ...b, orgId: ORG_ID }).returning();
      await audit(tx, actorOf(req), "routing_rule.create", "routing_rule", rows[0]!.id, null, b);
      return rows;
    });
    return { rule: r };
  });
  app.patch("/api/admin/routing-rules/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(ruleSchema.partial(), req.body);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(routingRules).where(eq(routingRules.id, id));
      await tx.update(routingRules).set(b).where(eq(routingRules.id, id));
      await audit(tx, actorOf(req), "routing_rule.update", "routing_rule", id, before, b);
    });
    return { ok: true };
  });
  app.delete("/api/admin/routing-rules/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(routingRules).where(eq(routingRules.id, id));
      await tx.delete(routingRules).where(eq(routingRules.id, id));
      await audit(tx, actorOf(req), "routing_rule.delete", "routing_rule", id, before, null);
    });
    return { ok: true };
  });
  /** "Test this rule set against lead X" dry run. */
  app.post("/api/admin/routing-rules/test", async (req) => {
    mgr(req);
    const b = parse(
      z.object({ source: z.string(), sourceDetail: z.string().optional(), city: z.string().optional(), state: z.string().optional(), text: z.string().optional(), sizeBand: z.string().optional(), language: z.string().optional() }),
      req.body,
    );
    const [anyContact] = await db.select({ id: contacts.id }).from(contacts).limit(1);
    const r = await chooseOwner(db, { contactId: anyContact?.id ?? "00000000-0000-0000-0000-000000000000", companyId: null }, b);
    const [owner] = r.ownerId ? await db.select({ name: users.name }).from(users).where(eq(users.id, r.ownerId)) : [];
    return { ...r, ownerName: owner?.name ?? null };
  });

  // ---- Business hours, holidays, SLA ----
  app.get("/api/admin/business-hours", async (req) => {
    requireUser(req);
    const rows = await db.select().from(businessHours);
    const hols = await db.select().from(holidays).orderBy(asc(holidays.day));
    const out = [];
    for (const r of rows) {
      const cal = await calendarById(db, r.id);
      out.push({ ...r, openNow: isOpen(cal, new Date()), description: describeHours(cal) });
    }
    return { items: out, holidays: hols };
  });
  app.patch("/api/admin/business-hours/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
    const b = parse(z.object({ name: z.string().optional(), timezone: z.string().optional(), weekly: z.record(z.array(z.tuple([hm, hm]))).optional() }), req.body);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(businessHours).where(eq(businessHours.id, id));
      await tx.update(businessHours).set(b).where(eq(businessHours.id, id));
      await audit(tx, actorOf(req), "business_hours.update", "business_hours", id, before, b);
    });
    clearCalendarCache();
    return { ok: true };
  });
  app.post("/api/admin/holidays", async (req) => {
    admin(req);
    const b = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(1), businessHoursId: z.string().uuid().nullable().optional() }), req.body);
    const [h] = await db.insert(holidays).values({ orgId: ORG_ID, day: b.day, name: b.name, businessHoursId: b.businessHoursId ?? null }).returning();
    clearCalendarCache();
    return { holiday: h };
  });
  app.delete("/api/admin/holidays/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    await db.delete(holidays).where(eq(holidays.id, id));
    clearCalendarCache();
    return { ok: true };
  });
  app.get("/api/admin/sla-policies", async (req) => {
    mgr(req);
    return { items: await db.select().from(slaPolicies) };
  });
  app.patch("/api/admin/sla-policies/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ targetMinutes: z.number().int().min(1).max(100_000).optional(), active: z.boolean().optional() }), req.body);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, id));
      await tx.update(slaPolicies).set(b).where(eq(slaPolicies.id, id));
      await audit(tx, actorOf(req), "sla_policy.update", "sla_policy", id, before, b);
    });
    return { ok: true };
  });

  // ---- Sources ----
  app.get("/api/admin/sources", async (req) => {
    requireUser(req);
    return { items: await db.select().from(leadSources).orderBy(asc(leadSources.label)) };
  });
  app.post("/api/admin/sources", async (req) => {
    admin(req);
    const b = parse(z.object({ key: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1) }), req.body);
    const [s] = await db.insert(leadSources).values({ orgId: ORG_ID, ...b }).onConflictDoNothing().returning();
    return { source: s };
  });
  app.patch("/api/admin/sources/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ label: z.string().optional(), active: z.boolean().optional() }), req.body);
    await db.update(leadSources).set(b).where(eq(leadSources.id, id));
    return { ok: true };
  });

  // ---- Templates (admin) ----
  const tplSchema = z.object({
    internalName: z.string().regex(/^[a-z0-9_]+$/),
    providerName: z.string().regex(/^[a-z0-9_]+$/).optional(),
    category: z.enum(["utility", "marketing", "authentication"]),
    language: z.string().default("en"),
    body: z.string().min(1).max(1024),
    header: z.string().max(60).nullable().optional(),
    footer: z.string().max(60).nullable().optional(),
    variables: z.array(z.object({ key: z.string(), example: z.string().optional(), source: z.string().optional() })).default([]),
  });
  app.post("/api/admin/templates", async (req) => {
    admin(req);
    const b = parse(tplSchema, req.body);
    // Template hygiene (§5.5): never put the entire message inside one variable.
    if (/^\s*\{\{\s*\w+\s*\}\}\s*$/.test(b.body)) throw new DomainError("template_hygiene", "A template can't be just one variable — Meta will reject it.");
    const [t] = await db
      .insert(templates)
      .values({ ...b, orgId: ORG_ID, channel: "whatsapp", providerName: b.providerName ?? b.internalName, approvalStatus: "draft" })
      .returning();
    return { template: t };
  });
  app.patch("/api/admin/templates/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(tplSchema.partial().extend({ approvalStatus: z.enum(["draft", "pending", "approved", "rejected", "paused", "disabled"]).optional() }), req.body);
    await withTx(async (tx) => {
      const [before] = await tx.select().from(templates).where(eq(templates.id, id));
      await tx.update(templates).set({ ...b, updatedAt: new Date() }).where(eq(templates.id, id));
      await audit(tx, actorOf(req), "template.update", "template", id, before, b);
    });
    return { ok: true };
  });
  app.post("/api/admin/templates/:id/submit", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    return { template: await submitTemplate(db, id) };
  });
  app.post("/api/admin/templates/sync", async (req) => {
    admin(req);
    return syncTemplatesFromProvider(db);
  });

  // ---- Sequences ----
  app.get("/api/admin/sequences", async (req) => {
    mgr(req);
    const seqs = await db.select().from(sequences);
    const steps = await db.select().from(sequenceSteps).orderBy(asc(sequenceSteps.position));
    return { items: seqs.map((s) => ({ ...s, steps: steps.filter((x) => x.sequenceId === s.id) })) };
  });
  app.patch("/api/admin/sequence-steps/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        offsetMinutes: z.number().int().min(0).optional(),
        offsetBusiness: z.boolean().optional(),
        channel: z.enum(["same_channel", "whatsapp", "email", "whatsapp_or_email", "none"]).optional(),
        templateInternalName: z.string().nullable().optional(),
        waBody: z.string().max(4000).nullable().optional(),
        emailSubject: z.string().max(300).nullable().optional(),
        emailBody: z.string().max(10_000).nullable().optional(),
        taskTitle: z.string().max(300).nullable().optional(),
      }),
      req.body,
    );
    await withTx(async (tx) => {
      const [before] = await tx.select().from(sequenceSteps).where(eq(sequenceSteps.id, id));
      await tx.update(sequenceSteps).set(b).where(eq(sequenceSteps.id, id));
      await audit(tx, actorOf(req), "sequence_step.update", "sequence_step", id, before, b);
    });
    return { ok: true };
  });
  app.patch("/api/admin/sequences/:id", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ active: z.boolean().optional(), name: z.string().optional() }), req.body);
    await db.update(sequences).set(b).where(eq(sequences.id, id));
    return { ok: true };
  });

  // ---- Consent ledger ----
  app.get("/api/contacts/:id/consent", async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    return consentStatus(db, id);
  });
  app.post("/api/contacts/:id/consent", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const { id } = parse(idParam, req.params);
    const b = parse(
      z.object({
        action: z.enum(["grant", "withdraw"]),
        channel: z.enum(["whatsapp", "email", "all"]),
        purpose: z.enum(["utility", "marketing", "all"]).default("marketing"),
        evidence: z.string().min(5).max(2000),
        noticeVersion: z.string().optional(),
      }),
      req.body,
    );
    await withTx(async (tx) => {
      if (b.action === "withdraw") await withdrawConsent(tx, id, b.channel, "manual", { note: b.evidence, by: u.id }, actorOf(req));
      else
        await recordConsent(tx, { contactId: id, channel: b.channel, purpose: b.purpose, state: "granted", basis: "manual", evidence: { note: b.evidence, by: u.id }, noticeVersion: b.noticeVersion, ip: req.ip, actor: actorOf(req) });
      await audit(tx, actorOf(req), `consent.${b.action}`, "contact", id, null, b);
    });
    return { ok: true };
  });

  // ---- Parser failures, duplicates ----
  app.get("/api/admin/parse-failures", async (req) => {
    mgr(req);
    const rows = await db.select().from(parseFailures).where(isNull(parseFailures.resolvedAt)).orderBy(desc(parseFailures.createdAt)).limit(200);
    return { items: rows };
  });
  app.post("/api/admin/parse-failures/:id/resolve", async (req) => {
    const u = mgr(req);
    const { id } = parse(idParam, req.params);
    await db.update(parseFailures).set({ resolvedAt: new Date(), resolvedBy: u.id }).where(eq(parseFailures.id, id));
    return { ok: true };
  });
  app.get("/api/admin/duplicates", async (req) => {
    mgr(req);
    const r = await db.execute(sql`
      select d.*, row_to_json(a) as a, row_to_json(b) as b,
        (select json_agg(json_build_object('kind', kind, 'value', value_normalised)) from los_channel_identities where contact_id = d.contact_a) as a_identities,
        (select json_agg(json_build_object('kind', kind, 'value', value_normalised)) from los_channel_identities where contact_id = d.contact_b) as b_identities
      from los_duplicate_suggestions d join los_contacts a on a.id = d.contact_a join los_contacts b on b.id = d.contact_b
      where d.status = 'open' order by d.created_at desc limit 100`);
    return { items: r.rows };
  });
  app.post("/api/admin/duplicates/:id/merge", async (req) => {
    mgr(req);
    const { id } = parse(idParam, req.params);
    const { keep } = parse(z.object({ keep: z.enum(["a", "b"]) }), req.body);
    const [d] = await db.select().from(duplicateSuggestions).where(eq(duplicateSuggestions.id, id));
    if (!d) throw new NotFoundError("Suggestion");
    const [keepId, mergeId] = keep === "a" ? [d.contactA, d.contactB] : [d.contactB, d.contactA];
    await withTx((tx) => mergeContacts(tx, keepId, mergeId, actorOf(req)));
    return { ok: true };
  });
  app.post("/api/admin/duplicates/:id/dismiss", async (req) => {
    const u = mgr(req);
    const { id } = parse(idParam, req.params);
    await db.update(duplicateSuggestions).set({ status: "dismissed", resolvedBy: u.id, resolvedAt: new Date() }).where(eq(duplicateSuggestions.id, id));
    return { ok: true };
  });

  // ---- Queue health & dead-letter replay ----
  app.get("/api/admin/queue-health", async (req) => {
    mgr(req);
    const [stats] = (await db.execute(sql`
      select
        count(*) filter (where processed_at is null)::int as unprocessed,
        count(*) filter (where processed_at is null and error is not null)::int as failing,
        count(*) filter (where received_at > now() - interval '1 hour')::int as last_hour,
        min(received_at) filter (where processed_at is null) as oldest_unprocessed
      from los_webhook_events`)).rows;
    const failed = await db
      .select({ id: webhookEvents.id, provider: webhookEvents.provider, externalId: webhookEvents.externalId, receivedAt: webhookEvents.receivedAt, attempts: webhookEvents.attempts, error: webhookEvents.error })
      .from(webhookEvents)
      .where(isNotNull(webhookEvents.error))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(100);
    const [msgs] = (await db.execute(sql`
      select count(*) filter (where status in ('queued','sending') and (send_at is null or send_at <= now()))::int as outbound_queue,
             count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours')::int as failed_24h
      from los_messages`)).rows;
    const mailboxes = await db.select({ email: mailboxConnections.email, status: mailboxConnections.status, watchExpiresAt: mailboxConnections.watchExpiresAt, lastError: mailboxConnections.lastError }).from(mailboxConnections);
    const numbers = await db.select().from(waNumbers);
    return { webhooks: stats, failedEvents: failed, messages: msgs, mailboxes, numbers };
  });
  app.post("/api/admin/webhook-events/:id/replay", async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    const fx = new Fx();
    await replayEvent(id, fx);
    await fx.flush();
    await withTx((tx) => audit(tx, actorOf(req), "webhook.replay", "webhook_event", id, null, null));
    return { ok: true };
  });

  // ---- Broadcasts ----
  const segment = z.object({ stages: z.array(z.string()).optional(), sources: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), createdAfter: z.string().optional(), createdBefore: z.string().optional() });
  app.get("/api/broadcasts", async (req) => {
    mgr(req);
    return { items: await db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).limit(100) };
  });
  app.post("/api/broadcasts/preview", async (req) => {
    mgr(req);
    const b = parse(z.object({ templateId: z.string().uuid(), segment }), req.body);
    return previewBroadcast(db, b.templateId, b.segment);
  });
  app.post("/api/broadcasts", async (req) => {
    mgr(req);
    const b = parse(z.object({ name: z.string().min(1).max(200), templateId: z.string().uuid(), segment }), req.body);
    return withTx((tx) => createBroadcast(tx, actorOf(req), b));
  });
  app.post("/api/broadcasts/:id/approve", async (req) => {
    mgr(req);
    const { id } = parse(idParam, req.params);
    const { confirmation } = parse(z.object({ confirmation: z.string() }), req.body);
    await withTx((tx, fx) => approveAndSend(tx, fx, id, actorOf(req), confirmation));
    return { ok: true };
  });
  app.get("/api/broadcasts/:id/results", async (req) => {
    mgr(req);
    const { id } = parse(idParam, req.params);
    return { rows: await broadcastResults(db, id) };
  });

  // ---- CSV import ----
  app.post("/api/admin/import", async (req) => {
    mgr(req);
    const b = parse(z.object({ csv: z.string().min(1).max(10_000_000), dryRun: z.boolean().default(true) }), req.body);
    const rows = parseCsv(b.csv);
    if (rows.length > 20_000) throw new DomainError("too_many_rows", "Import at most 20,000 rows at a time");
    const report = await importLeads(db, rows, actorOf(req), b.dryRun);
    if (!b.dryRun) await withTx((tx) => audit(tx, actorOf(req), "leads.import", "lead", null, null, { rows: rows.length, created: report.created }));
    return report;
  });

  // ---- DPDP data principal rights (§11.4) ----
  app.get("/api/admin/data-requests", async (req) => {
    admin(req);
    return { items: await db.select().from(dataRightsRequests).orderBy(desc(dataRightsRequests.requestedAt)).limit(200) };
  });
  app.post("/api/admin/data-requests", async (req) => {
    admin(req);
    const b = parse(
      z.object({ kind: z.enum(["access", "correction", "erasure", "grievance"]), contactId: z.string().uuid().optional(), requesterEmail: z.string().email().optional(), requesterPhone: z.string().optional(), details: z.string().max(5000).optional() }),
      req.body,
    );
    const [r] = await db
      .insert(dataRightsRequests)
      .values({ orgId: ORG_ID, ...b, contactId: b.contactId ?? null, dueAt: new Date(Date.now() + 30 * 86_400_000) })
      .returning();
    return { request: r };
  });
  app.post("/api/admin/data-requests/:id/complete", async (req) => {
    const u = admin(req);
    const { id } = parse(idParam, req.params);
    const { resolution, execute } = parse(z.object({ resolution: z.string().min(3), execute: z.boolean().default(false) }), req.body);
    const [r] = await db.select().from(dataRightsRequests).where(eq(dataRightsRequests.id, id));
    if (!r) throw new NotFoundError("Request");
    let data: unknown = null;
    if (execute && r.contactId) {
      if (r.kind === "erasure") await anonymiseContact(db, r.contactId, actorOf(req));
      if (r.kind === "access") data = await exportContactData(db, r.contactId);
    }
    await db.update(dataRightsRequests).set({ status: "done", completedAt: new Date(), handledBy: u.id, resolution }).where(eq(dataRightsRequests.id, id));
    await withTx((tx) => audit(tx, actorOf(req), `data_request.${r.kind}`, "data_rights_request", id, null, { resolution, executed: execute }));
    return { ok: true, data };
  });

  // ---- Audit log ----
  app.get("/api/admin/audit", async (req) => {
    admin(req);
    const q = parse(z.object({ entity: z.string().optional(), entityId: z.string().optional() }), req.query);
    const conds = [];
    if (q.entity) conds.push(eq(auditLog.entity, q.entity));
    if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
    const rows = await db
      .select()
      .from(auditLog)
      .where(conds.length ? sql.join(conds.map((c) => sql`${c}`), sql` and `) : undefined)
      .orderBy(desc(auditLog.at))
      .limit(300);
    return { items: rows };
  });

  // ---- Bulk export: admin-only, logged, rate-limited (§11.1) ----
  app.get(
    "/api/admin/export/leads.csv",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (req, reply) => {
      admin(req);
      const r = await db.execute(sql`
        select 'L-' || l.number as lead, l.stage, l.source, l.created_at, l.closed_at, l.value_estimate, l.score,
               ct.display_name as contact, co.name as company, u.name as owner,
               (select string_agg(value_normalised, ' ') from los_channel_identities where contact_id = ct.id and kind <> 'wa_id') as routes
        from los_leads l join los_contacts ct on ct.id = l.contact_id left join los_companies co on co.id = l.company_id left join los_users u on u.id = l.owner_id
        where ct.anonymised_at is null order by l.created_at desc`);
      await withTx((tx) => audit(tx, actorOf(req), "leads.export", "lead", null, null, { rows: r.rows.length }));
      const cols = ["lead", "stage", "source", "created_at", "closed_at", "value_estimate", "score", "contact", "company", "owner", "routes"];
      const esc = (v: unknown) => {
        const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [cols.join(","), ...(r.rows as Record<string, unknown>[]).map((row) => cols.map((c) => esc(row[c])).join(","))].join("\n");
      reply.header("Content-Type", "text/csv").header("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
      return csv;
    },
  );

}
