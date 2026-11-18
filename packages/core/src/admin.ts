/**
 * Admin operations: duplicate merge (§7.3), CSV import, retention (§7.4) and erasure (§11.4,
 * anonymise-in-place so aggregate reports survive).
 */
import { and, eq, inArray, lt, isNotNull, sql } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import {
  activities,
  attachments,
  channelIdentities,
  consentRecords,
  contacts,
  conversations,
  duplicateSuggestions,
  leads,
  messages,
  notes,
  users,
  webhookEvents,
  type Db,
  type Stage,
} from "@lead/db";
import { STAGES, normaliseEmail, normalisePhone, cleanName } from "@lead/domain";
import { withTx, type Fx } from "./effects";
import { DomainError, NotFoundError } from "./errors";
import { resolveContact, type IdentityInput } from "./identity";
import { createLead } from "./leads";
import { getStorage } from "./providers/storage";
import { ORG_ID, audit, logActivity, type Actor } from "./support";

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** One-click merge: reparent identities, leads, conversations, consent; audit the merge. */
export async function mergeContacts(tx: Db, keepId: string, mergeId: string, actor: Actor): Promise<void> {
  if (keepId === mergeId) throw new DomainError("same_contact", "Pick two different contacts");
  const [keep] = await tx.select().from(contacts).where(eq(contacts.id, keepId));
  const [merge] = await tx.select().from(contacts).where(eq(contacts.id, mergeId));
  if (!keep || !merge) throw new NotFoundError("Contact");

  const movedIdentities = await tx.update(channelIdentities).set({ contactId: keepId, isPrimary: false }).where(eq(channelIdentities.contactId, mergeId)).returning({ id: channelIdentities.id });
  const movedLeads = await tx.update(leads).set({ contactId: keepId }).where(eq(leads.contactId, mergeId)).returning({ id: leads.id });
  await tx.update(conversations).set({ contactId: keepId }).where(eq(conversations.contactId, mergeId));
  await tx.update(consentRecords).set({ contactId: keepId }).where(eq(consentRecords.contactId, mergeId));
  await tx
    .update(contacts)
    .set({
      mergedIntoId: keepId,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, mergeId));
  await tx
    .update(contacts)
    .set({
      companyId: keep.companyId ?? merge.companyId,
      jobTitle: keep.jobTitle ?? merge.jobTitle,
      displayName: keep.displayName ?? merge.displayName,
      firstName: keep.firstName ?? merge.firstName,
      lastName: keep.lastName ?? merge.lastName,
      city: keep.city ?? merge.city,
      ownerId: keep.ownerId ?? merge.ownerId,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, keepId));
  await tx
    .update(duplicateSuggestions)
    .set({ status: "merged", resolvedBy: actor.id ?? null, resolvedAt: new Date() })
    .where(
      sql`(${duplicateSuggestions.contactA} = ${keepId} and ${duplicateSuggestions.contactB} = ${mergeId}) or (${duplicateSuggestions.contactA} = ${mergeId} and ${duplicateSuggestions.contactB} = ${keepId})`,
    );
  for (const l of movedLeads) await logActivity(tx, l.id, "contact_merged", actor, { from: mergeId, into: keepId });
  await audit(tx, actor, "contact.merge", "contact", keepId, { merged: merge }, { keep: keepId, identities: movedIdentities.length, leads: movedLeads.length });
}

// ---------------------------------------------------------------------------
// CSV import (§0 assumption 7: today's spreadsheet)
// ---------------------------------------------------------------------------

export type ImportRow = {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  job_title?: string;
  city?: string;
  source?: string;
  stage?: string;
  owner_email?: string;
  value?: string;
  notes?: string;
  next_step?: string;
  next_step_date?: string;
};

export type ImportReport = { total: number; valid: number; errors: { row: number; error: string }[]; created: number; attached: number };

export function parseCsv(text: string): ImportRow[] {
  return parse(text, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")), skip_empty_lines: true, trim: true, bom: true });
}

export async function importLeads(db: Db, rows: ImportRow[], actor: Actor, dryRun: boolean): Promise<ImportReport> {
  const report: ImportReport = { total: rows.length, valid: 0, errors: [], created: 0, attached: 0 };
  const owners = new Map((await db.select({ id: users.id, email: users.email }).from(users)).map((u) => [u.email.toLowerCase(), u.id]));
  for (const [i, row] of rows.entries()) {
    const ids: IdentityInput[] = [];
    const email = normaliseEmail(row.email);
    const phone = normalisePhone(row.phone);
    if (email) ids.push({ kind: "email", value: email, raw: row.email });
    if (phone) ids.push({ kind: "phone", value: phone.e164, raw: row.phone });
    if (!ids.length) {
      report.errors.push({ row: i + 2, error: "needs a valid email or phone" });
      continue;
    }
    const stage = (row.stage?.toLowerCase() ?? "new") as Stage;
    if (!STAGES.includes(stage)) {
      report.errors.push({ row: i + 2, error: `unknown stage "${row.stage}"` });
      continue;
    }
    const ownerId = row.owner_email ? owners.get(row.owner_email.toLowerCase()) : undefined;
    if (row.owner_email && !ownerId) {
      report.errors.push({ row: i + 2, error: `unknown owner ${row.owner_email}` });
      continue;
    }
    report.valid++;
    if (dryRun) continue;
    await withTx(async (tx, fx) => {
      const { contact, company } = await resolveContact(tx, {
        identities: ids,
        name: cleanName(row.name),
        jobTitle: row.job_title,
        companyName: row.company,
        city: row.city,
        source: "import",
      });
      const open = await tx.select({ id: leads.id }).from(leads).where(and(eq(leads.contactId, contact.id), sql`${leads.closedAt} is null`));
      if (open.length) {
        report.attached++;
        if (row.notes) await tx.insert(notes).values({ orgId: ORG_ID, leadId: open[0]!.id, authorId: actor.id ?? null, body: `Imported note: ${row.notes}` });
        return;
      }
      const closed = ["won", "lost", "disqualified", "nurture"].includes(stage);
      const lead = await createLead(tx, fx, {
        contactId: contact.id,
        companyId: company?.id ?? null,
        source: row.source || "import",
        stage,
        ownerId: ownerId ?? null,
        valueEstimate: row.value ? String(Number(row.value.replace(/[^\d.]/g, "")) || "") || null : null,
        actor,
        startTimers: false,
      });
      await tx
        .update(leads)
        .set({
          assignedAt: ownerId ? new Date() : null,
          closedAt: closed ? new Date() : null,
          lostReason: stage === "lost" ? "other" : null,
          nextStep: row.next_step ?? null,
          nextStepAt: row.next_step_date ? new Date(row.next_step_date) : null,
        })
        .where(eq(leads.id, lead.id));
      if (row.notes) await tx.insert(notes).values({ orgId: ORG_ID, leadId: lead.id, authorId: actor.id ?? null, body: row.notes });
      report.created++;
    });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Retention & erasure
// ---------------------------------------------------------------------------

/** Raw webhook payloads: 30 days (§7.4). */
export async function purgeWebhookEvents(db: Db, days = 30): Promise<number> {
  const r = await db
    .delete(webhookEvents)
    .where(and(isNotNull(webhookEvents.processedAt), lt(webhookEvents.receivedAt, new Date(Date.now() - days * 86_400_000))))
    .returning({ id: webhookEvents.id });
  return r.length;
}

/**
 * DPDP erasure: remove contact and message content while preserving the aggregate counts the
 * reports depend on. Consent ledger and audit log are kept (statutory retention).
 */
export async function anonymiseContact(db: Db, contactId: string, actor: Actor): Promise<void> {
  const storageKeys: string[] = [];
  await withTx(async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!c) throw new NotFoundError("Contact");
    const leadIds = (await tx.select({ id: leads.id }).from(leads).where(eq(leads.contactId, contactId))).map((l) => l.id);
    await tx
      .update(contacts)
      .set({ displayName: "Erased contact", firstName: null, lastName: null, jobTitle: null, city: null, state: null, doNotContact: true, anonymisedAt: new Date() })
      .where(eq(contacts.id, contactId));
    await tx
      .update(channelIdentities)
      .set({ valueNormalised: sql`'erased:' || ${channelIdentities.id}::text`, valueRaw: "erased" })
      .where(eq(channelIdentities.contactId, contactId));
    if (leadIds.length) {
      const msgIds = (await tx.select({ id: messages.id }).from(messages).where(inArray(messages.leadId, leadIds))).map((m) => m.id);
      await tx
        .update(messages)
        .set({ body: null, bodyHtml: null, bodyFull: null, subject: null, templateVars: null, emailFrom: null, emailTo: null, emailCc: null, media: [] })
        .where(inArray(messages.leadId, leadIds));
      await tx.update(notes).set({ body: "[erased]" }).where(inArray(notes.leadId, leadIds));
      await tx.update(leads).set({ enquiry: null, qualification: {}, nextStep: null }).where(inArray(leads.id, leadIds));
      await tx.update(conversations).set({ subject: null, lastMessagePreview: null }).where(inArray(conversations.leadId, leadIds));
      await tx.update(activities).set({ payload: sql`${activities.payload} - 'preview' - 'text'` }).where(inArray(activities.leadId, leadIds));
      if (msgIds.length) {
        const atts = await tx.select().from(attachments).where(and(eq(attachments.ownerType, "message"), inArray(attachments.ownerId, msgIds)));
        storageKeys.push(...atts.map((a) => a.storageKey).filter((k): k is string => !!k));
        await tx.delete(attachments).where(and(eq(attachments.ownerType, "message"), inArray(attachments.ownerId, msgIds)));
      }
    }
    await audit(tx, actor, "contact.erase", "contact", contactId, null, { leads: leadIds.length });
  }, db);
  for (const key of storageKeys) await getStorage().delete(key).catch(() => undefined);
}

export async function exportContactData(db: Db, contactId: string) {
  const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!c) throw new NotFoundError("Contact");
  const ids = await db.select().from(channelIdentities).where(eq(channelIdentities.contactId, contactId));
  const ls = await db.select().from(leads).where(eq(leads.contactId, contactId));
  const msgs = ls.length ? await db.select().from(messages).where(inArray(messages.leadId, ls.map((l) => l.id))) : [];
  const consent = await db.select().from(consentRecords).where(eq(consentRecords.contactId, contactId));
  return { contact: c, identities: ids, leads: ls, messages: msgs, consent };
}

export type { Fx };
