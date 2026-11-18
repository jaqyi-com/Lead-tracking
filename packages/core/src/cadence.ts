/**
 * §9.3 follow-up cadence engine. Enrollment starts when a lead reaches Attempting and stops the
 * moment the client replies, the stage advances past Engaged, or the lead is closed. Every skipped,
 * substituted, deferred or suppressed step is logged on the lead.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import {
  contacts,
  conversations,
  enrollmentEvents,
  enrollments,
  leads,
  sequenceSteps,
  sequences,
  tasks,
  users,
  type Db,
} from "@lead/db";
import {
  addBusinessMinutes,
  contextVars,
  decideStep,
  localDayKey,
  quietHoursCalendar,
  renderSnippet,
  type CadenceDecision,
} from "@lead/domain";
import { withTx, type Fx } from "./effects";
import { consentStatus } from "./consent";
import { getOrCreateConversation } from "./conversations";
import { contactRoutes } from "./identity";
import { changeStage } from "./leads";
import { queueMessage } from "./outbound";
import { templateByInternalName, varContextForLead } from "./templates";
import { DomainError } from "./errors";
import { ORG_ID, SYSTEM, calendarForTeam, logActivity, orgHolidays } from "./support";

type Step = typeof sequenceSteps.$inferSelect;
type Enrollment = typeof enrollments.$inferSelect;

async function stepsOf(db: Db, sequenceId: string): Promise<Step[]> {
  return db.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId)).orderBy(asc(sequenceSteps.position));
}

async function runAtFor(db: Db, enr: Pick<Enrollment, "startedAt" | "leadId">, step: Step): Promise<Date> {
  if (step.offsetBusiness) {
    const [lead] = await db.select({ teamId: leads.teamId }).from(leads).where(eq(leads.id, enr.leadId));
    return addBusinessMinutes(await calendarForTeam(db, lead?.teamId), enr.startedAt, step.offsetMinutes);
  }
  return new Date(enr.startedAt.getTime() + step.offsetMinutes * 60_000);
}

export async function enrollDefault(tx: Db, fx: Fx, leadId: string): Promise<Enrollment | null> {
  const active = await tx
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.leadId, leadId), eq(enrollments.state, "active")));
  if (active.length) return null;
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!lead || lead.closedAt || lead.isJunk) return null;

  const seqs = await tx.select().from(sequences).where(and(eq(sequences.active, true), eq(sequences.orgId, ORG_ID)));
  const seq =
    seqs.find((s) => !s.isDefault && (s.entryCondition.sources ?? []).includes(lead.source)) ?? seqs.find((s) => s.isDefault);
  if (!seq) return null;
  const steps = await stepsOf(tx, seq.id);
  if (!steps.length) return null;

  const startedAt = new Date();
  const first = steps[0]!;
  const nextRunAt = await runAtFor(tx, { startedAt, leadId }, first);
  const [enr] = await tx
    .insert(enrollments)
    .values({ orgId: ORG_ID, leadId, sequenceId: seq.id, currentStep: first.position, startedAt, nextRunAt })
    .onConflictDoNothing()
    .returning();
  if (!enr) return null;
  await logActivity(tx, leadId, "sequence_enrolled", SYSTEM, { sequence: seq.name, enrollmentId: enr.id });
  fx.enqueueAt("cadence.run", { enrollmentId: enr.id }, nextRunAt, `cad-${enr.id}-${first.position}`);
  return enr;
}

export async function stopEnrollments(tx: Db, leadId: string, reason: string): Promise<void> {
  const stopped = await tx
    .update(enrollments)
    .set({ state: "stopped", stopReason: reason, endedAt: new Date() })
    .where(and(eq(enrollments.leadId, leadId), eq(enrollments.state, "active")))
    .returning({ id: enrollments.id, currentStep: enrollments.currentStep });
  for (const e of stopped) {
    await tx.insert(enrollmentEvents).values({ enrollmentId: e.id, leadId, stepPosition: e.currentStep, outcome: "stopped", detail: { reason } });
    await logActivity(tx, leadId, "sequence_stopped", SYSTEM, { reason });
  }
}

/** Execute the due step of an enrollment. Safe to call repeatedly (checks next_run_at and state). */
export async function runEnrollment(enrollmentId: string, now: Date = new Date()): Promise<string> {
  return withTx(async (tx, fx) => {
    await tx.execute(sql`select id from los_enrollments where id = ${enrollmentId} for update`);
    const [enr] = await tx.select().from(enrollments).where(eq(enrollments.id, enrollmentId));
    if (!enr || enr.state !== "active") return "inactive";
    if (enr.nextRunAt && enr.nextRunAt.getTime() > now.getTime() + 1000) return "not_due";

    const [lead] = await tx.select().from(leads).where(eq(leads.id, enr.leadId));
    if (!lead || lead.closedAt) {
      await stopEnrollments(tx, enr.leadId, "lead_closed");
      return "stopped";
    }
    const steps = await stepsOf(tx, enr.sequenceId);
    const step = steps.find((s) => s.position === enr.currentStep);
    if (!step) {
      await tx.update(enrollments).set({ state: "completed", endedAt: now }).where(eq(enrollments.id, enr.id));
      return "completed";
    }

    const [contact] = await tx.select().from(contacts).where(eq(contacts.id, lead.contactId));
    const routes = await contactRoutes(tx, lead.contactId);
    const consent = await consentStatus(tx, lead.contactId);
    const convs = await tx.select().from(conversations).where(eq(conversations.leadId, lead.id));
    const waConv = convs.find((c) => c.channel === "whatsapp");
    const enquiryChannel: "whatsapp" | "email" = lead.source === "whatsapp_inbound" || (waConv && !convs.some((c) => c.channel === "email")) ? "whatsapp" : "email";
    const tpl = step.templateInternalName ? await templateByInternalName(tx, step.templateInternalName) : undefined;

    const decision = decideStep(
      {
        position: step.position,
        action: step.action,
        channel: step.channel,
        templateInternalName: step.templateInternalName,
        waBody: step.waBody,
        emailSubject: step.emailSubject,
        emailBody: step.emailBody,
        requiresHuman: step.requiresHuman,
      },
      {
        now,
        enquiryChannel,
        quietHours: quietHoursCalendar(contact?.timezone ?? "Asia/Kolkata", await orgHolidays(tx)),
        lastInboundWhatsAppAt: waConv?.lastInboundAt ?? null,
        hasWhatsApp: !!(routes.waId || routes.phone),
        hasEmail: !!routes.email,
        emailInvalid: routes.emailInvalid,
        templateApproved: tpl?.approvalStatus === "approved",
        templateCategory: (tpl?.category as "utility" | "marketing" | undefined) ?? null,
        waConsent: { utility: consent.whatsapp.utility, marketing: consent.whatsapp.marketing },
        emailConsent: !consent.email.unsubscribed,
        optedOut: consent.whatsapp.optedOut && !routes.email,
        lastSendDay: enr.lastSendDay,
      },
    );

    const outcome = await execute(tx, fx, enr, lead, step, decision, now, contact?.timezone ?? "Asia/Kolkata");
    return outcome;
  });
}

async function execute(
  tx: Db,
  fx: Fx,
  enr: Enrollment,
  lead: typeof leads.$inferSelect,
  step: Step,
  d: CadenceDecision,
  now: Date,
  tz: string,
): Promise<string> {
  const log = async (outcome: string, detail: Record<string, unknown>, messageId?: string) => {
    await tx.insert(enrollmentEvents).values({ enrollmentId: enr.id, leadId: lead.id, stepPosition: step.position, outcome, detail, messageId: messageId ?? null });
    await logActivity(tx, lead.id, `cadence_${outcome}`, SYSTEM, { step: step.position, ...detail });
  };

  if (d.kind === "defer") {
    await tx.update(enrollments).set({ nextRunAt: d.until }).where(eq(enrollments.id, enr.id));
    await log("deferred", { reason: d.reason, until: d.until.toISOString() });
    fx.enqueueAt("cadence.run", { enrollmentId: enr.id }, d.until, `cad-${enr.id}-${step.position}-${d.until.getTime()}`);
    return "deferred";
  }

  let sentChannel = false;
  try {
    if (d.kind === "suppress") {
      await log("suppressed", { reason: d.reason });
    } else if (d.kind === "create_task") {
      await tx.insert(tasks).values({
        orgId: ORG_ID,
        leadId: lead.id,
        assigneeId: lead.ownerId,
        title: step.taskTitle ?? "Follow up",
        type: "cadence",
        dueAt: now,
      });
      await log("task_created", { title: step.taskTitle });
    } else if (d.kind === "move_to_nurture") {
      const revisitAt = new Date(now.getTime() + (step.revisitDays ?? 60) * 86_400_000);
      await changeStage(tx, fx, lead.id, "nurture", SYSTEM, { revisitAt, reason: "Cadence completed with no reply" });
      await log("moved_to_nurture", { revisitAt: revisitAt.toISOString() });
      await tx.update(enrollments).set({ state: "completed", endedAt: now }).where(eq(enrollments.id, enr.id));
      return "completed";
    } else {
      const ctx = await varContextForLead(tx, lead.id);
      const vars = contextVars(ctx);
      const channel = d.kind === "send_email" ? "email" : "whatsapp";
      const { conversation } = await getOrCreateConversation(tx, {
        leadId: lead.id,
        contactId: lead.contactId,
        channel,
        assignedTo: lead.ownerId,
      });
      let msgId: string;
      if (d.kind === "send_wa_template") {
        const tpl = await templateByInternalName(tx, d.templateInternalName, lead.language ?? "en");
        const m = await queueMessage(tx, fx, {
          conversationId: conversation.id,
          actor: SYSTEM,
          type: "template",
          templateId: tpl!.id,
          isAuto: true,
          sequenceEnrollmentId: enr.id,
          idempotencyKey: `cad:${enr.id}:${step.position}`,
        });
        msgId = m.id;
      } else if (d.kind === "send_wa_text") {
        const m = await queueMessage(tx, fx, {
          conversationId: conversation.id,
          actor: SYSTEM,
          type: "text",
          body: renderSnippet(d.body, vars),
          isAuto: true,
          sequenceEnrollmentId: enr.id,
          idempotencyKey: `cad:${enr.id}:${step.position}`,
        });
        msgId = m.id;
      } else {
        const [owner] = lead.ownerId ? await tx.select().from(users).where(eq(users.id, lead.ownerId)) : [];
        const m = await queueMessage(tx, fx, {
          conversationId: conversation.id,
          actor: SYSTEM,
          type: "email",
          subject: renderSnippet(d.subject, vars),
          body: renderSnippet(d.body, { ...vars, owner: owner?.name ?? vars.owner }),
          isAuto: true,
          bulk: true,
          sequenceEnrollmentId: enr.id,
          idempotencyKey: `cad:${enr.id}:${step.position}`,
        });
        msgId = m.id;
      }
      await log(d.substituted ? "substituted" : "sent", { kind: d.kind, reason: d.reason }, msgId);
      sentChannel = true;
    }
  } catch (err) {
    if (!(err instanceof DomainError)) throw err;
    await log("suppressed", { reason: err.message, code: err.code });
  }

  // Advance to the next step.
  const steps = await stepsOf(tx, enr.sequenceId);
  const next = steps.find((s) => s.position > step.position);
  const lastSendDay = sentChannel ? localDayKey(now, tz) : enr.lastSendDay;
  if (!next) {
    await tx.update(enrollments).set({ state: "completed", endedAt: now, lastSendDay }).where(eq(enrollments.id, enr.id));
    return "completed";
  }
  let runAt = await runAtFor(tx, enr, next);
  if (runAt < now) runAt = now;
  await tx.update(enrollments).set({ currentStep: next.position, nextRunAt: runAt, lastSendDay }).where(eq(enrollments.id, enr.id));
  fx.enqueueAt("cadence.run", { enrollmentId: enr.id }, runAt, `cad-${enr.id}-${next.position}`);
  return d.kind;
}

/** Sweeper backstop for lost delayed jobs. */
export async function sweepEnrollments(now: Date = new Date()): Promise<number> {
  const { getDb } = await import("@lead/db");
  const due = await getDb()
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.state, "active"), sql`${enrollments.nextRunAt} <= ${now}`))
    .limit(200);
  for (const e of due) await runEnrollment(e.id, now);
  return due.length;
}
