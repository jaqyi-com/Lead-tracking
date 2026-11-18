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
import { Logo } from "@/components/logo";
import { IconBell, IconChart, IconInbox, IconKanban, IconLogout, IconMenu, IconSearch, IconSettings, IconShield, IconSun, IconUsers } from "@/components/icons";

type NavItem = { href: string; label: string; key: string; icon: (p: { size?: number }) => React.ReactNode; badge?: number };

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const badge = useQuery({
    queryKey: ["conversations", "badge"],
    queryFn: () => api<{ counts: Record<string, number> }>("/api/conversations?filter=unassigned&limit=1"),
    refetchInterval: 20_000,
    enabled: !!me.data && me.data.role !== "viewer",
  });

  useEffect(() => {
    if (me.isError) router.replace("/login");
  }, [me.isError, router]);
  useEffect(() => setMobileNav(false), [pathname]);

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

  if (!me.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Logo compact />
          <div className="h-1 w-24 overflow-hidden rounded-full bg-ink-200">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-brand-600" />
          </div>
        </div>
      </div>
    );
  }

  const unassigned = badge.data?.counts?.unassigned ?? 0;
  const work: NavItem[] = [
    { href: "/inbox", label: "Inbox", key: "G I", icon: IconInbox, badge: unassigned },
    { href: "/my-day", label: "My day", key: "G D", icon: IconSun },
    { href: "/leads", label: "Leads", key: "G L", icon: IconUsers },
    { href: "/pipeline", label: "Pipeline", key: "G P", icon: IconKanban },
  ];
  const insight: NavItem[] = [
    { href: "/reports", label: "Reports", key: "G R", icon: IconChart },
    ...(isManager(me.data) ? [{ href: "/admin", label: "Admin", key: "G A", icon: IconShield }] : []),
    { href: "/settings", label: "Settings", key: "", icon: IconSettings },
  ];

  const NavGroup = ({ title, items }: { title: string; items: NavItem[] }) => (
    <div>
      <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400">{title}</div>
      <ul className="space-y-0.5">
        {items.map((n) => {
          const active = pathname.startsWith(n.href);
          const Icon = n.icon;
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                className={clsx(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                )}
              >
                {active && <span className="absolute -left-3 top-1.5 h-[calc(100%-12px)] w-1 rounded-r-full bg-brand-600" />}
                <span className={clsx(active ? "text-brand-600" : "text-ink-400 group-hover:text-ink-700")}>
                  <Icon size={18} />
                </span>
                <span className="flex-1">{n.label}</span>
                {!!n.badge && <span className="min-w-[20px] rounded-full bg-brand-600 px-1.5 py-px text-center text-[11px] font-bold text-white shadow-glow">{n.badge > 99 ? "99+" : n.badge}</span>}
                {!n.badge && n.key && <span className="hidden font-mono text-[10px] text-ink-300 group-hover:inline">{n.key}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );

  const sidebar = (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-16 items-center px-5">
        <Link href="/inbox">
          <Logo />
        </Link>
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pt-2">
        <NavGroup title="Work" items={work} />
        <NavGroup title="Insight" items={insight} />
      </nav>
      <div className="m-3 rounded-xl border border-ink-200 bg-ink-50 p-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-bold text-white">{initials(me.data.name)}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink-900">{me.data.name}</div>
            <div className="truncate text-xs capitalize text-ink-500">{me.data.role}</div>
          </div>
          <button
            className="rounded-md p-1.5 text-ink-400 transition hover:bg-white hover:text-brand-600"
            title="Sign out"
            onClick={async () => {
              await post("/api/auth/logout");
              window.location.href = "/login";
            }}
          >
            <IconLogout size={16} />
          </button>
        </div>
        <Availability available={me.data.isAvailable} />
      </div>
    </div>
  );

  return (
    <RealtimeProvider>
      <div className="flex h-full">
        <aside className="hidden w-64 shrink-0 border-r border-ink-200 lg:block">{sidebar}</aside>
        {mobileNav && (
          <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMobileNav(false)}>
            <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-sm" />
            <aside className="absolute inset-y-0 left-0 w-72 animate-fade-in shadow-lift" onClick={(e) => e.stopPropagation()}>
              {sidebar}
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-ink-200 bg-white/90 px-4 backdrop-blur lg:px-6">
            <button className="btn-ghost lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open menu">
              <IconMenu />
            </button>
            <span className="lg:hidden">
              <Logo compact />
            </span>
            <GlobalSearch inputRef={searchRef} />
            <div className="ml-auto flex items-center gap-1">
              <button className="btn-ghost hidden text-xs md:inline-flex" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts">
                <span className="kbd">?</span> Shortcuts
              </button>
              <Notifications />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-hidden bg-ink-50">{children}</main>
        </div>
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
      onClick={() => m.mutate(!available)}
      title="Routing only assigns new leads to available reps"
      className="mt-3 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-xs font-semibold shadow-card ring-1 ring-ink-200 transition hover:ring-ink-300"
    >
      <span className="flex items-center gap-2">
        <span className={clsx("relative flex h-2 w-2", available && "text-emerald-500")}>
          {available && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
          <span className={clsx("relative inline-flex h-2 w-2 rounded-full", available ? "bg-emerald-500" : "bg-ink-300")} />
        </span>
        {available ? "Available for new leads" : "Away — not receiving leads"}
      </span>
      <span className={clsx("relative h-4 w-7 rounded-full transition", available ? "bg-emerald-500" : "bg-ink-300")}>
        <span className={clsx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition", available ? "left-3.5" : "left-0.5")} />
      </span>
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
    <div className="relative hidden w-full max-w-md md:block">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400">
        <IconSearch size={16} />
      </span>
      <input
        ref={inputRef}
        className="input h-10 rounded-xl border-ink-200 bg-ink-50 pl-9 pr-14 shadow-none focus:bg-white"
        placeholder="Search people, companies, messages…"
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
      <span className="kbd pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">⌘K</span>
      {open && debounced.length >= 2 && (
        <div className="card absolute left-0 z-40 mt-2 max-h-96 w-[30rem] animate-fade-in overflow-y-auto p-1.5 shadow-lift">
          {res.isLoading && <div className="p-3 text-sm text-ink-500">Searching…</div>}
          {res.data?.items.length === 0 && <div className="p-3 text-sm text-ink-500">No results for “{debounced}”</div>}
          {res.data?.items.map((h) => (
            <button key={h.type + h.id} className="block w-full rounded-lg px-3 py-2 text-left transition hover:bg-brand-50" onMouseDown={() => go(h)}>
              <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                <span className="chip bg-ink-100 uppercase tracking-wide text-ink-500">{h.type}</span>
                {h.title}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-ink-500 [&_b]:font-semibold [&_b]:text-brand-700" dangerouslySetInnerHTML={{ __html: sanitizeSnippet(h.snippet) }} />
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
    refetchInterval: 30_000,
  });
  const markAll = useMutation({ mutationFn: () => post("/api/notifications/read", {}), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <div className="relative">
      <button className="relative rounded-xl p-2.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900" onClick={() => setOpen((x) => !x)} aria-label="Notifications">
        <IconBell size={19} />
        {!!q.data?.unread && <span className="absolute right-1 top-1 min-w-[18px] rounded-full bg-brand-600 px-1 text-center text-[10px] font-bold leading-[18px] text-white ring-2 ring-white">{q.data.unread > 99 ? "99+" : q.data.unread}</span>}
      </button>
      {open && (
        <div className="card absolute right-0 z-40 mt-2 max-h-[30rem] w-96 animate-fade-in overflow-y-auto shadow-lift">
          <div className="sticky top-0 flex items-center justify-between border-b border-ink-200 bg-white px-4 py-3">
            <span className="section-title">Notifications</span>
            <button className="text-xs font-semibold text-brand-600 hover:text-brand-700" onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          {q.data?.items.length === 0 && <p className="p-6 text-center text-sm text-ink-500">You're all caught up.</p>}
          {q.data?.items.map((n) => (
            <button
              key={n.id}
              className={clsx("flex w-full gap-3 border-b border-ink-100 px-4 py-3 text-left transition hover:bg-ink-50", !n.readAt && "bg-brand-50/40")}
              onClick={() => {
                setOpen(false);
                post("/api/notifications/read", { ids: [n.id] }).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
                if (n.conversationId) router.push(`/inbox?c=${n.conversationId}`);
                else if (n.leadId) router.push(`/leads/${n.leadId}`);
              }}
            >
              <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-brand-600")} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-900">{n.title}</span>
                {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-ink-500">{n.body}</span>}
                <span className="mt-1 block text-[11px] text-ink-400">{ago(n.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["J / K", "Next / previous conversation"],
    ["R", "Reply"],
    ["T", "Template picker"],
    ["/", "Insert snippet (in composer)"],
    ["A", "Claim lead"],
    ["S", "Change stage"],
    ["E", "Close conversation"],
    ["N", "Internal note"],
    ["G then I / D / L / P / R", "Inbox · My day · Leads · Pipeline · Reports"],
    ["⌘K", "Search"],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="card w-full max-w-md animate-fade-in p-6 shadow-lift" onClick={(e) => e.stopPropagation()}>
        <h2 className="section-title mb-4">Keyboard shortcuts</h2>
        <div className="space-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between text-sm">
              <span className="text-ink-600">{v}</span>
              <span className="kbd text-[11px]">{k}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
