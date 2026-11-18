/**
 * §3.1.6 enrichment against Doott's own database and §9.4 scoring.
 * Enrichment fills only empty fields — never overwrites what a human typed.
 */
import { and, asc, eq } from "drizzle-orm";
import { env, logger } from "@lead/config";
import { channelIdentities, companies, contacts, enrichmentResults, leads, messages, type Db } from "@lead/db";
import { scoreLead, textSignals, emailDomain } from "@lead/domain";
import { withTx } from "./effects";
import { contactRoutes, freeDomains } from "./identity";
import { ORG_ID, SYSTEM, logActivity } from "./support";

export type EnrichmentResult = {
  matched: boolean;
  person?: { name?: string; jobTitle?: string; city?: string; state?: string; country?: string };
  company?: { name?: string; domain?: string; industry?: string; sizeBand?: string; city?: string; state?: string; country?: string; website?: string };
  emailStatus?: "deliverable" | "risky" | "invalid" | "unknown";
};

export interface EnrichmentProvider {
  name: string;
  lookup(q: { email?: string | null; phone?: string | null; domain?: string | null; name?: string | null }): Promise<EnrichmentResult>;
}

/**
 * Doott internal enrichment API. Expected contract (implement on the Doott side):
 *   POST {DOOTT_ENRICH_URL}  Authorization: Bearer {DOOTT_ENRICH_API_KEY}
 *   body: { email?, phone?, domain?, name? }
 *   200: { matched, person?: {...}, company?: {...}, email_status? }
 */
class DoottHttpProvider implements EnrichmentProvider {
  name = "doott";
  async lookup(q: { email?: string | null; phone?: string | null; domain?: string | null; name?: string | null }): Promise<EnrichmentResult> {
    const res = await fetch(env.DOOTT_ENRICH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.DOOTT_ENRICH_API_KEY}` },
      body: JSON.stringify(q),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Doott enrichment HTTP ${res.status}`);
    const j = (await res.json()) as EnrichmentResult & { email_status?: EnrichmentResult["emailStatus"] };
    return { ...j, emailStatus: j.emailStatus ?? j.email_status };
  }
}

class NoopProvider implements EnrichmentProvider {
  name = "none";
  async lookup(): Promise<EnrichmentResult> {
    return { matched: false };
  }
}

let provider: EnrichmentProvider | undefined;
export function getEnrichmentProvider(): EnrichmentProvider {
  if (!provider) provider = env.DOOTT_ENRICH_URL ? new DoottHttpProvider() : new NoopProvider();
  return provider;
}
export function setEnrichmentProvider(p: EnrichmentProvider) {
  provider = p;
}

export async function enrichLead(leadId: string): Promise<boolean> {
  const p = getEnrichmentProvider();
  if (p.name === "none") return false;
  const { getDb } = await import("@lead/db");
  const db = getDb();
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return false;
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
  const routes = await contactRoutes(db, lead.contactId);
  const free = await freeDomains(db);
  const domain = routes.email && !free.has(emailDomain(routes.email)) ? emailDomain(routes.email) : null;

  let r: EnrichmentResult;
  try {
    r = await p.lookup({ email: routes.email, phone: routes.phone, domain, name: contact?.displayName });
  } catch (err) {
    logger.warn({ err, leadId }, "enrichment failed");
    return false;
  }

  await withTx(async (tx) => {
    await tx.insert(enrichmentResults).values({
      orgId: ORG_ID,
      contactId: lead.contactId,
      companyId: lead.companyId,
      provider: p.name,
      matched: r.matched,
      data: r as unknown as Record<string, unknown>,
    });
    if (!r.matched) return;
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, lead.contactId));
    if (c && r.person) {
      await tx
        .update(contacts)
        .set({
          jobTitle: c.jobTitle ?? r.person.jobTitle ?? null,
          city: c.city ?? r.person.city ?? null,
          state: c.state ?? r.person.state ?? null,
          country: c.country ?? r.person.country ?? null,
          displayName: c.displayName ?? r.person.name ?? null,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, c.id));
    }
    let companyId = lead.companyId;
    if (r.company) {
      if (!companyId && r.company.domain) {
        const [existing] = await tx.select().from(companies).where(eq(companies.domain, r.company.domain));
        if (existing) companyId = existing.id;
      }
      if (companyId) {
        const [co] = await tx.select().from(companies).where(eq(companies.id, companyId));
        if (co) {
          await tx
            .update(companies)
            .set({
              industry: co.industry ?? r.company.industry ?? null,
              sizeBand: co.sizeBand ?? r.company.sizeBand ?? null,
              city: co.city ?? r.company.city ?? null,
              state: co.state ?? r.company.state ?? null,
              country: co.country ?? r.company.country ?? null,
              website: co.website ?? r.company.website ?? null,
              enrichedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(companies.id, co.id));
        }
      }
      if (companyId && companyId !== lead.companyId) {
        await tx.update(leads).set({ companyId }).where(eq(leads.id, lead.id));
        await tx.update(contacts).set({ companyId }).where(eq(contacts.id, lead.contactId));
      }
    }
    if (r.emailStatus && routes.email) {
      await tx
        .update(channelIdentities)
        .set({ verifiedState: r.emailStatus })
        .where(and(eq(channelIdentities.contactId, lead.contactId), eq(channelIdentities.kind, "email"), eq(channelIdentities.valueNormalised, routes.email)));
    }
    await logActivity(tx, lead.id, "enriched", SYSTEM, { provider: p.name, fields: Object.keys({ ...r.person, ...r.company }) });
  });
  return r.matched;
}

const SERVICEABLE_COUNTRIES = new Set(["IN", "US", "CA", "India", "United States", "Canada"]);

export async function scoreLeadById(db: Db, leadId: string): Promise<number | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
  const [company] = lead.companyId ? await db.select().from(companies).where(eq(companies.id, lead.companyId)) : [];
  const routes = await contactRoutes(db, lead.contactId);
  const free = await freeDomains(db);
  const msgs = await db
    .select({ direction: messages.direction, body: messages.body, at: messages.createdAt, authorType: messages.authorType, isAutoReply: messages.isAutoReply })
    .from(messages)
    .where(eq(messages.leadId, leadId))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const inboundText = msgs.filter((m) => m.direction === "inbound").map((m) => m.body ?? "").join("\n") + "\n" + (lead.enquiry ?? "");
  const sig = textSignals(inboundText);
  const firstTouch = msgs.find((m) => m.direction === "outbound");
  const replyAfter = firstTouch ? msgs.find((m) => m.direction === "inbound" && !m.isAutoReply && m.at > firstTouch.at) : undefined;
  const repliedFast = !!(firstTouch && replyAfter && replyAfter.at.getTime() - firstTouch.at.getTime() <= 3600_000);
  const anyReplyAfterTouch = !!replyAfter;

  const res = scoreLead({
    companySizeBand: company?.sizeBand,
    jobTitle: contact?.jobTitle,
    qualification: lead.qualification,
    hasBusinessEmailDomain: !!routes.email && !free.has(emailDomain(routes.email)),
    hasCompany: !!company,
    emailVerified: routes.emailVerified,
    repliedWithinHourOfFirstTouch: repliedFast,
    askedPricingOrTrial: sig.askedPricingOrTrial,
    requestedSample: sig.requestedSample,
    isReferral: lead.source === "referral",
    outsideServiceableGeo: !!(contact?.country && !SERVICEABLE_COUNTRIES.has(contact.country)),
    noReplyAfterThreeTouches: lead.touchCount >= 3 && !anyReplyAfterTouch,
    competitorOrStudent: sig.studentOrResearch || lead.tags.includes("competitor"),
  });
  await db.update(leads).set({ score: res.score, scoreBreakdown: res.breakdown }).where(eq(leads.id, leadId));
  return res.score;
}
