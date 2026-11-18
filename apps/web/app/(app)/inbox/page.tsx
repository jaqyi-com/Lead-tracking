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
      <aside className={clsx("flex w-full shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:w-[22rem]", selected && "hidden lg:flex")}>
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 p-2 dark:border-slate-800">
          {FILTERS.map((f) => {
            const n = f.count ? q.data?.counts?.[f.count] : undefined;
            return (
              <button
                key={f.key}
                onClick={() => setParam("filter", f.key)}
                className={clsx(
                  "whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
                  filter === f.key ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200",
                  f.key === "unassigned" && n ? "ring-2 ring-red-400" : "",
                )}
              >
                {f.label}
                {n ? <span className="ml-1 tabular-nums">{n}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 border-b border-slate-200 px-2 py-1.5 text-xs dark:border-slate-800">
          {["", "whatsapp", "email"].map((c) => (
            <button key={c} onClick={() => setParam("channel", c)} className={clsx("rounded px-2 py-0.5", channel === c ? "bg-slate-200 font-medium dark:bg-slate-700" : "text-slate-500")}>
              {c === "" ? "All channels" : c === "whatsapp" ? "WhatsApp" : "Email"}
            </button>
          ))}
        </div>
        {filter === "all" && !!q.data?.counts?.unassigned && (
          <button onClick={() => setParam("filter", "unassigned")} className="m-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-left text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <strong>{q.data.counts.unassigned}</strong> unassigned {q.data.counts.unassigned === 1 ? "lead is" : "leads are"} waiting — claim with <span className="kbd">a</span>
          </button>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {q.isLoading && <li className="p-4 text-sm text-slate-500">Loading…</li>}
          {!q.isLoading && items.length === 0 && <li className="p-6 text-center text-sm text-slate-500">Nothing here. 🎉</li>}
          {items.map((c) => {
            const windowMs = c.window_expires_at ? new Date(c.window_expires_at).getTime() - now : 0;
            return (
              <li key={c.id}>
                <button
                  onClick={() => setParam("c", c.id)}
                  className={clsx(
                    "block w-full border-b border-slate-100 px-3 py-2.5 text-left dark:border-slate-800",
                    c.id === selected ? "bg-brand-50 dark:bg-brand-600/15" : "hover:bg-slate-50 dark:hover:bg-slate-800/60",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <ChannelIcon channel={c.channel} />
                    <span className={clsx("min-w-0 flex-1 truncate text-sm", c.unread_count ? "font-semibold" : "font-medium")}>{c.contact_name ?? "Unknown"}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{ago(c.last_message_at)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                    {c.company_name && <span className="truncate">{c.company_name}</span>}
                    <span className="text-slate-300">·</span>
                    <span>L-{c.lead_number}</span>
                  </div>
                  <div className={clsx("mt-1 line-clamp-1 text-sm", c.last_direction === "inbound" ? "text-slate-800 dark:text-slate-100" : "text-slate-500")}>
                    {c.last_direction === "outbound" && <span className="text-slate-400">You: </span>}
                    {c.last_message_preview}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <StageBadge stage={c.stage} />
                    {!c.owner_id && !c.is_junk && <span className="chip bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">Unassigned</span>}
                    {c.owner_name && <span className="chip bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{c.owner_name.split(" ")[0]}</span>}
                    <SlaDot level={c.sla_level} />
                    {c.channel === "whatsapp" && windowMs > 0 && windowMs < 2 * 3600_000 && <span className="chip bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Window {countdown(windowMs)}</span>}
                    {!!c.unread_count && <span className="chip ml-auto bg-brand-600 text-white">{c.unread_count}</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Centre + right */}
      <section className={clsx("min-w-0 flex-1", !selected && "hidden lg:block")}>
        {selected ? <Thread key={selected} conversationId={selected} onBack={() => setParam("c", null)} onNext={() => items[idx + 1] && setParam("c", items[idx + 1]!.id)} /> : <Empty>Select a conversation. Use <span className="kbd mx-1">j</span>/<span className="kbd mx-1">k</span> to move.</Empty>}
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
