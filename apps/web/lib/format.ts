export const STAGE_LABEL: Record<string, string> = {
  new: "New",
  attempting: "Attempting",
  engaged: "Engaged",
  qualified: "Qualified",
  quoted: "Quoted",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
  nurture: "Nurture",
};

export const STAGE_COLOR: Record<string, string> = {
  new: "bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200",
  attempting: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  engaged: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200",
  qualified: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  quoted: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  negotiation: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200",
  won: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  lost: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
  disqualified: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  nurture: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200",
};

export const SOURCE_LABEL: Record<string, string> = {
  whatsapp_inbound: "WhatsApp",
  email_shared: "Email (shared)",
  email_rep: "Email (rep)",
  website_form: "Website form",
  indiamart: "IndiaMART",
  tradeindia: "TradeIndia",
  justdial: "Justdial",
  linkedin: "LinkedIn",
  referral: "Referral",
  cold_reply: "Outbound reply",
  manual: "Manual",
  import: "Import",
};

export function ago(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const abs = Math.abs(ms);
  const fut = ms < 0;
  const m = Math.round(abs / 60_000);
  const s = m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return s === "now" ? "now" : fut ? `in ${s}` : `${s} ago`;
}

export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function money(v: number | string | null | undefined, currency = "INR"): string {
  if (v == null || v === "") return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(v));
}

export function countdown(ms: number): string {
  if (ms <= 0) return "closed";
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export function initials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function scoreBand(score: number): { label: string; cls: string } {
  if (score >= 60) return { label: "Hot", cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200" };
  if (score >= 30) return { label: "Warm", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" };
  return { label: "Low", cls: "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300" };
}
