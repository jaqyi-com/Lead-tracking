/** §7.2: trim and lower-case. Do not strip dots or +tags (wrong for most providers). */
export function normaliseEmail(raw: string | null | undefined, opts: { gmailDotInsensitive?: boolean } = {}): string | null {
  if (!raw) return null;
  let v = String(raw).trim().toLowerCase();
  const angle = v.match(/<([^>]+)>/);
  if (angle) v = angle[1]!.trim();
  v = v.replace(/^mailto:/, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  if (opts.gmailDotInsensitive) {
    const [local, domain] = v.split("@") as [string, string];
    if (domain === "gmail.com" || domain === "googlemail.com") v = `${local.replace(/\./g, "")}@gmail.com`;
  }
  return v;
}

export function emailDomain(email: string): string {
  return email.split("@")[1] ?? "";
}

/** Parse "Name <a@b.com>, c@d.com" lists into {name, email}. */
export function parseAddressList(raw: string | null | undefined): { name: string | null; email: string }[] {
  if (!raw) return [];
  const out: { name: string | null; email: string }[] = [];
  // Split on commas that are not inside quotes.
  const parts = raw.match(/("[^"]*"|[^,])+/g) ?? [];
  for (const part of parts) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = normaliseEmail(m ? m[2] : part);
    if (!email) continue;
    const name = m && m[1] ? m[1].trim() || null : null;
    out.push({ name, email });
  }
  return out;
}

export function extractEmails(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = normaliseEmail(m[0]);
    if (e) out.add(e);
  }
  return [...out];
}

/** Company domain from an email, or null for free providers (so we don't create "Gmail Pvt Ltd"). */
export function companyDomainFromEmail(email: string, freeDomains: Set<string>): string | null {
  const d = emailDomain(email);
  if (!d || freeDomains.has(d)) return null;
  return d;
}

/** "acme-tech.co.in" → "Acme Tech" — a placeholder until enrichment fills the real name. */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.split(".");
  const secondLevel = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);
  let core = parts[0]!;
  if (parts.length >= 3 && secondLevel.has(parts[parts.length - 2]!)) core = parts[parts.length - 3]!;
  else if (parts.length >= 2) core = parts[parts.length - 2]!;
  return core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** §7.2 Names: keep as given, never auto-correct — only collapse whitespace. */
export function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = String(raw).replace(/\s+/g, " ").trim();
  return v || null;
}

export function splitName(full: string | null): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const parts = full.split(" ");
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}
