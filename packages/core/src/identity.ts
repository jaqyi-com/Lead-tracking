/**
 * §7.3 identity resolution — deterministic and ordered:
 *  1. Exact match on channel_identities(kind, value_normalised) → same contact (the only auto-merge).
 *  2. No match but email domain matches an existing company → new contact attached to that company.
 *  3. No match at all → new contact and, if the domain qualifies, a new company.
 *  4. Never auto-merge on name similarity — raise a duplicate suggestion instead.
 */
import { and, eq, sql, ne } from "drizzle-orm";
import {
  channelIdentities,
  companies,
  contacts,
  duplicateSuggestions,
  freeEmailDomains,
  type Db,
  type IdentityKind,
} from "@lead/db";
import { companyNameFromDomain, emailDomain, splitName, cleanName } from "@lead/domain";
import { ORG_ID, lockKey } from "./support";

export type IdentityInput = { kind: IdentityKind; value: string; raw?: string };

export type ResolveInput = {
  identities: IdentityInput[];
  name?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  source?: string;
};

export type Contact = typeof contacts.$inferSelect;
export type Company = typeof companies.$inferSelect;

let freeDomainCache: Set<string> | undefined;
export async function freeDomains(db: Db): Promise<Set<string>> {
  if (!freeDomainCache) {
    const rows = await db.select().from(freeEmailDomains);
    freeDomainCache = new Set(rows.map((r) => r.domain));
  }
  return freeDomainCache;
}

async function followMerge(tx: Db, contactId: string): Promise<Contact> {
  let id = contactId;
  for (let i = 0; i < 5; i++) {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, id));
    if (!c) throw new Error(`contact ${id} missing`);
    if (!c.mergedIntoId) return c;
    id = c.mergedIntoId;
  }
  throw new Error("merge chain too long");
}

export async function findCompanyForDomain(tx: Db, domain: string): Promise<Company | undefined> {
  const [c] = await tx.select().from(companies).where(and(eq(companies.orgId, ORG_ID), eq(companies.domain, domain)));
  return c;
}

export async function resolveContact(
  tx: Db,
  input: ResolveInput,
): Promise<{ contact: Contact; company: Company | null; created: boolean }> {
  const ids = input.identities.filter((i) => i.value);
  // Serialise concurrent ingestion for the same human (sorted to avoid lock-order deadlocks).
  for (const key of ids.map((i) => `${i.kind}:${i.value}`).sort()) await lockKey(tx, key);

  let contact: Contact | undefined;
  if (ids.length) {
    const matches = await tx
      .select({ contactId: channelIdentities.contactId, kind: channelIdentities.kind, value: channelIdentities.valueNormalised })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.orgId, ORG_ID),
          sql`(${channelIdentities.kind}, ${channelIdentities.valueNormalised}) in (${sql.join(
            ids.map((i) => sql`(${i.kind}, ${i.value})`),
            sql`, `,
          )})`,
        ),
      );
    if (matches.length) {
      // Prefer the strongest route: wa_id > phone > email.
      const order: IdentityKind[] = ["wa_id", "phone", "email"];
      matches.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      contact = await followMerge(tx, matches[0]!.contactId);
      const distinct = new Set(matches.map((m) => m.contactId));
      if (distinct.size > 1) {
        // Two existing contacts claim this human's routes: never auto-merge, suggest instead.
        const [a, b] = [...distinct].sort();
        await tx
          .insert(duplicateSuggestions)
          .values({ orgId: ORG_ID, contactA: a!, contactB: b!, reason: "Same message carried identities of two contacts" })
          .onConflictDoNothing();
      }
    }
  }

  const free = await freeDomains(tx);
  const emailId = ids.find((i) => i.kind === "email");
  const domain =
    input.companyDomain?.toLowerCase() ??
    (emailId && !free.has(emailDomain(emailId.value)) ? emailDomain(emailId.value) : null);

  let company: Company | null = null;

  if (contact) {
    // Attach any new routes to the known contact.
    await addIdentities(tx, contact.id, ids);
    if (contact.companyId) {
      const [c] = await tx.select().from(companies).where(eq(companies.id, contact.companyId));
      company = c ?? null;
    } else if (domain || input.companyName) {
      company = await findOrCreateCompany(tx, domain, input.companyName, input);
      if (company) await tx.update(contacts).set({ companyId: company.id }).where(eq(contacts.id, contact.id));
    }
    // Fill empty fields only; never overwrite what a human typed.
    const patch: Partial<Contact> = {};
    const nm = cleanName(input.name);
    if (nm && !contact.displayName) {
      const { first, last } = splitName(nm);
      Object.assign(patch, { displayName: nm, firstName: contact.firstName ?? first, lastName: contact.lastName ?? last });
    }
    if (input.jobTitle && !contact.jobTitle) patch.jobTitle = input.jobTitle;
    if (input.city && !contact.city) patch.city = input.city;
    if (input.state && !contact.state) patch.state = input.state;
    if (Object.keys(patch).length) {
      await tx.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, contact.id));
      contact = { ...contact, ...patch };
    }
    return { contact, company, created: false };
  }

  company = await findOrCreateCompany(tx, domain, input.companyName, input);
  const nm = cleanName(input.name);
  const { first, last } = splitName(nm);
  const [created] = await tx
    .insert(contacts)
    .values({
      orgId: ORG_ID,
      companyId: company?.id ?? null,
      displayName: nm,
      firstName: first,
      lastName: last,
      jobTitle: input.jobTitle ?? null,
      city: input.city ?? company?.city ?? null,
      state: input.state ?? company?.state ?? null,
      country: input.country ?? null,
    })
    .returning();
  await addIdentities(tx, created!.id, ids, true);
  await suggestDuplicates(tx, created!);
  return { contact: created!, company, created: true };
}

async function findOrCreateCompany(
  tx: Db,
  domain: string | null,
  name: string | null | undefined,
  input: ResolveInput,
): Promise<Company | null> {
  if (domain) {
    const existing = await findCompanyForDomain(tx, domain);
    if (existing) return existing;
    const [c] = await tx
      .insert(companies)
      .values({
        orgId: ORG_ID,
        domain,
        name: cleanName(name) ?? companyNameFromDomain(domain),
        website: domain,
        city: input.city ?? null,
        state: input.state ?? null,
        source: input.source ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return c ?? (await findCompanyForDomain(tx, domain)) ?? null;
  }
  const nm = cleanName(name);
  if (!nm) return null;
  const [byName] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.orgId, ORG_ID), sql`lower(${companies.name}) = lower(${nm})`))
    .limit(1);
  if (byName) return byName;
  const [c] = await tx
    .insert(companies)
    .values({ orgId: ORG_ID, name: nm, city: input.city ?? null, state: input.state ?? null, source: input.source ?? null })
    .returning();
  return c ?? null;
}

export async function addIdentities(tx: Db, contactId: string, ids: IdentityInput[], primary = false): Promise<void> {
  if (!ids.length) return;
  const seenKinds = new Set<string>();
  await tx
    .insert(channelIdentities)
    .values(
      ids.map((i) => {
        const isPrimary = primary && !seenKinds.has(i.kind);
        seenKinds.add(i.kind);
        return {
          orgId: ORG_ID,
          contactId,
          kind: i.kind,
          valueNormalised: i.value,
          valueRaw: i.raw ?? i.value,
          isPrimary,
        };
      }),
    )
    .onConflictDoNothing();
}

async function suggestDuplicates(tx: Db, c: Contact): Promise<void> {
  if (!c.displayName) return;
  const candidates = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, ORG_ID),
        ne(contacts.id, c.id),
        sql`${contacts.mergedIntoId} is null`,
        sql`lower(${contacts.displayName}) = lower(${c.displayName})`,
        c.companyId ? eq(contacts.companyId, c.companyId) : c.city ? sql`lower(${contacts.city}) = lower(${c.city})` : sql`false`,
      ),
    )
    .limit(5);
  for (const other of candidates) {
    const [a, b] = [c.id, other.id].sort();
    await tx
      .insert(duplicateSuggestions)
      .values({ orgId: ORG_ID, contactA: a!, contactB: b!, reason: c.companyId ? "Same name at the same company" : "Same name in the same city" })
      .onConflictDoNothing();
  }
}

export async function identitiesOf(db: Db, contactId: string) {
  return db.select().from(channelIdentities).where(eq(channelIdentities.contactId, contactId));
}

export async function contactRoutes(db: Db, contactId: string) {
  const ids = await identitiesOf(db, contactId);
  const byKind = (k: IdentityKind) => ids.filter((i) => i.kind === k).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const email = byKind("email").find((i) => i.verifiedState !== "invalid") ?? byKind("email")[0];
  return {
    waId: byKind("wa_id")[0]?.valueNormalised ?? null,
    phone: byKind("phone")[0]?.valueNormalised ?? null,
    email: email?.valueNormalised ?? null,
    emailInvalid: !!email && email.verifiedState === "invalid",
    emailVerified: !!email && email.verifiedState === "deliverable",
    all: ids,
  };
}

export async function markEmailInvalid(tx: Db, email: string): Promise<string[]> {
  const rows = await tx
    .update(channelIdentities)
    .set({ verifiedState: "invalid" })
    .where(and(eq(channelIdentities.kind, "email"), eq(channelIdentities.valueNormalised, email)))
    .returning({ contactId: channelIdentities.contactId });
  return rows.map((r) => r.contactId);
}

