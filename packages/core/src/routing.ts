/**
 * §9.1 routing service. Sticky owner first, then rules top-down (first match wins), explicit
 * fallback to the Unassigned queue. Assignment itself is idempotent (leads.assignLead).
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { companies, contacts, routingRules, users, type Db } from "@lead/db";
import { isOpen, matchesConditions, pickRoundRobin, type Candidate, type RoutingContext } from "@lead/domain";
import type { Fx } from "./effects";
import { assignLead, getLead, openLeadCounts } from "./leads";
import { SYSTEM, calendarForUser, logActivity, managerIds, notify } from "./support";

export type RouteResult = { ownerId: string | null; rule: string };

async function candidatesFor(db: Db, teamId: string | null, now: Date, excludeUserId?: string | null): Promise<Candidate[]> {
  const conds = [eq(users.active, true), eq(users.role, "rep")];
  if (teamId) conds.push(eq(users.teamId, teamId));
  if (excludeUserId) conds.push(ne(users.id, excludeUserId));
  let reps = await db.select().from(users).where(and(...conds));
  if (!reps.length && teamId) {
    // A team with no reps falls back to everyone who sells.
    reps = await db.select().from(users).where(and(eq(users.active, true), eq(users.role, "rep")));
  }
  const counts = await openLeadCounts(db, reps.map((r) => r.id));
  const out: Candidate[] = [];
  for (const r of reps) {
    const cal = await calendarForUser(db, r.id);
    out.push({
      id: r.id,
      isAvailable: r.isAvailable,
      active: r.active,
      capacity: r.capacity,
      openLeads: counts.get(r.id) ?? 0,
      inWorkingHours: isOpen(cal, now),
      lastAssignedAt: r.lastAssignedAt,
    });
  }
  return out;
}

export async function chooseOwner(
  tx: Db,
  lead: { contactId: string; companyId: string | null },
  ctx: RoutingContext,
  now: Date = new Date(),
): Promise<RouteResult> {
  // 1. Sticky owner: contact or company already has an owner.
  const [contact] = await tx.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, lead.contactId));
  let sticky = contact?.ownerId ?? null;
  if (!sticky && lead.companyId) {
    const [co] = await tx.select({ ownerId: companies.ownerId }).from(companies).where(eq(companies.id, lead.companyId));
    sticky = co?.ownerId ?? null;
  }
  if (sticky) {
    const [u] = await tx.select().from(users).where(eq(users.id, sticky));
    if (u && u.active && u.isAvailable) return { ownerId: u.id, rule: "sticky_owner" };
  }

  // 2. Rules in priority order.
  const rules = await tx.select().from(routingRules).where(eq(routingRules.active, true)).orderBy(asc(routingRules.priority));
  for (const rule of rules) {
    if (!matchesConditions(rule.conditions, ctx)) continue;
    if (rule.strategy === "unassigned") return { ownerId: null, rule: rule.name };
    if (rule.strategy === "specific_user" && rule.targetUserId) {
      const [u] = await tx.select().from(users).where(eq(users.id, rule.targetUserId));
      if (u && u.active && u.isAvailable) return { ownerId: u.id, rule: rule.name };
    } else {
      const pick = pickRoundRobin(await candidatesFor(tx, rule.targetTeamId, now));
      if (pick) return { ownerId: pick.id, rule: rule.name };
    }
    if (rule.fallback === "unassigned") return { ownerId: null, rule: `${rule.name} (no one available)` };
  }
  return { ownerId: null, rule: "fallback_unassigned" };
}

/** Route and assign. Unassigned leads stay in the Unassigned queue (most visible thing in the inbox). */
export async function routeLead(tx: Db, fx: Fx, leadId: string, ctx: Omit<RoutingContext, "source"> = {}): Promise<RouteResult> {
  const lead = await getLead(tx, leadId);
  if (lead.ownerId || lead.closedAt || lead.isJunk) return { ownerId: lead.ownerId, rule: "already_routed" };
  const [contact] = await tx.select().from(contacts).where(eq(contacts.id, lead.contactId));
  const [company] = lead.companyId ? await tx.select().from(companies).where(eq(companies.id, lead.companyId)) : [];
  const result = await chooseOwner(tx, lead, {
    source: lead.source,
    sourceDetail: lead.sourceDetail,
    sizeBand: company?.sizeBand,
    city: contact?.city ?? company?.city,
    state: contact?.state ?? company?.state,
    language: lead.language,
    score: lead.score,
    text: lead.enquiry,
    ...ctx,
  });
  if (result.ownerId) {
    const assigned = await assignLead(tx, fx, leadId, result.ownerId, SYSTEM, { onlyIfUnassigned: true, reason: `routing: ${result.rule}` });
    if (!assigned) return { ownerId: (await getLead(tx, leadId)).ownerId, rule: "race_lost" };
  } else {
    await logActivity(tx, leadId, "routed_unassigned", SYSTEM, { rule: result.rule });
  }
  return result;
}

/** Hard breach (200%): reassign to the next available rep, or alert managers. */
export async function reassignOnHardBreach(tx: Db, fx: Fx, leadId: string): Promise<void> {
  const lead = await getLead(tx, leadId);
  const pick = pickRoundRobin(await candidatesFor(tx, null, new Date(), lead.ownerId));
  if (pick) {
    await assignLead(tx, fx, leadId, pick.id, SYSTEM, { reason: "SLA hard breach — auto-reassigned" });
    if (lead.ownerId) {
      await notify(tx, fx, {
        userIds: [lead.ownerId],
        type: "lead_reassigned_away",
        title: `L-${lead.number} was reassigned after an SLA hard breach`,
        leadId,
      });
    }
  } else {
    await notify(tx, fx, {
      userIds: await managerIds(tx),
      type: "sla_escalation",
      title: `L-${lead.number}: SLA hard breach and no rep available`,
      leadId,
    });
  }
}
