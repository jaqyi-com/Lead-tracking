/**
 * §9.1 routing: rules evaluated top-down, first match wins, explicit fallback catches the rest.
 * Pure selection logic; the core service supplies the data and performs the idempotent write.
 */

export type RoutingConditions = {
  sources?: string[];
  sourceDetailContains?: string[];
  sizeBands?: string[];
  keywords?: string[];
  cities?: string[];
  states?: string[];
  languages?: string[];
  channels?: string[];
  minScore?: number;
};

export type RoutingContext = {
  source: string;
  sourceDetail?: string | null;
  sizeBand?: string | null;
  text?: string | null;
  city?: string | null;
  state?: string | null;
  language?: string | null;
  channel?: string | null;
  score?: number;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function matchesConditions(c: RoutingConditions, ctx: RoutingContext): boolean {
  if (c.sources?.length && !c.sources.map(norm).includes(norm(ctx.source))) return false;
  if (c.sourceDetailContains?.length && !c.sourceDetailContains.some((k) => norm(ctx.sourceDetail).includes(norm(k)))) {
    return false;
  }
  if (c.sizeBands?.length && !c.sizeBands.includes(ctx.sizeBand ?? "")) return false;
  if (c.keywords?.length && !c.keywords.some((k) => norm(ctx.text).includes(norm(k)))) return false;
  if (c.cities?.length && !c.cities.map(norm).includes(norm(ctx.city))) return false;
  if (c.states?.length && !c.states.map(norm).includes(norm(ctx.state))) return false;
  if (c.languages?.length && !c.languages.map(norm).includes(norm(ctx.language))) return false;
  if (c.channels?.length && !c.channels.includes(ctx.channel ?? "")) return false;
  if (c.minScore != null && (ctx.score ?? 0) < c.minScore) return false;
  return true;
}

export type Candidate = {
  id: string;
  isAvailable: boolean;
  active: boolean;
  openLeads: number;
  capacity: number;
  inWorkingHours: boolean;
  lastAssignedAt: Date | null;
};

/**
 * Round robin with capacity: next available rep whose open-lead count is under their cap, inside
 * their working hours. "Next" = least recently assigned (stable tie-break on id).
 */
export function pickRoundRobin(candidates: Candidate[]): Candidate | null {
  const eligible = candidates.filter((c) => c.active && c.isAvailable && c.inWorkingHours && c.openLeads < c.capacity);
  if (!eligible.length) return null;
  eligible.sort((a, b) => {
    const ta = a.lastAssignedAt ? a.lastAssignedAt.getTime() : 0;
    const tb = b.lastAssignedAt ? b.lastAssignedAt.getTime() : 0;
    return ta - tb || a.id.localeCompare(b.id);
  });
  return eligible[0]!;
}

/** Very small language detector for routing (Hindi/Gujarati script, romanised Hindi hints). */
export function detectLanguage(text: string | null | undefined): "hi" | "gu" | "en" {
  const t = text ?? "";
  if (/[઀-૿]/.test(t)) return "gu";
  if (/[ऀ-ॿ]/.test(t)) return "hi";
  if (/\b(kya|hai|nahi|kitna|chahiye|bhai|aap|mujhe|karna|kaise)\b/i.test(t)) return "hi";
  return "en";
}
