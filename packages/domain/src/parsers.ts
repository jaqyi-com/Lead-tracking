/**
 * §6.2 portal & marketplace lead parser registry.
 * Match on sender address or subject pattern, then extract fields with per-source rules.
 * A parser failure must degrade gracefully: the caller creates the lead anyway with the raw body
 * attached and parse_failed = true.
 *
 * Portal layouts change without notice. Every parser is fixture-tested (fixtures/portal/*), and when
 * a real email breaks one, the anonymised email is added as a fixture before the fix.
 */
import { extractPhones } from "./phone";
import { extractEmails, normaliseEmail } from "./email";
import { htmlToText } from "./email-text";

export type PortalEmail = { from: string; subject: string; text?: string | null; html?: string | null; replyTo?: string | null };

export type ParsedPortalLead = {
  source: string;
  sourceDetail?: string;
  portalLeadId?: string;
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  city?: string;
  state?: string;
  product?: string;
  quantity?: string;
  message?: string;
};

export type ParseOutcome =
  | { matched: false }
  | { matched: true; ok: true; parser: string; lead: ParsedPortalLead }
  | { matched: true; ok: false; parser: string; reason: string; partial: ParsedPortalLead };

type Parser = {
  name: string;
  source: string;
  match: (e: PortalEmail) => boolean;
  parse: (e: PortalEmail, text: string) => ParsedPortalLead;
  /** Minimum fields needed for a usable lead. */
  required?: (keyof ParsedPortalLead)[];
};

/** Read "Label: value" / "Label - value" lines into a lowercase-keyed map. */
export function labelledFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/ /g, " ").trim();
    const m = line.match(/^\*?\s*([A-Za-z][A-Za-z /&().'-]{1,40}?)\s*\*?\s*[:\-–]\s+(.+)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    const value = m[2]!.trim();
    if (key && value && !(key in out)) out[key] = value;
  }
  return out;
}

function pick(fields: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (fields[k]) return fields[k];
  }
  for (const k of keys) {
    const hit = Object.keys(fields).find((f) => f.includes(k));
    if (hit) return fields[hit];
  }
  return undefined;
}

function cityState(v: string | undefined): { city?: string; state?: string } {
  if (!v) return {};
  const [city, state] = v.split(",").map((x) => x.trim());
  return { city: city || undefined, state: state || undefined };
}

function common(text: string, e: PortalEmail): ParsedPortalLead & { source: string } {
  const f = labelledFields(text);
  const phone = extractPhones(pick(f, "mobile", "phone", "contact number", "mobile number", "contact") ?? "")[0] ?? extractPhones(text)[0];
  const emailField = normaliseEmail(pick(f, "email", "email id", "e mail") ?? "");
  const email =
    emailField ??
    extractEmails(text).find((x) => !/(indiamart|tradeindia|justdial|linkedin|noreply|no-reply)/.test(x)) ??
    (e.replyTo ? (normaliseEmail(e.replyTo) ?? undefined) : undefined);
  const loc = cityState(pick(f, "city", "location", "address", "city state"));
  return {
    source: "",
    name: pick(f, "name", "buyer name", "contact person", "full name", "customer name", "sender"),
    phone,
    email: email ?? undefined,
    company: pick(f, "company", "company name", "organization", "organisation", "firm"),
    city: loc.city,
    state: pick(f, "state") ?? loc.state,
    product: pick(f, "product", "product name", "requirement", "looking for", "enquiry for", "service"),
    quantity: pick(f, "quantity", "qty", "order value", "approx order value"),
    message: pick(f, "message", "requirement details", "description", "details", "comments", "enquiry"),
  };
}

const PARSERS: Parser[] = [
  {
    name: "indiamart",
    source: "indiamart",
    match: (e) => /indiamart\.com/i.test(e.from) || /indiamart/i.test(e.subject),
    parse: (e, text) => {
      const c = common(text, e);
      const id = text.match(/(?:Enquiry|Query|Lead|BuyLead)\s*(?:ID|No\.?|#)\s*[:\-]?\s*([A-Z0-9-]{5,})/i)?.[1];
      const subjProduct = e.subject.match(/(?:enquiry|requirement|buylead)\s+for\s+(.+?)(?:\s+from\s+|$)/i)?.[1];
      const subjName = e.subject.match(/\bfrom\s+(.+?)\s*(?:,|$)/i)?.[1];
      return {
        ...c,
        source: "indiamart",
        portalLeadId: id,
        product: c.product ?? subjProduct,
        name: c.name ?? subjName,
        sourceDetail: c.product ?? subjProduct,
      };
    },
    required: ["name"],
  },
  {
    name: "tradeindia",
    source: "tradeindia",
    match: (e) => /tradeindia\.com/i.test(e.from) || /tradeindia/i.test(e.subject),
    parse: (e, text) => {
      const c = common(text, e);
      const id = text.match(/(?:Inquiry|Enquiry)\s*(?:ID|No\.?)\s*[:\-]?\s*([A-Z0-9-]{4,})/i)?.[1];
      return { ...c, source: "tradeindia", portalLeadId: id, sourceDetail: c.product };
    },
    required: ["name"],
  },
  {
    name: "justdial",
    source: "justdial",
    match: (e) => /justdial\.com/i.test(e.from) || /justdial/i.test(e.subject),
    parse: (e, text) => {
      const c = common(text, e);
      const id = text.match(/(?:Lead|Enquiry)\s*(?:ID|No\.?)\s*[:\-]?\s*([A-Z0-9-]{4,})/i)?.[1];
      const caller = text.match(/(?:caller|user)\s+(?:name)?\s*[:\-]\s*(.+)/i)?.[1]?.trim();
      return { ...c, name: c.name ?? caller, source: "justdial", portalLeadId: id, sourceDetail: c.product };
    },
    required: ["phone"],
  },
  {
    name: "linkedin",
    source: "linkedin",
    match: (e) => /linkedin\.com/i.test(e.from) && /(lead|form|message|inmail)/i.test(e.subject),
    parse: (e, text) => {
      const c = common(text, e);
      const f = labelledFields(text);
      return {
        ...c,
        source: "linkedin",
        name: c.name ?? (f["first name"] ? `${f["first name"]} ${f["last name"] ?? ""}`.trim() : undefined),
        company: c.company ?? f["company name"],
        sourceDetail: f["form name"] ?? f["campaign"] ?? e.subject,
      };
    },
    required: ["name"],
  },
  {
    name: "website_form",
    source: "website_form",
    match: (e) => /^(website|wordpress|wpforms|contact form|form submission|new submission|new enquiry from website)/i.test(e.subject) ||
      /(wordpress@|forms@|webform@|no-reply@.*(wpforms|hubspot|typeform|jotform))/i.test(e.from),
    parse: (e, text) => ({ ...common(text, e), source: "website_form", sourceDetail: e.subject }),
    required: [],
  },
];

export function parserNames(): string[] {
  return PARSERS.map((p) => p.name);
}

export function parsePortalEmail(e: PortalEmail): ParseOutcome {
  const parser = PARSERS.find((p) => p.match(e));
  if (!parser) return { matched: false };
  const text = (e.text && e.text.trim()) || htmlToText(e.html) || "";
  let lead: ParsedPortalLead;
  try {
    lead = parser.parse(e, text);
  } catch (err) {
    return { matched: true, ok: false, parser: parser.name, reason: `parser threw: ${(err as Error).message}`, partial: { source: parser.source } };
  }
  const missingContact = !lead.phone && !lead.email;
  const missingRequired = (parser.required ?? []).filter((k) => !lead[k]);
  if (missingContact || missingRequired.length) {
    const reasons = [...(missingContact ? ["no phone or email found"] : []), ...missingRequired.map((k) => `missing ${k}`)];
    return { matched: true, ok: false, parser: parser.name, reason: reasons.join(", "), partial: lead };
  }
  return { matched: true, ok: true, parser: parser.name, lead };
}

export function isPortalSender(from: string, subject = ""): boolean {
  return PARSERS.some((p) => p.name !== "website_form" && p.match({ from, subject }));
}
