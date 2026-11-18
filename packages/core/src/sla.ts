/**
 * §9.5 SLA timers. Clocks run on business hours only. Each target has three events: warning at
 * 50% (notify owner), breach at 100% (owner + managers), hard breach at 200% (auto-reassign).
 * Breaches are recorded as rows, not derived at read time.
 *
 * Durability (plan §3.4): each timer is a row with deadlines; BullMQ delayed jobs fire on time and
 * a once-a-minute sweeper catches anything lost to a Redis restart.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { leads, slaBreaches, slaPolicies, slaTimers, type Db, type Stage } from "@lead/db";
import { dueLevels, slaDeadlines, type SlaLevel } from "@lead/domain";
import { withTx, type Fx } from "./effects";
import { ORG_ID, calendarForTeam, managerIds, notify, logActivity, SYSTEM } from "./support";

export type SlaKind = "assignment" | "first_response" | "reply" | "stage_exit";

const KIND_LABEL: Record<SlaKind, string> = {
  assignment: "assignment",
  first_response: "first response",
  reply: "reply",
  stage_exit: "stage follow-up",
};

export async function startTimer(
  tx: Db,
  fx: Fx,
  t: { leadId: string; kind: SlaKind; stage?: Stage | null; startedAt?: Date; ownerId?: string | null; conversationId?: string | null; teamId?: string | null },
): Promise<void> {
  const policies = await tx
    .select()
    .from(slaPolicies)
    .where(and(eq(slaPolicies.orgId, ORG_ID), eq(slaPolicies.kind, t.kind), eq(slaPolicies.active, true)));
  const policy = policies.find((p) => p.stage === (t.stage ?? null)) ?? (t.kind !== "stage_exit" ? policies[0] : undefined);
  if (!policy) return;

  const running = await tx
    .select({ id: slaTimers.id })
    .from(slaTimers)
    .where(and(eq(slaTimers.leadId, t.leadId), eq(slaTimers.kind, t.kind), eq(slaTimers.state, "running")));
  if (running.length) return;

  const startedAt = t.startedAt ?? new Date();
  const cal = await calendarForTeam(tx, t.teamId);
  const d = slaDeadlines(cal, startedAt, policy.targetMinutes);
  const [timer] = await tx
    .insert(slaTimers)
    .values({
      orgId: ORG_ID,
      leadId: t.leadId,
      conversationId: t.conversationId ?? null,
      policyId: policy.id,
      kind: t.kind,
      stage: t.stage ?? null,
      ownerId: t.ownerId ?? null,
      startedAt,
      targetMinutes: policy.targetMinutes,
      warnAt: d.warnAt,
      breachAt: d.breachAt,
      hardBreachAt: d.hardBreachAt,
    })
    .returning({ id: slaTimers.id });
  for (const [lvl, at] of [
    ["warn", d.warnAt],
    ["breach", d.breachAt],
    ["hard", d.hardBreachAt],
  ] as const) {
    fx.enqueueAt("sla.check", { timerId: timer!.id }, at, `sla-${timer!.id}-${lvl}`);
  }
}

export async function stopTimers(
  tx: Db,
  leadId: string,
  kinds: SlaKind[],
  state: "met" | "cancelled" = "met",
  stage?: Stage,
): Promise<void> {
  await tx
    .update(slaTimers)
    .set({ state, stoppedAt: new Date() })
    .where(
      and(
        eq(slaTimers.leadId, leadId),
        eq(slaTimers.state, "running"),
        inArray(slaTimers.kind, kinds),
        stage ? eq(slaTimers.stage, stage) : sql`true`,
      ),
    );
}

export async function cancelAllTimers(tx: Db, leadId: string): Promise<void> {
  await tx
    .update(slaTimers)
    .set({ state: "cancelled", stoppedAt: new Date() })
    .where(and(eq(slaTimers.leadId, leadId), eq(slaTimers.state, "running")));
}

export async function retargetTimers(tx: Db, leadId: string, ownerId: string): Promise<void> {
  await tx
    .update(slaTimers)
    .set({ ownerId })
    .where(and(eq(slaTimers.leadId, leadId), eq(slaTimers.state, "running")));
}

/** Process a timer: record due levels, notify, escalate. Idempotent (unique timer+level). */
export async function processTimer(timerId: string, now: Date = new Date()): Promise<SlaLevel[]> {
  return withTx(async (tx, fx) => {
    const rows = await tx.execute(sql`select id from los_sla_timers where id = ${timerId} for update`);
    if (!rows.rows.length) return [];
    const [timer] = await tx.select().from(slaTimers).where(eq(slaTimers.id, timerId));
    if (!timer || timer.state !== "running") return [];
    const levels = dueLevels(timer, now);
    if (!levels.length) return [];

    const [lead] = await tx.select().from(leads).where(eq(leads.id, timer.leadId));
    if (!lead || lead.closedAt) {
      await tx.update(slaTimers).set({ state: "cancelled", stoppedAt: now }).where(eq(slaTimers.id, timerId));
      return [];
    }
    const label = KIND_LABEL[timer.kind as SlaKind] ?? timer.kind;
    const leadName = `L-${lead.number}`;

    for (const level of levels) {
      const inserted = await tx
        .insert(slaBreaches)
        .values({ orgId: ORG_ID, timerId, leadId: lead.id, kind: timer.kind, level, ownerId: lead.ownerId })
        .onConflictDoNothing()
        .returning({ id: slaBreaches.id });
      if (!inserted.length) continue;

      if (level === "warning") {
        await tx.update(slaTimers).set({ warnedAt: now }).where(eq(slaTimers.id, timerId));
        await notify(tx, fx, {
          userIds: lead.ownerId ? [lead.ownerId] : await managerIds(tx),
          type: "sla_warning",
          title: `SLA at risk: ${label} on ${leadName}`,
          body: `Half of the ${timer.targetMinutes}-minute target has elapsed.`,
          leadId: lead.id,
        });
      } else if (level === "breach") {
        await tx.update(slaTimers).set({ breachedAt: now }).where(eq(slaTimers.id, timerId));
        await logActivity(tx, lead.id, "sla_breached", SYSTEM, { kind: timer.kind, targetMinutes: timer.targetMinutes });
        await notify(tx, fx, {
          userIds: [lead.ownerId, ...(await managerIds(tx))],
          type: "sla_breach",
          title: `SLA breached: ${label} on ${leadName}`,
          body: `Target was ${timer.targetMinutes} business minutes.`,
          leadId: lead.id,
        });
      } else {
        await tx.update(slaTimers).set({ hardBreachedAt: now }).where(eq(slaTimers.id, timerId));
        await logActivity(tx, lead.id, "sla_hard_breached", SYSTEM, { kind: timer.kind });
        // Escalation: auto-reassign to the next available rep (assignment/first response/reply).
        if (timer.kind !== "stage_exit") {
          const { reassignOnHardBreach } = await import("./routing");
          await reassignOnHardBreach(tx, fx, lead.id);
        }
      }
    }
    fx.publish({ type: "lead.updated", orgId: ORG_ID, leadId: lead.id });
    return levels;
  });
}

/** Sweeper backstop: process every running timer with a level due. */
export async function sweepTimers(now: Date = new Date()): Promise<number> {
  const { getDb } = await import("@lead/db");
  const due = await getDb()
    .select({ id: slaTimers.id })
    .from(slaTimers)
    .where(
      and(
        eq(slaTimers.state, "running"),
        or(
          and(isNull(slaTimers.warnedAt), lte(slaTimers.warnAt, now)),
          and(isNull(slaTimers.breachedAt), lte(slaTimers.breachAt, now)),
          and(isNull(slaTimers.hardBreachedAt), lte(slaTimers.hardBreachAt, now)),
        ),
      ),
    )
    .limit(500);
  for (const t of due) await processTimer(t.id, now);
  return due.length;
}
