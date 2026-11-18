/**
 * Consent-gated broadcasts (§5.6, §8.4.5, §12.2). No bulk send without a preview, a recipient
 * count, an estimated cost and a typed confirmation; marketing goes only to valid opt-ins.
 */
import { and, eq, sql } from "drizzle-orm";
import { broadcastRecipients, broadcasts, templates, type Db } from "@lead/db";
import { DEFAULT_RATES_INR, estimateCost, type CostClass } from "@lead/domain";
import { withTx, type Fx } from "./effects";
import { consentStatus } from "./consent";
import { getOrCreateConversation } from "./conversations";
import { contactRoutes } from "./identity";
import { queueMessage } from "./outbound";
import { DomainError, NotFoundError } from "./errors";
import { ORG_ID, audit, type Actor } from "./support";

export type Segment = { stages?: string[]; sources?: string[]; tags?: string[]; createdAfter?: string; createdBefore?: string };

/** Max sends per minute per number to protect quality rating (§11.2). */
export const BROADCAST_PER_MINUTE = 60;

async function segmentContacts(db: Db, seg: Segment): Promise<{ contactId: string; leadId: string }[]> {
  const conds = [sql`l.org_id = ${ORG_ID}`, sql`not l.is_junk`];
  if (seg.stages?.length) conds.push(sql`l.stage in (${sql.join(seg.stages.map((s) => sql`${s}`), sql`, `)})`);
  if (seg.sources?.length) conds.push(sql`l.source in (${sql.join(seg.sources.map((s) => sql`${s}`), sql`, `)})`);
  if (seg.tags?.length) conds.push(sql`l.tags && ${`{${seg.tags.join(",")}}`}::text[]`);
  if (seg.createdAfter) conds.push(sql`l.created_at >= ${seg.createdAfter}::timestamptz`);
  if (seg.createdBefore) conds.push(sql`l.created_at <= ${seg.createdBefore}::timestamptz`);
  const r = await db.execute(sql`
    select distinct on (l.contact_id) l.contact_id, l.id as lead_id
    from los_leads l join los_contacts c on c.id = l.contact_id
    where ${sql.join(conds, sql` and `)} and not c.do_not_contact and c.anonymised_at is null and c.merged_into_id is null
    order by l.contact_id, l.opened_at desc`);
  return (r.rows as { contact_id: string; lead_id: string }[]).map((x) => ({ contactId: x.contact_id, leadId: x.lead_id }));
}

export async function previewBroadcast(db: Db, templateId: string, seg: Segment) {
  const [t] = await db.select().from(templates).where(eq(templates.id, templateId));
  if (!t) throw new NotFoundError("Template");
  const all = await segmentContacts(db, seg);
  let eligible = 0;
  const excluded: Record<string, number> = {};
  for (const c of all) {
    const reason = await exclusionReason(db, c.contactId, t.category);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    else eligible++;
  }
  const category = (t.category === "service" ? "utility" : t.category) as CostClass;
  return {
    template: { id: t.id, name: t.internalName, category: t.category, approvalStatus: t.approvalStatus, body: t.body },
    segmentSize: all.length,
    eligible,
    excluded,
    estimatedCost: estimateCost(category, eligible),
    currency: "INR",
    ratePerMessage: DEFAULT_RATES_INR[category],
    confirmationPhrase: `SEND ${eligible}`,
  };
}

async function exclusionReason(db: Db, contactId: string, category: string): Promise<string | null> {
  const routes = await contactRoutes(db, contactId);
  if (!routes.waId && !routes.phone) return "no_whatsapp";
  const c = await consentStatus(db, contactId);
  if (c.whatsapp.optedOut) return "opted_out";
  if (category === "marketing" && !c.whatsapp.marketing) return "no_marketing_consent";
  if (category !== "marketing" && !c.whatsapp.utility && !c.whatsapp.marketing) return "no_consent";
  return null;
}

export async function createBroadcast(tx: Db, actor: Actor, input: { name: string; templateId: string; segment: Segment }) {
  const p = await previewBroadcast(tx, input.templateId, input.segment);
  if (p.template.approvalStatus !== "approved") throw new DomainError("template_not_approved", "Template is not approved by Meta yet");
  const [b] = await tx
    .insert(broadcasts)
    .values({
      orgId: ORG_ID,
      name: input.name,
      templateId: input.templateId,
      segment: input.segment,
      status: "pending_approval",
      recipientCount: p.eligible,
      excludedCount: p.segmentSize - p.eligible,
      estimatedCost: String(p.estimatedCost),
      createdBy: actor.id ?? null,
    })
    .returning();
  await audit(tx, actor, "broadcast.create", "broadcast", b!.id, null, b);
  return { broadcast: b!, preview: p };
}

/** Manager approval + typed confirmation ("SEND <n>"), then fan-out. */
export async function approveAndSend(tx: Db, fx: Fx, broadcastId: string, actor: Actor, confirmation: string) {
  const [b] = await tx.select().from(broadcasts).where(eq(broadcasts.id, broadcastId));
  if (!b) throw new NotFoundError("Broadcast");
  if (b.status !== "pending_approval") throw new DomainError("bad_state", `Broadcast is ${b.status}`);
  if (confirmation.trim() !== `SEND ${b.recipientCount}`) {
    throw new DomainError("confirmation_mismatch", `Type exactly "SEND ${b.recipientCount}" to confirm.`);
  }
  await tx
    .update(broadcasts)
    .set({ status: "sending", approvedBy: actor.id ?? null, confirmationText: confirmation, startedAt: new Date() })
    .where(eq(broadcasts.id, broadcastId));
  await audit(tx, actor, "broadcast.approve", "broadcast", broadcastId, { status: b.status }, { status: "sending" });
  fx.enqueue("broadcast.fanout", { broadcastId });
}

/** Worker: create recipient rows and queue messages, rate-limited per minute. Consent re-checked per send. */
export async function fanoutBroadcast(db: Db, broadcastId: string): Promise<void> {
  const [b] = await db.select().from(broadcasts).where(eq(broadcasts.id, broadcastId));
  if (!b || b.status !== "sending") return;
  const [t] = await db.select().from(templates).where(eq(templates.id, b.templateId));
  const targets = await segmentContacts(db, b.segment as Segment);
  let i = 0;
  for (const target of targets) {
    await withTx(async (tx, fx) => {
      const existing = await tx
        .select({ id: broadcastRecipients.id })
        .from(broadcastRecipients)
        .where(and(eq(broadcastRecipients.broadcastId, b.id), eq(broadcastRecipients.contactId, target.contactId)));
      if (existing.length) return;
      const reason = await exclusionReason(tx, target.contactId, t!.category);
      if (reason) {
        await tx.insert(broadcastRecipients).values({ broadcastId: b.id, contactId: target.contactId, leadId: target.leadId, status: "skipped", skipReason: reason });
        return;
      }
      const { conversation } = await getOrCreateConversation(tx, { leadId: target.leadId, contactId: target.contactId, channel: "whatsapp" });
      const delayMs = Math.floor(i / BROADCAST_PER_MINUTE) * 60_000;
      const m = await queueMessage(tx, fx, {
        conversationId: conversation.id,
        actor: { type: "system" },
        type: "template",
        templateId: b.templateId,
        broadcastId: b.id,
        isAuto: true,
        bulk: true,
        sendAt: delayMs ? new Date(Date.now() + delayMs) : null,
        idempotencyKey: `bc:${b.id}:${target.contactId}`,
      }).catch((err: Error) => {
        if (err instanceof DomainError) return null;
        throw err;
      });
      await tx.insert(broadcastRecipients).values({
        broadcastId: b.id,
        contactId: target.contactId,
        leadId: target.leadId,
        messageId: m?.id ?? null,
        status: m ? "queued" : "skipped",
        skipReason: m ? null : "send_rejected",
      });
      if (m) i++;
    });
  }
  await db.update(broadcasts).set({ status: "done", finishedAt: new Date() }).where(eq(broadcasts.id, b.id));
}

export async function broadcastResults(db: Db, broadcastId: string) {
  const r = await db.execute(sql`
    select br.status as recipient_status, m.status as message_status, count(*)::int as n
    from los_broadcast_recipients br left join los_messages m on m.id = br.message_id
    where br.broadcast_id = ${broadcastId} group by 1, 2`);
  return r.rows;
}

