/**
 * WhatsApp rules the product must encode (§5.3, §5.4, §5.6).
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowState =
  | { open: true; expiresAt: Date; msRemaining: number }
  | { open: false; expiresAt: Date | null; msRemaining: 0 };

/** §5.3: the 24-hour customer-service window opens/resets on every inbound client message. */
export function windowState(lastInboundAt: Date | null | undefined, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null, msRemaining: 0 };
  const expiresAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  const ms = expiresAt.getTime() - now.getTime();
  return ms > 0 ? { open: true, expiresAt, msRemaining: ms } : { open: false, expiresAt, msRemaining: 0 };
}

export function windowExpiry(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + WINDOW_MS);
}

/** "3h 12m" countdown chip text. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export type CostClass = "service" | "utility" | "marketing" | "authentication";

/** §5.4 India rates as published from Meta's card (effective 1 Oct 2026). INR per delivered message. */
export const DEFAULT_RATES_INR: Record<CostClass, number> = {
  marketing: 0.8631,
  utility: 0.115,
  authentication: 0.115,
  service: 0.115,
};

export function estimateCost(category: CostClass, count: number, rates = DEFAULT_RATES_INR): number {
  return Math.round(rates[category] * count * 100) / 100;
}

/**
 * §5.6 automatic opt-out on keywords (English + common Hindi equivalents, Devanagari and romanised).
 * Matches only when the message is essentially just the keyword, so "don't stop sending me the quote"
 * does not unsubscribe anyone.
 */
const OPT_OUT_KEYWORDS = [
  "stop",
  "stop all",
  "unsubscribe",
  "opt out",
  "optout",
  "cancel",
  "remove me",
  "do not contact",
  "dont message",
  "don't message",
  "band karo",
  "bandh karo",
  "band kar do",
  "mat bhejo",
  "message mat bhejo",
  "बंद करो",
  "बंद करें",
  "बंद",
  "रोकें",
  "रोको",
  "मत भेजो",
  "अनसब्सक्राइब",
];

export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text
    .toLowerCase()
    .replace(/[.!?,;:'"()\-_*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 40) return false;
  return OPT_OUT_KEYWORDS.includes(t);
}

export function isOptInMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t === "start" || t === "subscribe" || t === "unstop";
}

/** §8.4.6: provider failures in plain language. Codes from Meta Cloud API error reference. */
const META_ERRORS: Record<string, string> = {
  "131047": "The 24-hour window is closed — send an approved template instead.",
  "131026": "Message undeliverable — the number may not be on WhatsApp, or the recipient has not accepted the latest terms.",
  "131049": "Meta did not deliver this marketing message to keep engagement healthy. Try again later or use email.",
  "131051": "Unsupported message type.",
  "131052": "Media download failed.",
  "131053": "Media upload failed — check the file type and size.",
  "131056": "Too many messages to this contact in a short time. Wait a moment and retry.",
  "131042": "Payment issue on the WhatsApp Business Account — add or fix the payment method.",
  "131045": "Phone number not registered with the Cloud API.",
  "131048": "Spam rate limit hit — the number's quality is low. Slow down business-initiated messages.",
  "131031": "WhatsApp Business Account is locked or restricted.",
  "131000": "Something went wrong at WhatsApp. Retry in a minute.",
  "132000": "Template variable count doesn't match the approved template.",
  "132001": "Template does not exist in this language, or is not approved yet.",
  "132005": "Template text too long after filling variables.",
  "132007": "Template content violates WhatsApp policy.",
  "132012": "Template variable format is wrong.",
  "132015": "Template is paused due to low quality.",
  "132016": "Template is disabled due to low quality.",
  "130429": "Throughput limit reached. The message will be retried.",
  "131009": "A parameter value is invalid.",
  "133010": "Phone number not registered on WhatsApp.",
  "470": "The 24-hour window is closed — send an approved template instead.",
  "1013": "The recipient is not a WhatsApp user.",
  window_closed: "The 24-hour window is closed — send an approved template instead.",
  no_consent: "This contact has not opted in to business-initiated messages.",
  opted_out: "This contact opted out. Messages are blocked.",
  invalid_email: "The email address bounced and is marked invalid.",
};

export function explainProviderError(code: string | number | null | undefined, fallback?: string | null): string {
  if (code == null) return fallback || "Send failed.";
  return META_ERRORS[String(code)] ?? (fallback ? `${fallback} (code ${code})` : `Send failed (code ${code}).`);
}

/** Retryable Meta errors (throttling / transient). */
export function isRetryableProviderError(code: string | number | null | undefined): boolean {
  return ["130429", "131000", "131056", "1", "2", "4", "80007"].includes(String(code));
}
