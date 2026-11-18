import { addBusinessMinutes, type Calendar } from "./business-hours";

/**
 * §9.5: warning at 50% elapsed, breach at 100%, hard breach at 200% (auto-reassign).
 * All on business hours.
 */
export function slaDeadlines(cal: Calendar, startedAt: Date, targetMinutes: number) {
  return {
    warnAt: addBusinessMinutes(cal, startedAt, targetMinutes * 0.5),
    breachAt: addBusinessMinutes(cal, startedAt, targetMinutes),
    hardBreachAt: addBusinessMinutes(cal, startedAt, targetMinutes * 2),
  };
}

export type SlaLevel = "warning" | "breach" | "hard_breach";

export function dueLevels(
  timer: { warnAt: Date; breachAt: Date; hardBreachAt: Date; warnedAt: Date | null; breachedAt: Date | null; hardBreachedAt: Date | null },
  now: Date,
): SlaLevel[] {
  const out: SlaLevel[] = [];
  if (!timer.warnedAt && now >= timer.warnAt) out.push("warning");
  if (!timer.breachedAt && now >= timer.breachAt) out.push("breach");
  if (!timer.hardBreachedAt && now >= timer.hardBreachAt) out.push("hard_breach");
  return out;
}

/** Median and p90 — §10: report median and p90, never the mean. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
