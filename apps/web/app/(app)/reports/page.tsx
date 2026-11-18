"use client";
/** §10 — four dashboards: Today, Funnel, Team performance, Channel & cost. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { money, SOURCE_LABEL } from "@/lib/format";
import { Stat } from "@/components/ui";

const TABS = ["Today", "Funnel", "Team", "Channel & cost"] as const;

function useRange(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
}

const num = (v: unknown, digits = 0) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: digits }));

export default function ReportsPage() {
  const me = useMe();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Today");
  const [days, setDays] = useState(30);
  const range = useRange(days);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-4 text-xl font-semibold">Reports</h1>
          {TABS.filter((t) => t !== "Channel & cost" || me.data?.role !== "rep").map((t) => (
            <button key={t} className={tab === t ? "btn-primary" : "btn"} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
          {tab !== "Today" && (
            <select className="input ml-auto h-8 w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 12 months</option>
            </select>
          )}
        </div>
        {tab === "Today" && <Today />}
        {tab === "Funnel" && <Funnel range={range} />}
        {tab === "Team" && <Team range={range} />}
        {tab === "Channel & cost" && <Cost range={range} />}
      </div>
    </div>
  );
}

function Today() {
  const q = useQuery({ queryKey: ["report-today"], queryFn: () => api<Record<string, any>>("/api/reports/today"), refetchInterval: 30_000 });
  const speed = useQuery({ queryKey: ["report-speed", 7], queryFn: () => api<Record<string, any>>(`/api/reports/speed?from=${new Date(Date.now() - 7 * 86_400_000).toISOString()}`) });
  const d = q.data;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  const used = (d.serviceUsage as { service_count: number }[]).reduce((s, r) => s + r.service_count, 0);
  const s = speed.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Unassigned" value={d.unassigned} tone={d.unassigned ? "bad" : "good"} hint="Target: 0 for more than 2 min" />
        <Stat label="Awaiting our reply" value={d.awaiting_reply} tone={d.awaiting_reply > 10 ? "warn" : undefined} />
        <Stat label="SLA at risk / breached" value={`${d.sla_at_risk} / ${d.sla_breached}`} tone={d.sla_breached ? "bad" : d.sla_at_risk ? "warn" : "good"} />
        <Stat label="Unanswered 24h" value={d.unanswered_24h} tone={d.unanswered_24h ? "bad" : "good"} hint="Should be zero, daily" />
        <Stat label="Leads today" value={d.leads_today} />
        <Stat label="Messages in / out today" value={`${d.received_today} / ${d.sent_today}`} />
        <Stat label="Failed sends (24h)" value={d.failed_24h} tone={d.failed_24h ? "warn" : undefined} />
        <Stat label="Queue" value={`${d.outbound_queue} out · ${d.unprocessed_events} in`} hint={d.failed_events ? `${d.failed_events} failing webhook events` : "Healthy"} tone={d.failed_events ? "bad" : undefined} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="card p-4 md:col-span-2">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Speed to lead · last 7 days (business minutes)</div>
          <div className="mt-2 grid grid-cols-3 gap-4">
            <div>
              <div className={clsx("text-3xl font-semibold tabular-nums", s?.median != null && s.median > 5 ? "text-red-600" : "text-emerald-600")}>{num(s?.median, 1)}</div>
              <div className="text-xs text-slate-500">median (target &lt; 5)</div>
            </div>
            <div>
              <div className={clsx("text-3xl font-semibold tabular-nums", s?.p90 != null && s.p90 > 15 ? "text-red-600" : "text-emerald-600")}>{num(s?.p90, 1)}</div>
              <div className="text-xs text-slate-500">p90 (target &lt; 15)</div>
            </div>
            <div>
              <div className="text-3xl font-semibold tabular-nums">{num(s?.pct_under_5, 1)}%</div>
              <div className="text-xs text-slate-500">answered within 5 min</div>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">WhatsApp free service messages this month</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums">
            {used.toLocaleString("en-IN")} <span className="text-base text-slate-500">/ {(d.serviceAllowance * Math.max(1, d.serviceUsage.length)).toLocaleString("en-IN")}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
            <div className={clsx("h-full", used > d.serviceAllowance * 0.8 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, (used / Math.max(1, d.serviceAllowance)) * 100)}%` }} />
          </div>
          <div className="mt-2 text-xs text-slate-500">1,000 free per business number per month; then billed per delivered message.</div>
          {(d.numbers as { display_number: string; quality_rating: string | null; messaging_limit: string | null }[]).map((n) => (
            <div key={n.display_number} className="mt-2 text-xs">
              {n.display_number}: quality <b className={n.quality_rating === "GREEN" ? "text-emerald-600" : n.quality_rating ? "text-red-600" : ""}>{n.quality_rating ?? "unknown"}</b> · limit {n.messaging_limit ?? "unknown"}
            </div>
          ))}
        </div>
      </div>
      {!!s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Contact rate (7d)" value={`${num(s.contact_rate, 1)}%`} />
          <Stat label="Win rate (7d)" value={`${num(s.win_rate, 1)}%`} hint="Won ÷ (won + lost)" />
          <Stat label="Leakage" value={`${num(s.leakage, 1)}%`} hint={`${s.open_leads} open leads; no activity in 7 days`} tone={Number(s.leakage) > 20 ? "bad" : undefined} />
          <Stat label="Median time to assign" value={s.median_minutes_to_assign != null ? `${num(s.median_minutes_to_assign, 1)} min` : "—"} />
        </div>
      )}
    </div>
  );
}

function Funnel({ range }: { range: string }) {
  const q = useQuery({ queryKey: ["report-funnel", range], queryFn: () => api<{ rows: Record<string, any>[] }>(`/api/reports/funnel?${range}`) });
  const rows = q.data?.rows ?? [];
  const bySource = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const acc = bySource.get(r.source) ?? { created: 0, contacted: 0, engaged: 0, qualified: 0, quoted: 0, won: 0, lost: 0, value_won: 0 };
    for (const k of Object.keys(acc)) acc[k]! += Number(r[k] ?? 0);
    bySource.set(r.source, acc);
  }
  const steps = ["created", "contacted", "engaged", "qualified", "quoted", "won"];
  const total = steps.reduce((o, k) => ({ ...o, [k]: [...bySource.values()].reduce((s, v) => s + (v[k] ?? 0), 0) }), {} as Record<string, number>);
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold">All sources</div>
        <div className="grid grid-cols-6 gap-2">
          {steps.map((k, i) => (
            <div key={k} className="text-center">
              <div className="mx-auto rounded bg-brand-600" style={{ height: 8 + (64 * (total[k] ?? 0)) / Math.max(1, total.created ?? 1), width: "100%", opacity: 1 - i * 0.12 }} />
              <div className="mt-1 text-lg font-semibold tabular-nums">{total[k]}</div>
              <div className="text-xs capitalize text-slate-500">{k}</div>
              {i > 0 && <div className="text-[11px] text-slate-400">{pct(total[k] ?? 0, total[steps[i - 1]!] ?? 0)} of prev</div>}
            </div>
          ))}
        </div>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              <th className="th">Source</th>
              {steps.map((s) => (
                <th key={s} className="th text-right capitalize">
                  {s}
                </th>
              ))}
              <th className="th text-right">Win rate</th>
              <th className="th text-right">Value won</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {[...bySource.entries()].map(([src, v]) => (
              <tr key={src}>
                <td className="td font-medium">{SOURCE_LABEL[src] ?? src}</td>
                {steps.map((s) => (
                  <td key={s} className="td text-right tabular-nums">
                    {v[s]}
                    {s !== "created" && <span className="ml-1 text-[11px] text-slate-400">{pct(v[s] ?? 0, v.created ?? 0)}</span>}
                  </td>
                ))}
                <td className="td text-right tabular-nums">{pct(v.won ?? 0, (v.won ?? 0) + (v.lost ?? 0))}</td>
                <td className="td text-right tabular-nums">{money(v.value_won)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No data yet (views refresh every 5 minutes).</p>}
      </div>
    </div>
  );
}

function Team({ range }: { range: string }) {
  const q = useQuery({ queryKey: ["report-team", range], queryFn: () => api<{ rows: Record<string, any>[] }>(`/api/reports/team?${range}`) });
  return (
    <div className="card overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr>
            {["Rep", "Leads", "Median 1st resp.", "p90 1st resp.", "Reply rate", "Qualification", "Win rate", "Avg deal", "Stale open (7d)"].map((h) => (
              <th key={h} className="th text-right first:text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {q.data?.rows.map((r) => (
            <tr key={r.user_id}>
              <td className="td font-medium">{r.name}</td>
              <td className="td text-right tabular-nums">{r.leads_handled}</td>
              <td className={clsx("td text-right tabular-nums", Number(r.median_first_response) > 5 && "text-red-600")}>{num(r.median_first_response, 1)}m</td>
              <td className={clsx("td text-right tabular-nums", Number(r.p90_first_response) > 15 && "text-red-600")}>{num(r.p90_first_response, 1)}m</td>
              <td className="td text-right tabular-nums">{num(r.reply_rate, 1)}%</td>
              <td className="td text-right tabular-nums">{num(r.qualification_rate, 1)}%</td>
              <td className="td text-right tabular-nums">{num(r.win_rate, 1)}%</td>
              <td className="td text-right tabular-nums">{money(r.avg_deal_value)}</td>
              <td className={clsx("td text-right tabular-nums", r.stale_open_leads > 0 && "text-amber-600")}>{r.stale_open_leads}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cost({ range }: { range: string }) {
  const q = useQuery({ queryKey: ["report-cost", range], queryFn: () => api<{ byCategory: Record<string, any>[]; templatePerf: Record<string, any>[]; unit: Record<string, any>; email: Record<string, any> }>(`/api/reports/cost?${range}`) });
  const d = q.data;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="WhatsApp spend" value={money(d.unit?.wa_spend)} hint="From Meta's pricing category on status webhooks" />
        <Stat label="Leads" value={d.unit?.leads} />
        <Stat label="Cost per lead" value={money(d.unit?.cost_per_lead)} />
        <Stat label="Cost per won deal" value={money(d.unit?.cost_per_won)} />
        <Stat label="Email bounce rate" value={`${num(d.email?.bounce_rate, 2)}%`} hint={`${d.email?.hard_bounces ?? 0} hard · ${d.email?.soft_bounces ?? 0} soft`} tone={Number(d.email?.bounce_rate) > 2 ? "bad" : undefined} />
      </div>
      <div className="card overflow-x-auto">
        <div className="border-b border-slate-200 p-3 text-sm font-semibold dark:border-slate-800">WhatsApp messages by category</div>
        <table className="min-w-full">
          <thead>
            <tr>
              {["Month", "Category", "Country", "Messages", "Billable", "Cost"].map((h) => (
                <th key={h} className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {d.byCategory.map((r, i) => (
              <tr key={i}>
                <td className="td">{String(r.month).slice(0, 7)}</td>
                <td className="td capitalize">{r.category}</td>
                <td className="td">{r.country}</td>
                <td className="td tabular-nums">{r.messages}</td>
                <td className="td tabular-nums">{r.billable_messages}</td>
                <td className="td tabular-nums">{money(r.cost, r.currency ?? "INR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto">
        <div className="border-b border-slate-200 p-3 text-sm font-semibold dark:border-slate-800">Template performance</div>
        <table className="min-w-full">
          <thead>
            <tr>
              {["Template", "Category", "Sent", "Delivered", "Read", "Replied (72h)", "Failed", "Read rate"].map((h) => (
                <th key={h} className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {d.templatePerf.map((r) => (
              <tr key={r.template_id}>
                <td className="td font-medium">{r.internal_name}</td>
                <td className="td capitalize">{r.category}</td>
                <td className="td tabular-nums">{r.sent}</td>
                <td className="td tabular-nums">{r.delivered}</td>
                <td className="td tabular-nums">{r.read}</td>
                <td className="td tabular-nums">{r.replied}</td>
                <td className="td tabular-nums">{r.failed}</td>
                <td className="td tabular-nums">{r.read_rate != null ? `${r.read_rate}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
