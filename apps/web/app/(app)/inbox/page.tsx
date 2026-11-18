"use client";
import { Suspense, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useHotkeys, useNow } from "@/lib/hooks";
import { POLL_MS } from "@/lib/realtime";
import { ago, countdown } from "@/lib/format";
import { ChannelIcon, Empty, SlaDot, StageBadge } from "@/components/ui";
import { Thread } from "@/components/thread";

export type ConvRow = {
  id: string;
  lead_id: string;
  channel: "whatsapp" | "email";
  state: string;
  subject: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_direction: "inbound" | "outbound" | null;
  window_expires_at: string | null;
  is_junk: boolean;
  lead_number: number;
  stage: string;
  score: number;
  owner_id: string | null;
  owner_name: string | null;
  contact_name: string | null;
  company_name: string | null;
  sla_level: number | null;
  source: string;
};

const FILTERS: { key: string; label: string; count?: string }[] = [
  { key: "all", label: "All open" },
  { key: "unassigned", label: "Unassigned", count: "unassigned" },
  { key: "mine", label: "Mine", count: "mine_waiting" },
  { key: "team", label: "My team" },
  { key: "awaiting", label: "Awaiting our reply", count: "awaiting" },
  { key: "window_closing", label: "Window closing <2h", count: "window_closing" },
  { key: "sla", label: "SLA at risk" },
  { key: "unread", label: "Unread", count: "unread" },
  { key: "snoozed", label: "Snoozed" },
  { key: "closed", label: "Closed" },
  { key: "junk", label: "Junk" },
];

function InboxInner() {
  const router = useRouter();
  const params = useSearchParams();
  const filter = params.get("filter") ?? "all";
  const selected = params.get("c");
  const channel = params.get("channel") ?? "";
  const now = useNow(30_000);

  const q = useQuery({
    queryKey: ["conversations", filter, channel],
    queryFn: () => api<{ items: ConvRow[]; counts: Record<string, number> }>(`/api/conversations?filter=${filter}${channel ? `&channel=${channel}` : ""}`),
    refetchInterval: POLL_MS.list,
  });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v === null || v === "") p.delete(k);
    else p.set(k, v);
    router.replace(`/inbox?${p.toString()}`);
  };

  const idx = items.findIndex((c) => c.id === selected);
  useHotkeys(
    {
      j: () => items[Math.min(idx + 1, items.length - 1)] && setParam("c", items[Math.min(idx + 1, items.length - 1)]!.id),
      k: () => items[Math.max(idx - 1, 0)] && setParam("c", items[Math.max(idx - 1, 0)]!.id),
    },
    [items, idx, params],
  );

  useEffect(() => {
    if (!selected && items[0] && window.innerWidth >= 1024) setParam("c", items[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, selected]);

  return (
    <div className="flex h-full">
      {/* Left: list */}
      <aside className={clsx("flex w-full shrink-0 flex-col border-r border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900 lg:w-[22rem]", selected && "hidden lg:flex")}>
        <div className="flex gap-1 overflow-x-auto border-b border-ink-200 p-2 dark:border-ink-800">
          {FILTERS.map((f) => {
            const n = f.count ? q.data?.counts?.[f.count] : undefined;
            return (
              <button
                key={f.key}
                onClick={() => setParam("filter", f.key)}
                className={clsx(
                  "whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  filter === f.key ? "bg-brand-600 text-white shadow-glow" : "bg-white text-ink-600 ring-1 ring-ink-200 hover:text-ink-900 hover:ring-ink-300",
                  f.key === "unassigned" && n && filter !== f.key ? "!text-brand-700 !ring-brand-300" : "",
                )}
              >
                {f.label}
                {n ? <span className="ml-1 tabular-nums">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-b border-ink-200 px-2 py-1.5 text-xs dark:border-ink-800">
          {["", "whatsapp", "email"].map((c) => (
            <button key={c} onClick={() => setParam("channel", c)} className={clsx("rounded px-2 py-0.5", channel === c ? "bg-ink-200 font-medium dark:bg-ink-700" : "text-ink-500")}>
              {c === "" ? "All channels" : c === "whatsapp" ? "WhatsApp" : "Email"}
            </button>
          ))}
        </div>
        {filter === "all" && !!q.data?.counts?.unassigned && (
          <button onClick={() => setParam("filter", "unassigned")} className="m-3 flex items-center gap-3 rounded-xl bg-brand-600 px-4 py-3 text-left text-sm text-white shadow-glow transition hover:bg-brand-700">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 font-display text-base font-bold">{q.data.counts.unassigned}</span><span><span className="block font-semibold">Unassigned {q.data.counts.unassigned === 1 ? "lead is" : "leads are"} waiting</span><span className="block text-xs text-white/80">Open one and press A to claim it</span></span>
          </button>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {q.isLoading && <li className="p-4 text-sm text-ink-500">Loading…</li>}
          {!q.isLoading && items.length === 0 && <li className="h-64"><Empty title="Inbox zero">Nothing waiting in this view.</Empty></li>}
          {items.map((c) => {
            const windowMs = c.window_expires_at ? new Date(c.window_expires_at).getTime() - now : 0;
            return (
              <li key={c.id}>
                <button
                  onClick={() => setParam("c", c.id)}
                  className={clsx(
                    "relative block w-full border-b border-ink-100 px-4 py-3 text-left transition",
                    c.id === selected ? "bg-brand-50/70 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-brand-600" : "hover:bg-ink-50",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <ChannelIcon channel={c.channel} />
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[11px] font-bold text-ink-600">{(c.contact_name ?? "?").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}</span><span className={clsx("min-w-0 flex-1 truncate text-sm text-ink-900", c.unread_count ? "font-bold" : "font-semibold")}>{c.contact_name ?? "Unknown"}</span>
                    <span className="shrink-0 text-[11px] text-ink-400">{ago(c.last_message_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
                    <span>L-{c.lead_number}</span>
                    {c.company_name && (
                      <>
                        <span className="text-ink-300">·</span>
                        <span className="truncate">{c.company_name}</span>
                      </>
                    )}
                  </div>
                  <div className={clsx("mt-1 line-clamp-1 text-sm", c.last_direction === "inbound" ? "text-ink-800 dark:text-ink-100" : "text-ink-500")}>
                    {c.last_direction === "outbound" && <span className="text-ink-400">You: </span>}
                    {c.last_message_preview}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <StageBadge stage={c.stage} />
                    {!c.owner_id && !c.is_junk && <span className="chip bg-brand-50 text-brand-700 ring-1 ring-brand-200">Unassigned</span>}
                    {c.owner_name && <span className="chip bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">{c.owner_name.split(" ")[0]}</span>}
                    <SlaDot level={c.sla_level} />
                    {c.channel === "whatsapp" && windowMs > 0 && windowMs < 2 * 3600_000 && <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Window {countdown(windowMs)}</span>}
                    {!!c.unread_count && <span className="chip ml-auto bg-brand-600 text-white shadow-glow">{c.unread_count}</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Centre + right */}
      <section className={clsx("min-w-0 flex-1", !selected && "hidden lg:block")}>
        {selected ? <Thread key={selected} conversationId={selected} onBack={() => setParam("c", null)} onNext={() => items[idx + 1] && setParam("c", items[idx + 1]!.id)} /> : <Empty title="Pick a conversation">Use <span className="kbd mx-1">J</span>/<span className="kbd mx-1">K</span> to move through the list.</Empty>}
      </section>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxInner />
    </Suspense>
  );
}
