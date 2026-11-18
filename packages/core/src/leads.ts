/**
 * Lead lifecycle: lead decision (§3.1.5, §7.3), stage changes (§3.2, §8.4), assignment, and the
 * hooks that run when a client writes or a human replies.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts,
  conversations,
  leads,
  lostReasons,
  tasks,
  users,
  type Db,
  type Stage,
} from "@lead/db";
import {
  businessMinutesBetween,
  isClosed,
  requiresQualification,
  validateNextStep,
  validateTransition,
} from "@lead/domain";
import type { Fx } from "./effects";
import { DomainError, NotFoundError } from "./errors";
import { ORG_ID, SYSTEM, audit, calendarForTeam, logActivity, notify, type Actor } from "./support";
import { cancelAllTimers, retargetTimers, startTimer, stopTimers } from "./sla";

export type Lead = typeof leads.$inferSelect;

const OPEN_LEAD_MAX_AGE_DAYS = 30;
/** Stale open leads in these stages are worked deals — attach rather than auto-close (plan §3.7). */
const ATTACH_EVEN_IF_STALE: Stage[] = ["quoted", "negotiation"];

export async function getLead(db: Db, id: string): Promise<Lead> {
  const [l] = await db.select().from(leads).where(eq(leads.id, id));
  if (!l) throw new NotFoundError("Lead");
  return l;
}

/**
 * §3.1.5 lead decision. Returns the open lead to attach to, or null when a new lead is needed
 * (with the previous lead id to link).
 */
export async function decideLead(
  tx: Db,
  fx: Fx,
  contactId: string,
  now: Date,
): Promise<{ attachTo: Lead | null; previousLeadId: string | null }> {
  const open = await tx
    .select()
    .from(leads)
    .where(and(eq(leads.contactId, contactId), isNull(leads.closedAt)))
    .orderBy(desc(leads.openedAt));
  const cutoff = now.getTime() - OPEN_LEAD_MAX_AGE_DAYS * 86_400_000;
  for (const l of open) {
    if (l.openedAt.getTime() >= cutoff || ATTACH_EVEN_IF_STALE.includes(l.stage)) return { attachTo: l, previousLeadId: null };
  }
  // Stale open leads: close as went silent and link the new opportunity to the most recent one.
  for (const l of open) {
    await closeLeadSystem(tx, fx, l, "lost", { lostReason: "went_silent", note: "Auto-closed: new enquiry after 30 days" });
  }
  const [prev] = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.contactId, contactId))
    .orderBy(desc(leads.openedAt))
    .limit(1);
  return { attachTo: null, previousLeadId: prev?.id ?? null };
}

export async function createLead(
  tx: Db,
  fx: Fx,
  input: {
    contactId: string;
    companyId: string | null;
    source: string;
    sourceDetail?: string | null;
    portalLeadId?: string | null;
    enquiry?: string | null;
    language?: string | null;
    previousLeadId?: string | null;
    firstInboundAt?: Date | null;
    parseFailed?: boolean;
    isJunk?: boolean;
    stage?: Stage;
    ownerId?: string | null;
    valueEstimate?: string | null;
    actor?: Actor;
    startTimers?: boolean;
  },
): Promise<Lead> {
  const now = new Date();
  const [lead] = await tx
    .insert(leads)
    .values({
      orgId: ORG_ID,
      contactId: input.contactId,
      companyId: input.companyId,
      source: input.source,
      sourceDetail: input.sourceDetail ?? null,
      portalLeadId: input.portalLeadId ?? null,
      enquiry: input.enquiry ?? null,
      language: input.language ?? null,
      previousLeadId: input.previousLeadId ?? null,
      firstInboundAt: input.firstInboundAt ?? null,
      parseFailed: input.parseFailed ?? false,
      isJunk: input.isJunk ?? false,
      stage: input.stage ?? "new",
      ownerId: input.ownerId ?? null,
      valueEstimate: input.valueEstimate ?? null,
      openedAt: now,
      tags: input.isJunk ? ["junk"] : [],
    })
    .returning();
  await logActivity(tx, lead!.id, "lead_created", input.actor ?? SYSTEM, {
    source: input.source,
    sourceDetail: input.sourceDetail,
    previousLeadId: input.previousLeadId,
    parseFailed: input.parseFailed,
  });
  if (!input.isJunk && input.startTimers !== false) {
    const startedAt = input.firstInboundAt ?? now;
    await startTimer(tx, fx, { leadId: lead!.id, kind: "assignment", stage: "new", startedAt });
    await startTimer(tx, fx, { leadId: lead!.id, kind: "first_response", stage: "attempting", startedAt });
  }
  fx.publish({ type: "lead.created", orgId: ORG_ID, leadId: lead!.id });
  fx.enqueue("lead.enrich", { leadId: lead!.id });
  return lead!;
}

// ---------------------------------------------------------------------------
// Stage changes
// ---------------------------------------------------------------------------

export async function changeStage(
  tx: Db,
  fx: Fx,
  leadId: string,
  to: Stage,
  actor: Actor,
  opts: { lostReason?: string | null; lostNote?: string | null; revisitAt?: Date | null; reason?: string } = {},
): Promise<Lead> {
  const lead = await getLead(tx, leadId);
  const from = lead.stage;
  if (from === to) return lead;

  const validReasons = (await tx.select({ key: lostReasons.key }).from(lostReasons).where(eq(lostReasons.active, true))).map(
    (r) => r.key,
  );
  const result = validateTransition({
    from,
    to,
    qualification: lead.qualification,
    lostReason: opts.lostReason ?? lead.lostReason,
    revisitAt: opts.revisitAt ?? lead.revisitAt,
    validLostReasons: validReasons,
    actor: actor.type === "user" ? "user" : "system",
  });
  if (!result.ok) {
    // System moves (cadence → nurture, reply → engaged) are never blocked by human-only rules,
    // but closed leads stay closed for everyone.
    const blocking = actor.type === "user" ? result.errors : result.errors.filter((e) => e.code === "closed");
    if (blocking.length) throw new DomainError(blocking[0]!.code, blocking.map((e) => e.message).join(" "), 422, blocking);
  }

  const now = new Date();
  const closing = isClosed(to);
  const patch: Partial<Lead> = { stage: to, updatedAt: now, lastActivityAt: now };
  if (closing) patch.closedAt = now;
  if (to === "won") patch.wonAt = now;
  if (to === "lost") {
    patch.lostReason = opts.lostReason ?? lead.lostReason;
    patch.lostNote = opts.lostNote ?? null;
  }
  if (to === "nurture") patch.revisitAt = opts.revisitAt ?? lead.revisitAt;
  const [updated] = await tx.update(leads).set(patch).where(eq(leads.id, leadId)).returning();

  await logActivity(tx, leadId, "stage_changed", actor, {
    from,
    to,
    lostReason: patch.lostReason,
    revisitAt: patch.revisitAt,
    reason: opts.reason,
  });
  if (actor.type === "user") await audit(tx, actor, "lead.stage", "lead", leadId, { stage: from }, { stage: to });

  // SLA bookkeeping.
  await stopTimers(tx, leadId, ["stage_exit"], "met");
  if (closing) await cancelAllTimers(tx, leadId);
  else await startTimer(tx, fx, { leadId, kind: "stage_exit", stage: to, ownerId: updated!.ownerId, teamId: updated!.teamId });

  // Cadence: enroll on Attempting; stop once past Engaged or closed.
  const { enrollDefault, stopEnrollments } = await import("./cadence");
  if (to === "attempting") await enrollDefault(tx, fx, leadId);
  if (closing || requiresQualification(to)) await stopEnrollments(tx, leadId, closing ? `closed_${to}` : `stage_${to}`);

  if (to === "nurture" && updated!.revisitAt) {
    await tx.insert(tasks).values({
      orgId: ORG_ID,
      leadId,
      assigneeId: updated!.ownerId,
      title: "Revisit nurture lead",
      type: "revisit",
      dueAt: updated!.revisitAt,
    });
  }
  if (closing) {
    await tx
      .update(conversations)
      .set({ state: "closed", updatedAt: now })
      .where(eq(conversations.leadId, leadId));
  }
  if (to === "won") {
    await notify(tx, fx, {
      userIds: [updated!.ownerId],
      type: "lead_won",
      title: `Won: L-${updated!.number} — hand off to onboarding today`,
      leadId,
      push: false,
    });
  }
  fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId });
  return updated!;
}

async function closeLeadSystem(tx: Db, fx: Fx, lead: Lead, to: Stage, o: { lostReason?: string; note?: string }) {
  await tx
    .update(leads)
    .set({ stage: to, closedAt: new Date(), lostReason: o.lostReason ?? null, lostNote: o.note ?? null, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  await logActivity(tx, lead.id, "stage_changed", SYSTEM, { from: lead.stage, to, lostReason: o.lostReason, reason: o.note });
  await cancelAllTimers(tx, lead.id);
  const { stopEnrollments } = await import("./cadence");
  await stopEnrollments(tx, lead.id, "auto_closed");
  fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId: lead.id });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Assign a lead. System assignment is idempotent (only if unowned) — two webhooks in the same
 * second can never produce two owners (§9.1). Users (claim/reassign) go through the same path.
 */
export async function assignLead(
  tx: Db,
  fx: Fx,
  leadId: string,
  userId: string,
  actor: Actor,
  opts: { reason?: string; onlyIfUnassigned?: boolean } = {},
): Promise<Lead | null> {
  const before = await getLead(tx, leadId);
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user || !user.active) throw new DomainError("invalid_user", "That user is not active");
  if (before.ownerId === userId) return before;

  const now = new Date();
  const where = opts.onlyIfUnassigned ? and(eq(leads.id, leadId), isNull(leads.ownerId)) : eq(leads.id, leadId);
  const [updated] = await tx
    .update(leads)
    .set({ ownerId: userId, teamId: user.teamId, assignedAt: before.assignedAt ?? now, updatedAt: now, lastActivityAt: now })
    .where(where)
    .returning();
  if (!updated) return null; // somebody else won the race

  await tx.update(users).set({ lastAssignedAt: now }).where(eq(users.id, userId));
  await tx.update(conversations).set({ assignedTo: userId, updatedAt: now }).where(eq(conversations.leadId, leadId));
  // Sticky owner for future enquiries from this contact.
  await tx
    .update(contacts)
    .set({ ownerId: userId })
    .where(and(eq(contacts.id, updated.contactId), isNull(contacts.ownerId)));

  await logActivity(tx, leadId, before.ownerId ? "reassigned" : "assigned", actor, {
    from: before.ownerId,
    to: userId,
    reason: opts.reason,
  });
  if (actor.type === "user") await audit(tx, actor, "lead.assign", "lead", leadId, { ownerId: before.ownerId }, { ownerId: userId });

  await stopTimers(tx, leadId, ["assignment"], "met");
  await retargetTimers(tx, leadId, userId);

  if (updated.stage === "new") await changeStage(tx, fx, leadId, "attempting", SYSTEM, { reason: "assigned" });

  await notify(tx, fx, {
    userIds: [userId],
    type: before.ownerId ? "lead_reassigned" : "lead_assigned",
    title: before.ownerId ? `Lead L-${updated.number} reassigned to you` : `New lead L-${updated.number} assigned to you`,
    body: opts.reason,
    leadId,
    email: !before.ownerId,
  });
  fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId });
  return updated;
}

/** Claim from Unassigned with one key ("a"). Fails if someone else already has it. */
export async function claimLead(tx: Db, fx: Fx, leadId: string, actor: Actor): Promise<Lead> {
  if (!actor.id) throw new DomainError("invalid_actor", "Claim needs a user");
  const r = await assignLead(tx, fx, leadId, actor.id, actor, { onlyIfUnassigned: true, reason: "claimed" });
  if (!r) throw new DomainError("already_assigned", "Someone else claimed this lead a moment ago", 409);
  return r;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

export type LeadPatch = {
  qualification?: Record<string, unknown>;
  nextStep?: string | null;
  nextStepAt?: string | Date | null;
  valueEstimate?: string | number | null;
  tags?: string[];
  sourceDetail?: string | null;
  enquiry?: string | null;
  isJunk?: boolean;
};

export async function updateLead(tx: Db, fx: Fx, leadId: string, patch: LeadPatch, actor: Actor): Promise<Lead> {
  const before = await getLead(tx, leadId);
  const set: Partial<Lead> = { updatedAt: new Date(), lastActivityAt: new Date() };
  if (patch.qualification) set.qualification = { ...before.qualification, ...patch.qualification };
  if (patch.nextStep !== undefined) set.nextStep = patch.nextStep;
  if (patch.nextStepAt !== undefined) set.nextStepAt = patch.nextStepAt ? new Date(patch.nextStepAt) : null;
  if (patch.valueEstimate !== undefined) set.valueEstimate = patch.valueEstimate == null ? null : String(patch.valueEstimate);
  if (patch.tags) set.tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (patch.sourceDetail !== undefined) set.sourceDetail = patch.sourceDetail;
  if (patch.enquiry !== undefined) set.enquiry = patch.enquiry;
  if (patch.isJunk !== undefined) set.isJunk = patch.isJunk;

  // §8.4 rule 3: human saves of an open lead need a next step with a date.
  if (actor.type === "user" && (patch.nextStepAt !== undefined || patch.nextStep !== undefined)) {
    const err = validateNextStep(before.stage, set.nextStepAt === undefined ? before.nextStepAt : set.nextStepAt);
    if (err) throw new DomainError("next_step_required", err, 422);
  }

  const [updated] = await tx.update(leads).set(set).where(eq(leads.id, leadId)).returning();
  const changed = Object.keys(patch);
  await logActivity(tx, leadId, "lead_updated", actor, {
    fields: changed,
    ...(patch.qualification ? { qualification: patch.qualification } : {}),
    ...(patch.nextStepAt !== undefined ? { nextStep: set.nextStep ?? before.nextStep, nextStepAt: set.nextStepAt } : {}),
  });
  await audit(tx, actor, "lead.update", "lead", leadId, pick(before, changed), pick(updated!, changed));
  if (patch.nextStepAt && updated!.ownerId) {
    await tx.insert(tasks).values({
      orgId: ORG_ID,
      leadId,
      assigneeId: updated!.ownerId,
      title: set.nextStep ?? before.nextStep ?? "Next step",
      type: "next_step",
      dueAt: new Date(patch.nextStepAt),
      createdBy: actor.id ?? null,
    });
  }
  fx.enqueue("lead.score", { leadId });
  fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId });
  return updated!;
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

// ---------------------------------------------------------------------------
// Conversation hooks
// ---------------------------------------------------------------------------

/** A real (non-auto) client message arrived on an existing lead. */
export async function onClientMessage(
  tx: Db,
  fx: Fx,
  lead: Lead,
  at: Date,
  conversationId: string,
  isFirstMessage: boolean,
): Promise<void> {
  await tx
    .update(leads)
    .set({ lastClientReplyAt: isFirstMessage ? lead.lastClientReplyAt : at, lastActivityAt: at, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  if (isFirstMessage || lead.closedAt) return;

  // Reply detection kills the cadence immediately, on any channel (§9.3).
  const { stopEnrollments } = await import("./cadence");
  await stopEnrollments(tx, lead.id, "client_replied");

  let stage = lead.stage;
  if (lead.stage === "attempting" && lead.touchCount > 0) {
    await changeStage(tx, fx, lead.id, "engaged", SYSTEM, { reason: "client replied" });
    stage = "engaged";
  }
  if (["engaged", "qualified", "quoted", "negotiation"].includes(stage)) {
    await startTimer(tx, fx, { leadId: lead.id, kind: "reply", stage: "engaged", startedAt: at, ownerId: lead.ownerId, conversationId, teamId: lead.teamId });
  }
}

/** A human (user in the app, or the rep on the phone app via coexistence echo) messaged the client. */
export async function onHumanOutbound(tx: Db, fx: Fx, leadId: string, at: Date, userId: string | null): Promise<void> {
  const lead = await getLead(tx, leadId);
  const set: Partial<Lead> = { touchCount: lead.touchCount + 1, lastActivityAt: at, updatedAt: new Date() };
  if (!lead.firstResponseAt) {
    set.firstResponseAt = at;
    set.firstResponseBy = userId;
    if (lead.firstInboundAt) {
      const cal = await calendarForTeam(tx, lead.teamId);
      set.firstResponseBusinessMinutes = Math.round(businessMinutesBetween(cal, lead.firstInboundAt, at));
    }
    await logActivity(tx, leadId, "first_response", { type: userId ? "user" : "phone_app", id: userId }, {
      businessMinutes: set.firstResponseBusinessMinutes,
    });
  }
  await tx.update(leads).set(set).where(eq(leads.id, leadId));
  await stopTimers(tx, leadId, ["first_response", "reply"], "met");
  if (lead.stage === "negotiation") {
    // Negotiation SLA is a daily touch: a touch restarts it.
    await stopTimers(tx, leadId, ["stage_exit"], "met", "negotiation");
    await startTimer(tx, fx, { leadId, kind: "stage_exit", stage: "negotiation", startedAt: at, ownerId: lead.ownerId, teamId: lead.teamId });
  }
  fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId });
}

/** System/cadence touches count as attempts but never as a human first response. */
export async function onSystemTouch(tx: Db, leadId: string): Promise<void> {
  await tx.update(leads).set({ touchCount: sql`${leads.touchCount} + 1` }).where(eq(leads.id, leadId));
}

export async function openLeadCounts(db: Db, userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ ownerId: leads.ownerId, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(inArray(leads.ownerId, userIds), isNull(leads.closedAt)))
    .groupBy(leads.ownerId);
  return new Map(rows.map((r) => [r.ownerId!, Number(r.n)]));
}
