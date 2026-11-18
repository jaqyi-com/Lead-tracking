/**
 * One search box across contacts, companies, message bodies and notes (§8.2), Postgres full-text
 * (GIN on tsvector) plus trigram on names. Rep scoping is applied in SQL.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@lead/db";
import { normalisePhone, normaliseEmail } from "@lead/domain";

export type SearchScope = { userId: string; role: string };
export type SearchHit = {
  type: "contact" | "company" | "message" | "note";
  id: string;
  leadId: string | null;
  conversationId: string | null;
  title: string;
  snippet: string;
  at: string;
};

function leadScope(s: SearchScope, alias = "l") {
  if (s.role === "admin" || s.role === "manager") return sql`true`;
  return sql`(${sql.raw(alias)}.owner_id = ${s.userId}::uuid or ${sql.raw(alias)}.owner_id is null)`;
}

export async function search(db: Db, q: string, scope: SearchScope, limit = 30): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const hits: SearchHit[] = [];
  const phone = normalisePhone(term);
  const email = normaliseEmail(term);

  // Exact route match first — the fastest path for "who is +91 98…".
  if (phone || email) {
    const r = await db.execute(sql`
      select c.id, coalesce(c.display_name, ci.value_raw) as title, ci.value_normalised as snippet,
             (select l.id from leads l where l.contact_id = c.id and ${leadScope(scope)} order by l.opened_at desc limit 1) as lead_id,
             c.updated_at as at
      from channel_identities ci join contacts c on c.id = ci.contact_id
      where ci.value_normalised in (${phone?.e164 ?? ""}, ${email ?? ""}, ${phone ? phone.e164.replace("+", "") : ""})
      limit 10`);
    for (const row of r.rows as Record<string, string>[]) {
      hits.push({ type: "contact", id: row.id!, leadId: row.lead_id ?? null, conversationId: null, title: row.title!, snippet: row.snippet!, at: String(row.at) });
    }
  }

  const like = `%${term.replace(/[%_]/g, "")}%`;
  const contactsRes = await db.execute(sql`
    select c.id, coalesce(c.display_name, trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))) as title,
           coalesce(c.job_title, '') || case when co.name is not null then ' · ' || co.name else '' end as snippet,
           (select l.id from leads l where l.contact_id = c.id and ${leadScope(scope)} order by l.opened_at desc limit 1) as lead_id,
           c.updated_at as at
    from contacts c left join companies co on co.id = c.company_id
    where c.merged_into_id is null and c.anonymised_at is null
      and (coalesce(c.display_name,'') || ' ' || coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ilike ${like}
    order by c.updated_at desc limit 10`);
  for (const row of contactsRes.rows as Record<string, string>[]) {
    if (row.lead_id || scope.role !== "rep") {
      hits.push({ type: "contact", id: row.id!, leadId: row.lead_id ?? null, conversationId: null, title: row.title!, snippet: row.snippet!, at: String(row.at) });
    }
  }

  const companiesRes = await db.execute(sql`
    select co.id, co.name as title, coalesce(co.domain, '') || ' ' || coalesce(co.city, '') as snippet,
           (select l.id from leads l where l.company_id = co.id and ${leadScope(scope)} order by l.opened_at desc limit 1) as lead_id,
           co.updated_at as at
    from companies co where co.name ilike ${like} or co.domain ilike ${like}
    order by co.updated_at desc limit 8`);
  for (const row of companiesRes.rows as Record<string, string>[]) {
    hits.push({ type: "company", id: row.id!, leadId: row.lead_id ?? null, conversationId: null, title: row.title!, snippet: row.snippet!, at: String(row.at) });
  }

  if (scope.role !== "viewer") {
    const msgRes = await db.execute(sql`
      select m.id, m.lead_id, m.conversation_id,
             coalesce(c.display_name, 'Message') as title,
             ts_headline('simple', coalesce(m.body, ''), plainto_tsquery('simple', ${term}), 'MaxWords=18, MinWords=6') as snippet,
             m.created_at as at
      from messages m join leads l on l.id = m.lead_id join contacts c on c.id = l.contact_id
      where m.search @@ plainto_tsquery('simple', ${term}) and ${leadScope(scope)}
      order by m.created_at desc limit ${limit}`);
    for (const row of msgRes.rows as Record<string, string>[]) {
      hits.push({ type: "message", id: row.id!, leadId: row.lead_id!, conversationId: row.conversation_id!, title: row.title!, snippet: row.snippet!, at: String(row.at) });
    }
    const noteRes = await db.execute(sql`
      select n.id, n.lead_id, 'Note' as title,
             ts_headline('simple', n.body, plainto_tsquery('simple', ${term}), 'MaxWords=18, MinWords=6') as snippet, n.created_at as at
      from notes n join leads l on l.id = n.lead_id
      where n.search @@ plainto_tsquery('simple', ${term}) and ${leadScope(scope)}
      order by n.created_at desc limit 10`);
    for (const row of noteRes.rows as Record<string, string>[]) {
      hits.push({ type: "note", id: row.id!, leadId: row.lead_id!, conversationId: null, title: row.title!, snippet: row.snippet!, at: String(row.at) });
    }
  }
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.type + h.id) ? false : (seen.add(h.type + h.id), true))).slice(0, limit);
}
