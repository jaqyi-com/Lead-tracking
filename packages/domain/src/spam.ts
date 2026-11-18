/**
 * §6.5 spam and vendor mail: classifier v1 (rules + blocklist). Junk goes to a Junk view, never to
 * the pipeline, and a human can always rescue it.
 */

const VENDOR_PATTERNS = [
  /\b(seo services?|rank your website|web design services|guest post|backlinks?|link building)\b/i,
  /\b(we are a (leading|top) (software|it|web|digital) (company|agency))\b/i,
  /\b(outsourc(e|ing) your|offshore development|hire (dedicated )?developers?)\b/i,
  /\b(loan offer|pre-?approved loan|credit card offer|lottery|you have won|bitcoin|crypto investment)\b/i,
  /\b(increase your instagram followers|buy followers)\b/i,
  /\b(unsubscribe from this newsletter|view this email in your browser)\b/i,
];

const SPAM_SENDER = /(newsletter|marketing|promo|offers|deals|noreply|no-reply|notifications?)@/i;

export type SpamVerdict = { junk: boolean; reason?: string };

export function classifySpam(input: {
  fromEmail?: string | null;
  subject?: string | null;
  body?: string | null;
  blocklist?: string[]; // emails or domains
  isPortalSender?: boolean;
}): SpamVerdict {
  if (input.isPortalSender) return { junk: false };
  const from = (input.fromEmail ?? "").toLowerCase();
  const domain = from.split("@")[1] ?? "";
  if (input.blocklist?.some((b) => b.toLowerCase() === from || b.toLowerCase() === domain)) {
    return { junk: true, reason: "Sender is on the blocklist" };
  }
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  for (const re of VENDOR_PATTERNS) if (re.test(text)) return { junk: true, reason: `Vendor/spam pattern: ${re.source.slice(0, 40)}` };
  if (SPAM_SENDER.test(from) && /unsubscribe/i.test(text)) return { junk: true, reason: "Bulk marketing sender" };
  return { junk: false };
}
