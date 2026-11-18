/**
 * Business-hours calendar math (plan §3.5). One implementation used by SLA clocks, cadence quiet
 * hours and the "speed to lead" metric, so all three agree on what a business minute is.
 *
 * Timezone conversion uses Intl only (no tz library). Works across DST for non-IST teams.
 */

export type WeeklyHours = Record<string, [string, string][]>; // "0" = Sunday … "6" = Saturday

export type Calendar = {
  timezone: string;
  weekly: WeeklyHours;
  holidays: Iterable<string>; // "YYYY-MM-DD" local dates
};

type Prepared = { tz: string; weekly: WeeklyHours; holidays: Set<string> };

const MINUTE = 60_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number };

export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(date)) parts[p.type] = p.value;
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  return {
    y,
    m,
    d,
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
    ss: Number(parts.second),
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `tz` → UTC epoch ms. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(result, tz);
  if (second !== result) result = second;
  return result;
}

export function dayKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function localDayKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return dayKey(p.y, p.m, p.d);
}

function prepare(cal: Calendar): Prepared {
  return { tz: cal.timezone, weekly: cal.weekly, holidays: new Set(cal.holidays) };
}

function parseHm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

/** Working intervals [startMs, endMs) for one local calendar day. */
function intervalsForDay(p: Prepared, y: number, m: number, d: number): [number, number][] {
  if (p.holidays.has(dayKey(y, m, d))) return [];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const slots = p.weekly[String(weekday)] ?? [];
  const out: [number, number][] = [];
  for (const [from, to] of slots) {
    const [fh, fm] = parseHm(from);
    const [th, tm] = parseHm(to);
    const s = zonedToUtc(y, m, d, fh, fm, p.tz);
    const e = to === "24:00" ? zonedToUtc(y, m, d + 1, 0, 0, p.tz) : zonedToUtc(y, m, d, th, tm, p.tz);
    if (e > s) out.push([s, e]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function* daysFrom(p: Prepared, startMs: number, maxDays = 400): Generator<[number, number][]> {
  const lp = localParts(new Date(startMs), p.tz);
  // Start one day earlier to catch intervals that began yesterday (overnight slots).
  for (let i = -1; i < maxDays; i++) {
    const dt = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + i));
    yield intervalsForDay(p, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
}

export function isOpen(cal: Calendar, at: Date): boolean {
  const p = prepare(cal);
  const t = at.getTime();
  const lp = localParts(at, p.tz);
  return intervalsForDay(p, lp.y, lp.m, lp.d).some(([s, e]) => t >= s && t < e);
}

/** The next instant at or after `at` that is inside business hours (or null if none within a year). */
export function nextOpen(cal: Calendar, at: Date): Date | null {
  const p = prepare(cal);
  const t = at.getTime();
  for (const day of daysFrom(p, t)) {
    for (const [s, e] of day) {
      if (e > t) return new Date(Math.max(s, t));
    }
  }
  return null;
}

/** Add business minutes to `start`. Clock pauses outside working windows and on holidays. */
export function addBusinessMinutes(cal: Calendar, start: Date, minutes: number): Date {
  if (minutes <= 0) return new Date(start);
  const p = prepare(cal);
  const t = start.getTime();
  let remaining = minutes * MINUTE;
  for (const day of daysFrom(p, t)) {
    for (const [s, e] of day) {
      if (e <= t) continue;
      const from = Math.max(s, t);
      const avail = e - from;
      if (remaining <= avail) return new Date(from + remaining);
      remaining -= avail;
    }
  }
  // Calendar with no working time at all: fall back to wall-clock so timers still fire.
  return new Date(t + minutes * MINUTE);
}

/** Business minutes elapsed between a and b (0 if b <= a). */
export function businessMinutesBetween(cal: Calendar, a: Date, b: Date): number {
  const p = prepare(cal);
  const ta = a.getTime();
  const tb = b.getTime();
  if (tb <= ta) return 0;
  let total = 0;
  for (const day of daysFrom(p, ta)) {
    for (const [s, e] of day) {
      if (s >= tb) return total / MINUTE;
      const from = Math.max(s, ta);
      const to = Math.min(e, tb);
      if (to > from) total += to - from;
    }
  }
  return total / MINUTE;
}

/** §9.3 quiet hours: no sends before 09:00 or after 20:00 in the contact's timezone, none on holidays. */
export function quietHoursCalendar(timezone: string, holidays: Iterable<string>, from = "09:00", to = "20:00"): Calendar {
  const weekly: WeeklyHours = {};
  for (let d = 0; d < 7; d++) weekly[String(d)] = [[from, to]];
  return { timezone, weekly, holidays };
}

/** "Mon–Fri 09:30–18:30, Sat 10:00–14:00 (IST)" for the after-hours acknowledgement. */
export function describeHours(cal: Calendar): string {
  const groups: { days: number[]; label: string }[] = [];
  for (let d = 1; d <= 7; d++) {
    const wd = d % 7;
    const slots = cal.weekly[String(wd)] ?? [];
    if (!slots.length) continue;
    const label = slots.map(([a, b]) => `${a}–${b}`).join(", ");
    const last = groups[groups.length - 1];
    const prevWd = last ? last.days[last.days.length - 1]! : -2;
    if (last && last.label === label && (prevWd + 1) % 7 === wd) last.days.push(wd);
    else groups.push({ days: [wd], label });
  }
  const tzLabel = cal.timezone === "Asia/Kolkata" ? "IST" : cal.timezone;
  return (
    groups
      .map((g) =>
        g.days.length > 1
          ? `${DAY_NAMES[g.days[0]!]}–${DAY_NAMES[g.days[g.days.length - 1]!]} ${g.label}`
          : `${DAY_NAMES[g.days[0]!]} ${g.label}`,
      )
      .join(", ") + ` (${tzLabel})`
  );
}
