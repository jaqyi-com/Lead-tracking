"use client";
/** §8.3 context rail — everything the rep needs so they never ask "who is this?" */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "@/lib/api";
import { POLL_MS } from "@/lib/realtime";
import { ago, dateTime, money } from "@/lib/format";
import { ScoreBadge, SourceLabel, StageBadge } from "./ui";

export type LeadDetail = {
  lead: {
    id: string;
    number: number;
    stage: string;
    source: string;
    sourceDetail: string | null;
    score: number;
    scoreBreakdown: { rule: string; points: number }[];
    valueEstimate: string | null;
    currency: string;
    ownerId: string | null;
    nextStep: string | null;
    nextStepAt: string | null;
    qualification: Record<string, unknown>;
    tags: string[];
    enquiry: string | null;
    firstResponseBusinessMinutes: number | null;
    lostReason: string | null;
    parseFailed: boolean;
    createdAt: string;
    revisitAt: string | null;
  };
  contact: { id: string; displayName: string | null; firstName: string | null; lastName: string | null; jobTitle: string | null; city: string | null; state: string | null; timezone: string; doNotContact: boolean };
  company: { id: string; name: string; domain: string | null; industry: string | null; sizeBand: string | null; city: string | null; enrichedAt: string | null } | null;
  owner: { id: string; name: string } | null;
  identities: { id: string; kind: string; valueNormalised: string; valueRaw: string; verifiedState: string }[];
  consent: { whatsapp: { utility: boolean; marketing: boolean; optedOut: boolean }; email: { marketing: boolean; unsubscribed: boolean }; records: { id: string; channel: string; purpose: string; state: string; basis: string; capturedAt: string; noticeVersion: string | null }[] };
  conversations: { id: string; channel: string; lastMessageAt: string | null }[];
  timeline: { id: string; type: string; actorType: string; actorId: string | null; payload: Record<string, unknown>; occurredAt: string }[];
  notes: { id: string; body: string; authorId: string | null; createdAt: string }[];
  tasks: { id: string; title: string; dueAt: string | null; completedAt: string | null; type: string }[];
  slaTimers: { id: string; kind: string; state: string; breachAt: string; warnedAt: string | null; breachedAt: string | null; targetMinutes: number }[];
  enrollment: { id: string; state: string; stopReason: string | null; currentStep: number; nextRunAt: string | null; events: { id: string; stepPosition: number; outcome: string; detail: Record<string, unknown>; occurredAt: string }[] } | null;
  enrichment: { provider: string; matched: boolean; fetchedAt: string } | null;
  history: { id: string; number: number; stage: string; openedAt: string; closedAt: string | null; lostReason: string | null }[];
  duplicates: { id: string; reason: string }[];
  userNames: Record<string, string>;
};

export function useLead(leadId: string) {
  return useQuery({ queryKey: ["lead", leadId], queryFn: () => api<LeadDetail>(`/api/leads/${leadId}`), refetchInterval: POLL_MS.lead });
}

export const ACTIVITY_LABEL: Record<string, string> = {
  lead_created: "Lead created",
  message_received: "Message received",
  auto_reply_received: "Auto-reply received",
  assigned: "Assigned",
  reassigned: "Reassigned",
  routed_unassigned: "Left in Unassigned",
  stage_changed: "Stage changed",
  first_response: "First response",
  note_added: "Note added",
  task_created: "Task created",
  task_completed: "Task completed",
  sla_breached: "SLA breached",
  sla_hard_breached: "SLA hard breach",
  sequence_enrolled: "Follow-up sequence started",
  sequence_stopped: "Follow-up sequence stopped",
  cadence_sent: "Follow-up sent",
  cadence_substituted: "Follow-up sent (substituted)",
  cadence_suppressed: "Follow-up suppressed",
  cadence_deferred: "Follow-up deferred",
  cadence_task_created: "Follow-up task created",
  cadence_moved_to_nurture: "Moved to nurture",
  auto_ack_sent: "Acknowledgement sent",
  auto_ack_skipped: "Acknowledgement skipped",
  opted_out: "Opted out",
  enriched: "Enriched from Doott DB",
  lead_updated: "Lead updated",
  message_sent_externally: "Sent outside the app",
  email_bounced: "Email bounced",
  snoozed: "Snoozed",
  marked_junk: "Marked junk",
  contact_merged: "Contact merged",
};

export function activityText(a: LeadDetail["timeline"][number], names: Record<string, string>): string {
  const p = a.payload;
  const who = (id: unknown) => (typeof id === "string" ? (names[id] ?? "someone") : "nobody");
  switch (a.type) {
    case "stage_changed":
      return `${p.from} → ${p.to}${p.lostReason ? ` (${p.lostReason})` : ""}${p.reason ? ` · ${p.reason}` : ""}`;
    case "assigned":
    case "reassigned":
      return `${p.from ? `${who(p.from)} → ` : ""}${who(p.to)}${p.reason ? ` · ${p.reason}` : ""}`;
    case "first_response":
      return p.businessMinutes != null ? `${p.businessMinutes} business min` : "";
    case "message_received":
      return String(p.preview ?? "");
    case "cadence_suppressed":
    case "cadence_deferred":
    case "cadence_substituted":
    case "auto_ack_skipped":
      return String(p.reason ?? "");
    case "message_sent_externally":
      return `via ${p.via}`;
    case "routed_unassigned":
      return String(p.rule ?? "");
    default:
      return "";
  }
}

export function ContextRail({ leadId }: { leadId: string }) {
  const q = useLead(leadId);
  if (!q.data) return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  const { lead, contact, company, owner, identities, consent, timeline, tasks, history, enrichment, userNames } = q.data;
  const openTasks = tasks.filter((t) => !t.completedAt);
  const running = q.data.slaTimers.filter((t) => t.state === "running");

  return (
    <div className="space-y-4 p-4 text-sm">
      <section>
        <div className="text-base font-semibold">{contact.displayName ?? "Unknown contact"}</div>
        <div className="text-slate-500">{[contact.jobTitle, company?.name].filter(Boolean).join(" · ") || "No title or company yet"}</div>
        <div className="text-slate-500">{[contact.city ?? company?.city, contact.state].filter(Boolean).join(", ")}</div>
        <ul className="mt-2 space-y-0.5 text-xs">
          {identities
            .filter((i) => i.kind !== "wa_id")
            .map((i) => (
              <li key={i.id} className="flex items-center gap-1">
                <span className="text-slate-400">{i.kind}</span>
                <span className="font-mono">{i.valueNormalised}</span>
                {i.kind === "email" && i.verifiedState !== "unknown" && (
                  <span className={clsx("chip", i.verifiedState === "deliverable" ? "bg-emerald-100 text-emerald-700" : i.verifiedState === "invalid" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700")}>{i.verifiedState}</span>
                )}
              </li>
            ))}
        </ul>
      </section>

      {company && (
        <section className="rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-800/50">
          <div className="font-medium">{company.name}</div>
          <div className="text-slate-500">{[company.industry, company.sizeBand && `${company.sizeBand} employees`, company.domain].filter(Boolean).join(" · ") || "Not enriched yet"}</div>
          {enrichment && <div className="mt-1 text-[11px] text-slate-400">Doott DB {enrichment.matched ? "match" : "no match"} · {ago(enrichment.fetchedAt)}</div>}
        </section>
      )}

      <section className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="label">Stage</div>
          <StageBadge stage={lead.stage} />
        </div>
        <div>
          <div className="label">Score</div>
          <span title={lead.scoreBreakdown.map((b) => `${b.points > 0 ? "+" : ""}${b.points} ${b.rule}`).join("\n")}>
            <ScoreBadge score={lead.score} />
          </span>
        </div>
        <div>
          <div className="label">Owner</div>
          {owner?.name ?? <span className="text-red-600">Unassigned</span>}
        </div>
        <div>
          <div className="label">Value</div>
          {money(lead.valueEstimate, lead.currency)}
        </div>
        <div className="col-span-2">
          <div className="label">Source</div>
          <SourceLabel source={lead.source} />
          {lead.sourceDetail && <span className="text-slate-500"> · {lead.sourceDetail}</span>}
        </div>
        <div className="col-span-2">
          <div className="label">Next step</div>
          {lead.nextStep ? (
            <span>
              {lead.nextStep} <span className={clsx(lead.nextStepAt && new Date(lead.nextStepAt) < new Date() ? "text-red-600" : "text-slate-500")}>· {dateTime(lead.nextStepAt)}</span>
            </span>
          ) : (
            <span className="text-amber-600">Not set</span>
          )}
        </div>
      </section>

      {lead.scoreBreakdown.length > 0 && (
        <section>
          <div className="label">Why this score</div>
          <ul className="space-y-0.5 text-xs">
            {lead.scoreBreakdown.map((b) => (
              <li key={b.rule} className="flex justify-between gap-2">
                <span>{b.rule}</span>
                <span className={clsx("tabular-nums", b.points > 0 ? "text-emerald-600" : "text-red-600")}>{b.points > 0 ? `+${b.points}` : b.points}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {running.length > 0 && (
        <section>
          <div className="label">SLA clocks</div>
          <ul className="space-y-1 text-xs">
            {running.map((t) => (
              <li key={t.id} className={clsx("flex justify-between", t.breachedAt ? "text-red-600" : t.warnedAt ? "text-amber-600" : "")}>
                <span>{t.kind.replace(/_/g, " ")}</span>
                <span>{t.breachedAt ? "breached" : `due ${ago(t.breachAt)}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="label">Consent</div>
        <div className="flex flex-wrap gap-1 text-[11px]">
          <span className={clsx("chip", consent.whatsapp.optedOut ? "bg-red-100 text-red-700" : consent.whatsapp.utility ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600")}>
            WA {consent.whatsapp.optedOut ? "opted out" : consent.whatsapp.utility ? "utility ✓" : "no consent"}
          </span>
          <span className={clsx("chip", consent.whatsapp.marketing ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600")}>WA marketing {consent.whatsapp.marketing ? "✓" : "✗"}</span>
          <span className={clsx("chip", consent.email.unsubscribed ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600")}>Email {consent.email.unsubscribed ? "unsubscribed" : consent.email.marketing ? "marketing ✓" : "1:1 only"}</span>
          {contact.doNotContact && <span className="chip bg-red-600 text-white">Do not contact</span>}
        </div>
      </section>

      {openTasks.length > 0 && (
        <section>
          <div className="label">Open tasks</div>
          <ul className="space-y-1 text-xs">
            {openTasks.map((t) => (
              <li key={t.id} className="flex justify-between gap-2">
                <span>{t.title}</span>
                <span className={clsx(t.dueAt && new Date(t.dueAt) < new Date() ? "text-red-600" : "text-slate-500")}>{ago(t.dueAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="label">Recent activity</div>
        <ul className="space-y-1.5 text-xs">
          {timeline.slice(0, 5).map((a) => (
            <li key={a.id}>
              <span className="font-medium">{ACTIVITY_LABEL[a.type] ?? a.type}</span> <span className="text-slate-500">{activityText(a, userNames)}</span>
              <div className="text-[11px] text-slate-400">{ago(a.occurredAt)}</div>
            </li>
          ))}
        </ul>
      </section>

      {history.length > 0 && (
        <section>
          <div className="label">Previous leads with this contact</div>
          <ul className="space-y-1 text-xs">
            {history.map((h) => (
              <li key={h.id}>
                <Link href={`/leads/${h.id}`} className="text-brand-600 hover:underline">
                  L-{h.number}
                </Link>{" "}
                <StageBadge stage={h.stage} /> <span className="text-slate-500">{dateTime(h.openedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href={`/leads/${lead.id}`} className="btn w-full">
        Open full lead →
      </Link>
    </div>
  );
}
