"use client";
import clsx from "clsx";
import { useEffect, type ReactNode } from "react";
import { STAGE_COLOR, STAGE_LABEL, SOURCE_LABEL, scoreBand } from "@/lib/format";

export function StageBadge({ stage }: { stage: string }) {
  return <span className={clsx("chip", STAGE_COLOR[stage])}>{STAGE_LABEL[stage] ?? stage}</span>;
}

export function ScoreBadge({ score }: { score: number }) {
  const b = scoreBand(score);
  return (
    <span className={clsx("chip", b.cls)} title={`Score ${score}`}>
      {b.label} · {score}
    </span>
  );
}

export function SourceLabel({ source }: { source: string }) {
  return <span>{SOURCE_LABEL[source] ?? source.replace(/_/g, " ")}</span>;
}

export function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  if (channel === "whatsapp") {
    return (
      <svg className={clsx("text-wa-500", className)} width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-label="WhatsApp">
        <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3z" />
      </svg>
    );
  }
  return (
    <svg className={clsx("text-sky-600", className)} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Email">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

export function SlaDot({ level }: { level: number | null | undefined }) {
  if (!level) return null;
  return (
    <span
      className={clsx("chip", level >= 2 ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300")}
      title={level >= 2 ? "SLA breached" : "SLA at risk"}
    >
      {level >= 2 ? "SLA breached" : "SLA at risk"}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4 pt-20 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={clsx("card w-full animate-fade-in p-6 shadow-lift", wide ? "max-w-3xl" : "max-w-md")} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-ink-900">{title}</h2>
          <button className="rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-900" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children, title }: { children?: ReactNode; title?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 ring-8 ring-brand-50/50">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
      </span>
      {title && <div className="font-display text-base font-bold text-ink-900">{title}</div>}
      {children && <div className="max-w-sm text-sm text-ink-500">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "bad" | "good" | "warn" }) {
  return (
    <div className="card relative overflow-hidden p-5">
      <span className={clsx("absolute inset-x-0 top-0 h-1", tone === "bad" ? "bg-brand-600" : tone === "warn" ? "bg-amber-400" : tone === "good" ? "bg-emerald-500" : "bg-ink-200")} />
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">{label}</div>
      <div className={clsx("mt-2 font-display text-3xl font-bold tabular-nums tracking-tight", tone === "bad" ? "text-brand-600" : tone === "warn" ? "text-amber-600" : tone === "good" ? "text-emerald-600" : "text-ink-900")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}
