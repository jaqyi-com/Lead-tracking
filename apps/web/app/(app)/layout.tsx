"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, patch, post } from "@/lib/api";
import { useHotkeys, useMe, isManager } from "@/lib/hooks";
import { RealtimeProvider } from "@/lib/realtime";
import { ago, initials } from "@/lib/format";

const NAV = [
  { href: "/inbox", label: "Inbox", key: "g i" },
  { href: "/my-day", label: "My day", key: "g d" },
  { href: "/leads", label: "Leads", key: "g l" },
  { href: "/pipeline", label: "Pipeline", key: "g p" },
  { href: "/reports", label: "Reports", key: "g r" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (me.isError) router.replace("/login");
  }, [me.isError, router]);

  useHotkeys(
    {
      "g i": () => router.push("/inbox"),
      "g d": () => router.push("/my-day"),
      "g l": () => router.push("/leads"),
      "g p": () => router.push("/pipeline"),
      "g r": () => router.push("/reports"),
      "g a": () => router.push("/admin"),
      "?": () => setHelpOpen((x) => !x),
    },
    [router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!me.data) return <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading…</div>;

  const nav = [...NAV, ...(isManager(me.data) ? [{ href: "/admin", label: "Admin", key: "g a" }] : []), { href: "/settings", label: "Settings", key: "" }];

  return (
    <RealtimeProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900">
          <Link href="/inbox" className="flex items-center gap-2 font-semibold">
            <img src="/icon.svg" alt="" className="h-6 w-6" />
            <span className="hidden sm:inline">Lead OS</span>
          </Link>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                title={n.key ? `${n.label} (${n.key})` : n.label}
                className={clsx(
                  "whitespace-nowrap rounded-md px-2.5 py-1 text-sm",
                  pathname.startsWith(n.href) ? "bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <GlobalSearch inputRef={searchRef} />
          <Availability available={me.data.isAvailable} />
          <Notifications />
          <span title={`${me.data.name} (${me.data.role})`} className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
            {initials(me.data.name)}
          </span>
        </header>
        <main className="min-h-0 flex-1">{children}</main>
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </div>
    </RealtimeProvider>
  );
}

function Availability({ available }: { available: boolean }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: boolean) => patch("/api/me", { isAvailable: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <button
      className={clsx("chip hidden border sm:inline-flex", available ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800")}
      onClick={() => m.mutate(!available)}
      title="Routing only assigns new leads to available reps"
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", available ? "bg-emerald-500" : "bg-slate-400")} />
      {available ? "Available" : "Away"}
    </button>
  );
}

function GlobalSearch({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const res = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api<{ items: { type: string; id: string; leadId: string | null; conversationId: string | null; title: string; snippet: string }[] }>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  const go = (h: { leadId: string | null; conversationId: string | null }) => {
    setOpen(false);
    setQ("");
    if (h.conversationId) router.push(`/inbox?c=${h.conversationId}`);
    else if (h.leadId) router.push(`/leads/${h.leadId}`);
  };
  return (
    <div className="relative hidden md:block">
      <input
        ref={inputRef}
        className="input h-8 w-64"
        placeholder="Search people, companies, messages  ⌘K"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && res.data?.items[0]) go(res.data.items[0]);
        }}
        aria-label="Search"
      />
      {open && debounced.length >= 2 && (
        <div className="card absolute right-0 z-40 mt-1 max-h-96 w-[28rem] overflow-y-auto p-1">
          {res.isLoading && <div className="p-3 text-sm text-slate-500">Searching…</div>}
          {res.data?.items.length === 0 && <div className="p-3 text-sm text-slate-500">No results</div>}
          {res.data?.items.map((h) => (
            <button key={h.type + h.id} className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onMouseDown={() => go(h)}>
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="chip bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{h.type}</span>
                {h.title}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-slate-500" dangerouslySetInnerHTML={{ __html: sanitizeSnippet(h.snippet) }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** ts_headline wraps matches in <b>; escape everything else. */
function sanitizeSnippet(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;b&gt;/g, "<b>")
    .replace(/&lt;\/b&gt;/g, "</b>");
}

function Notifications() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ items: { id: string; title: string; body: string | null; leadId: string | null; conversationId: string | null; readAt: string | null; createdAt: string }[]; unread: number }>("/api/notifications"),
    refetchInterval: 60_000,
  });
  const markAll = useMutation({ mutationFn: () => post("/api/notifications/read", {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <div className="relative">
      <button className="btn-ghost relative" onClick={() => setOpen((x) => !x)} aria-label="Notifications">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {!!q.data?.unread && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{q.data.unread > 99 ? "99+" : q.data.unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 z-40 mt-1 max-h-[28rem] w-80 overflow-y-auto">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="text-sm font-semibold">Notifications</span>
            <button className="text-xs text-brand-600" onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          {q.data?.items.length === 0 && <p className="p-4 text-sm text-slate-500">Nothing yet.</p>}
          {q.data?.items.map((n) => (
            <button
              key={n.id}
              className={clsx("block w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800", !n.readAt && "bg-brand-50/60 dark:bg-brand-600/10")}
              onClick={() => {
                setOpen(false);
                post("/api/notifications/read", { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
                if (n.conversationId) router.push(`/inbox?c=${n.conversationId}`);
                else if (n.leadId) router.push(`/leads/${n.leadId}`);
              }}
            >
              <div className="text-sm font-medium">{n.title}</div>
              {n.body && <div className="line-clamp-2 text-xs text-slate-500">{n.body}</div>}
              <div className="mt-0.5 text-[11px] text-slate-400">{ago(n.createdAt)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["j / k", "Next / previous conversation"],
    ["r", "Reply (focus composer)"],
    ["t", "Template picker"],
    ["/", "Insert snippet (in composer)"],
    ["a", "Assign to me (claim)"],
    ["e", "Close conversation"],
    ["n", "Internal note"],
    ["g i / g d / g l / g p / g r", "Inbox / My day / Leads / Pipeline / Reports"],
    ["⌘K", "Search"],
    ["?", "This help"],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 font-semibold">Keyboard shortcuts</h2>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="py-1 pr-4">
                  <span className="kbd">{k}</span>
                </td>
                <td className="py-1 text-slate-600 dark:text-slate-300">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
