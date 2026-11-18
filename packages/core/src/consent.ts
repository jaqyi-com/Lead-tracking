/**
 * Consent ledger (§2 principle 7, §5.6, §11.4). Append-only: every opt-in and opt-out is a new
 * timestamped row with evidence of its source. Current state = latest applicable row.
 *
 * Bases used:
 *  - enquiry         : the person contacted us (WhatsApp inbound, portal enquiry, form) → utility
 *                      messages about *their* enquiry. Never marketing.
 *  - form_opt_in / whatsapp_opt_in / verbal / import / manual → explicit consent (may include marketing)
 *  - keyword_stop / unsubscribe_link / manual → withdrawal
 */
import { and, desc, eq } from "drizzle-orm";
import { consentRecords, enrollments, leads, type Db } from "@lead/db";
import { ORG_ID, type Actor } from "./support";

export type ConsentChannel = "whatsapp" | "email" | "all";
export type ConsentPurpose = "utility" | "marketing" | "all";

export type ConsentStatus = {
  whatsapp: { utility: boolean; marketing: boolean; optedOut: boolean };
  email: { marketing: boolean; unsubscribed: boolean };
  records: (typeof consentRecords.$inferSelect)[];
};

export async function recordConsent(
  tx: Db,
  r: {
    contactId: string;
    channel: ConsentChannel;
    purpose: ConsentPurpose;
    state: "granted" | "withdrawn";
    basis: string;
    evidence?: Record<string, unknown>;
    noticeVersion?: string | null;
    ip?: string | null;
    actor?: Actor;
  },
): Promise<void> {
  await tx.insert(consentRecords).values({
    orgId: ORG_ID,
    contactId: r.contactId,
    channel: r.channel,
    purpose: r.purpose,
    state: r.state,
    basis: r.basis,
    sourceEvidence: r.evidence ?? {},
    noticeVersion: r.noticeVersion ?? null,
    ip: r.ip ?? null,
    capturedBy: r.actor?.id ?? null,
  });
}

export async function consentStatus(db: Db, contactId: string): Promise<ConsentStatus> {
  const records = await db
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.contactId, contactId))
    .orderBy(desc(consentRecords.capturedAt), desc(consentRecords.id));

  const latest = (channel: "whatsapp" | "email", purpose: "utility" | "marketing") =>
    records.find(
      (r) => (r.channel === channel || r.channel === "all") && (r.purpose === purpose || r.purpose === "all"),
    );

  const waUtil = latest("whatsapp", "utility");
  const waMkt = latest("whatsapp", "marketing");
  const emMkt = latest("email", "marketing");
  const waWithdrawAll = records.find((r) => (r.channel === "whatsapp" || r.channel === "all") && r.purpose === "all");

  return {
    whatsapp: {
      utility: waUtil?.state === "granted",
      marketing: waMkt?.state === "granted" && waMkt.basis !== "enquiry",
      optedOut: waWithdrawAll?.state === "withdrawn",
    },
    email: {
      marketing: emMkt?.state === "granted" && emMkt.basis !== "enquiry",
      unsubscribed: emMkt?.state === "withdrawn",
    },
    records,
  };
}

/** Opt-out honoured immediately and permanently across all sequences (§11.3). */
export async function withdrawConsent(
  tx: Db,
  contactId: string,
  channel: ConsentChannel,
  basis: string,
  evidence: Record<string, unknown>,
  actor?: Actor,
): Promise<void> {
  await recordConsent(tx, { contactId, channel, purpose: "all", state: "withdrawn", basis, evidence, actor });
  if (channel === "whatsapp" || channel === "all") {
    // Stop active cadences for this contact's leads; email-only cadence steps re-check consent at send.
    const ls = await tx.select({ id: leads.id }).from(leads).where(eq(leads.contactId, contactId));
    for (const l of ls) {
      await tx
        .update(enrollments)
        .set({ state: "stopped", stopReason: `opt_out_${channel}`, endedAt: new Date() })
        .where(and(eq(enrollments.leadId, l.id), eq(enrollments.state, "active")));
    }
  }
}

/** Utility consent from the enquiry itself — written once per contact+channel. */
export async function ensureEnquiryConsent(
  tx: Db,
  contactId: string,
  channel: "whatsapp" | "email",
  evidence: Record<string, unknown>,
): Promise<void> {
  const status = await consentStatus(tx, contactId);
  if (channel === "whatsapp" && (status.whatsapp.utility || status.whatsapp.optedOut)) return;
  if (channel === "email" && status.records.some((r) => r.channel === "email" && r.basis === "enquiry")) return;
  await recordConsent(tx, { contactId, channel, purpose: "utility", state: "granted", basis: "enquiry", evidence });
}
