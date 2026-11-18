import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export type NormalisedPhone = { e164: string; country: string | undefined; national: string };

/**
 * §7.2: parse with libphonenumber, default region IN. Handles a leading 0, "91" with and without "+",
 * "0091", spaces/dashes/brackets. Rejects anything with fewer than 10 digits.
 */
export function normalisePhone(raw: string | null | undefined, defaultRegion: CountryCode = "IN"): NormalisedPhone | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  let digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  const bare = digits.replace(/\+/g, "");
  if (bare.length < 10) return null;

  const candidates: string[] = [];
  if (digits.startsWith("+")) candidates.push("+" + bare);
  else {
    // National format first ("09876543210" / "9876543210"), then as an international number without "+".
    candidates.push(bare);
    candidates.push("+" + bare);
  }

  for (const c of candidates) {
    const parsed = c.startsWith("+")
      ? parsePhoneNumberFromString(c)
      : parsePhoneNumberFromString(c, defaultRegion);
    if (parsed && parsed.isValid()) {
      return { e164: parsed.number, country: parsed.country, national: parsed.nationalNumber };
    }
  }
  // Possible-but-unvalidated fallback (new number ranges): accept if it is a possible number.
  for (const c of candidates) {
    const parsed = c.startsWith("+") ? parsePhoneNumberFromString(c) : parsePhoneNumberFromString(c, defaultRegion);
    if (parsed && parsed.isPossible() && parsed.nationalNumber.length >= 10) {
      return { e164: parsed.number, country: parsed.country, national: parsed.nationalNumber };
    }
  }
  return null;
}

/** WhatsApp wa_id is digits without "+" (e.g. 919876543210). Convert to E.164 for the phone identity. */
export function waIdToE164(waId: string): string | null {
  const p = normalisePhone("+" + waId.replace(/\D/g, ""));
  return p ? p.e164 : null;
}

/** Find phone-number-like substrings in free text (portal emails, form messages). */
export function extractPhones(text: string, defaultRegion: CountryCode = "IN"): string[] {
  const out = new Set<string>();
  const re = /(?:\+|00)?\d[\d\s\-().]{8,16}\d/g;
  for (const m of text.matchAll(re)) {
    const p = normalisePhone(m[0], defaultRegion);
    if (p) out.add(p.e164);
  }
  return [...out];
}
