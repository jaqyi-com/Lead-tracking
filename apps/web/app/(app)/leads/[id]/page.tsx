"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ApiError, patch, post } from "@/lib/api";
import { useMe, useMeta, isManager } from "@/lib/hooks";
import { ago, dateTime, money } from "@/lib/format";
import { ChannelIcon, ScoreBadge, SourceLabel, StageBadge } from "@/components/ui";
import { ACTIVITY_LABEL, activityText, useLead, type LeadDetail } from "@/components/rail";
import { AssignDialog, NextStepDialog, StageDialog, TaskDialog } from "@/components/lead-actions";
import { useToast } from "@/components/toast";

export default function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useLead(id);
  const me = useMe();
  const [dialog, setDialog] = useState<null | "stage" | "next" | "task" | "assign">(null);
  if (q.isLoading) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (!q.data) return <div className="p-6 text-sm text-red-600">{q.error instanceof ApiError ? q.error.message : "Lead not found"}</div>;
  const d = q.data;
  const { lead, contact, company, owner } = d;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            L-{lead.number} · {contact.displayName ?? "Unknown"}
          </h1>
          <button onClick={() => setDialog("stage")}>
            <StageBadge stage={lead.stage} />
          </button>
          <ScoreBadge score={lead.score} />
          {lead.parseFailed && <span className="chip bg-amber-100 text-amber-800">Portal email didn't parse cleanly — check details</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            {d.conversations.map((c) => (
              <Link key={c.id} href={`/inbox?c=${c.id}`} className="btn">
                <ChannelIcon channel={c.channel} /> Open {c.channel === "whatsapp" ? "WhatsApp" : "email"}
              </Link>
            ))}
            <button className="btn" onClick={() => setDialog("next")}>
              Next step
            </button>
            <button className="btn" onClick={() => setDialog("task")}>
              Task
            </button>
            {isManager(me.data) && (
              <button className="btn" onClick={() => setDialog("assign")}>
                Reassign
              </button>
            )}
            <button className="btn-primary" onClick={() => setDialog("stage")}>
              Change stage
            </button>
          </div>
        </div>

        {d.duplicates.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Possible duplicate contact ({d.duplicates[0]!.reason}). A manager can merge it from Admin → Duplicates.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Qualification lead={lead} />
            <Timeline d={d} />
          </div>
          <div className="space-y-4">
            <section className="card space-y-2 p-4 text-sm">
              <h2 className="font-semibold">Contact</h2>
              <ContactEdit d={d} />
              <ul className="space-y-0.5 text-xs">
                {d.identities.map((i) => (
                  <li key={i.id}>
                    <span className="text-slate-400">{i.kind}</span> <span className="font-mono">{i.valueNormalised}</span> {i.verifiedState !== "unknown" && <span className="text-slate-500">({i.verifiedState})</span>}
                  </li>
                ))}
              </ul>
            </section>
            <section className="card space-y-1 p-4 text-sm">
              <h2 className="font-semibold">Deal</h2>
              <Row label="Owner">{owner?.name ?? <span className="text-red-600">Unassigned</span>}</Row>
              <Row label="Source">
                <SourceLabel source={lead.source} /> {lead.sourceDetail && <span className="text-slate-500">· {lead.sourceDetail}</span>}
              </Row>
              <Row label="Value">
                <ValueEdit leadId={lead.id} value={lead.valueEstimate} />
              </Row>
              <Row label="Next step">{lead.nextStep ? `${lead.nextStep} · ${dateTime(lead.nextStepAt)}` : <span className="text-amber-600">Not set</span>}</Row>
              <Row label="1st response">{lead.firstResponseBusinessMinutes != null ? `${lead.firstResponseBusinessMinutes} business min` : "—"}</Row>
              <Row label="Created">{dateTime(lead.createdAt)}</Row>
              {lead.lostReason && <Row label="Lost reason">{lead.lostReason}</Row>}
              {lead.revisitAt && <Row label="Revisit">{dateTime(lead.revisitAt)}</Row>}
              {company && (
                <Row label="Company">
                  {company.name} {company.industry && `· ${company.industry}`} {company.sizeBand && `· ${company.sizeBand}`}
                </Row>
              )}
              {lead.enquiry && <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">{lead.enquiry}</p>}
            </section>
            <Tasks d={d} />
            <Cadence d={d} />
            <Consent d={d} />
          </div>
        </div>
      </div>
      {dialog === "stage" && <StageDialog leadId={lead.id} current={lead.stage} onClose={() => setDialog(null)} />}
      {dialog === "next" && <NextStepDialog leadId={lead.id} current={lead.nextStep} currentAt={lead.nextStepAt} onClose={() => setDialog(null)} />}
      {dialog === "task" && <TaskDialog leadId={lead.id} onClose={() => setDialog(null)} />}
      {dialog === "assign" && <AssignDialog leadId={lead.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-xs text-slate-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function ValueEdit({ leadId, value }: { leadId: string; value: string | null }) {
  const qc = useQueryClient();
  const [v, setV] = useState(value ?? "");
  const [editing, setEditing] = useState(false);
  const m = useMutation({ mutationFn: () => patch(`/api/leads/${leadId}`, { valueEstimate: v ? Number(v) : null }), onSuccess: () => (setEditing(false), qc.invalidateQueries({ queryKey: ["lead", leadId] })) });
  if (!editing) return <button onClick={() => setEditing(true)} className="hover:underline">{money(value)}</button>;
  return (
    <span className="flex gap-1">
      <input className="input h-7 w-28" type="number" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <button className="btn h-7" onClick={() => m.mutate()}>
        Save
      </button>
    </span>
  );
}

function ContactEdit({ d }: { d: LeadDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ displayName: d.contact.displayName ?? "", jobTitle: d.contact.jobTitle ?? "", city: d.contact.city ?? "" });
  const dirty = f.displayName !== (d.contact.displayName ?? "") || f.jobTitle !== (d.contact.jobTitle ?? "") || f.city !== (d.contact.city ?? "");
  const m = useMutation({
    mutationFn: () => patch(`/api/contacts/${d.contact.id}`, { displayName: f.displayName, jobTitle: f.jobTitle || null, city: f.city || null }),
    onSuccess: () => {
      toast("Contact saved");
      qc.invalidateQueries({ queryKey: ["lead", d.lead.id] });
    },
  });
  return (
    <div className="space-y-1.5">
      <input className="input" value={f.displayName} placeholder="Name" onChange={(e) => setF({ ...f, displayName: e.target.value })} />
      <input className="input" value={f.jobTitle} placeholder="Job title" onChange={(e) => setF({ ...f, jobTitle: e.target.value })} />
      <input className="input" value={f.city} placeholder="City" onChange={(e) => setF({ ...f, city: e.target.value })} />
      {dirty && (
        <button className="btn-primary w-full" onClick={() => m.mutate()}>
          Save contact
        </button>
      )}
    </div>
  );
}

/** §3.3 qualification block: free to type any time, required before advancing past Engaged. */
function Qualification({ lead }: { lead: LeadDetail["lead"] }) {
  const meta = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, unknown>>(lead.qualification ?? {});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setValues(lead.qualification ?? {}), [lead.qualification]);
  const m = useMutation({
    mutationFn: () => patch(`/api/leads/${lead.id}`, { qualification: values }),
    onSuccess: () => {
      toast("Qualification saved");
      setError(null);
      qc.invalidateQueries({ queryKey: ["lead", lead.id] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });
  const fields = meta.data?.qualificationFields ?? [];
  const missing = fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === "" || values[f.key] === null));
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Qualification</h2>
        <span className={clsx("chip", missing.length ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800")}>{missing.length ? `${missing.length} required field(s) missing` : "Complete — ready for Qualified"}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
            <label className="label">
              {f.label}
              {f.required && <span className="text-red-500"> *</span>}
            </label>
            {f.type === "select" ? (
              <select className="input" value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">—</option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            ) : f.type === "boolean" ? (
              <div className="flex gap-1">
                {[true, false].map((b) => (
                  <button key={String(b)} className={values[f.key] === b ? "btn-primary" : "btn"} onClick={() => setValues({ ...values, [f.key]: b })}>
                    {b ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            ) : f.type === "textarea" ? (
              <textarea className="input" rows={2} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input
                className="input"
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                value={String(values[f.key] ?? "")}
                onChange={(e) => setValues({ ...values, [f.key]: f.type === "number" ? (e.target.value ? Number(e.target.value) : "") : e.target.value })}
              />
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex justify-end">
        <button className="btn-primary" onClick={() => m.mutate()} disabled={m.isPending}>
          Save qualification
        </button>
      </div>
    </section>
  );
}

function Timeline({ d }: { d: LeadDetail }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const add = useMutation({
    mutationFn: () => post(`/api/leads/${d.lead.id}/notes`, { body: note }),
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: ["lead", d.lead.id] });
    },
  });
  const notesById = new Map(d.notes.map((n) => [n.id, n]));
  return (
    <section className="card p-4">
      <h2 className="mb-3 font-semibold">Timeline</h2>
      <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
        <textarea className="input border-amber-300" rows={2} placeholder="Internal note (never sent to the client)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="mt-1 flex justify-end">
          <button className="btn" disabled={!note.trim()} onClick={() => add.mutate()}>
            Add note
          </button>
        </div>
      </div>
      <ol className="relative space-y-3 border-l border-slate-200 pl-4 dark:border-slate-700">
        {d.timeline.map((a) => {
          const n = a.type === "note_added" && typeof a.payload.noteId === "string" ? notesById.get(a.payload.noteId) : undefined;
          return (
            <li key={a.id} className="text-sm">
              <span className={clsx("absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white dark:border-slate-900", a.type.includes("breach") ? "bg-red-500" : a.type === "stage_changed" ? "bg-brand-500" : a.type.startsWith("message") ? "bg-emerald-500" : "bg-slate-300")} />
              <div>
                <span className="font-medium">{ACTIVITY_LABEL[a.type] ?? a.type.replace(/_/g, " ")}</span> <span className="text-slate-600 dark:text-slate-300">{activityText(a, d.userNames)}</span>
              </div>
              {n && <div className="mt-1 whitespace-pre-wrap rounded bg-amber-50 px-2 py-1 text-xs dark:bg-amber-950/50">{n.body}</div>}
              <div className="text-[11px] text-slate-400">
                {dateTime(a.occurredAt)} · {a.actorType === "user" ? (a.actorId ? d.userNames[a.actorId] : "user") : a.actorType === "phone_app" ? "WhatsApp phone app" : a.actorType}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Tasks({ d }: { d: LeadDetail }) {
  const qc = useQueryClient();
  const done = useMutation({ mutationFn: (id: string) => patch(`/api/tasks/${id}`, { completed: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", d.lead.id] }) });
  const open = d.tasks.filter((t) => !t.completedAt);
  return (
    <section className="card p-4 text-sm">
      <h2 className="mb-2 font-semibold">Tasks</h2>
      {open.length === 0 && <p className="text-xs text-slate-500">No open tasks.</p>}
      <ul className="space-y-1.5">
        {open.map((t) => (
          <li key={t.id} className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" onChange={() => done.mutate(t.id)} aria-label={`Complete ${t.title}`} />
            <span className="flex-1">{t.title}</span>
            <span className={clsx("text-xs", t.dueAt && new Date(t.dueAt) < new Date() ? "text-red-600" : "text-slate-500")}>{ago(t.dueAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Cadence({ d }: { d: LeadDetail }) {
  if (!d.enrollment) return null;
  const e = d.enrollment;
  return (
    <section className="card p-4 text-sm">
      <h2 className="mb-1 font-semibold">Follow-up sequence</h2>
      <p className="mb-2 text-xs text-slate-500">
        {e.state === "active" ? `Active · next step ${e.currentStep} ${ago(e.nextRunAt)}` : `${e.state}${e.stopReason ? ` (${e.stopReason.replace(/_/g, " ")})` : ""}`}
      </p>
      <ul className="space-y-1 text-xs">
        {e.events.map((ev) => (
          <li key={ev.id}>
            Step {ev.stepPosition}: <span className="font-medium">{ev.outcome.replace(/_/g, " ")}</span> {typeof ev.detail.reason === "string" && <span className="text-slate-500">— {ev.detail.reason}</span>}
            <span className="text-slate-400"> · {ago(ev.occurredAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Consent({ d }: { d: LeadDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ action: "grant", channel: "all", purpose: "marketing", evidence: "" });
  const m = useMutation({
    mutationFn: () => post(`/api/contacts/${d.contact.id}/consent`, f),
    onSuccess: () => {
      toast("Consent recorded");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["lead", d.lead.id] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Failed", "error"),
  });
  return (
    <section className="card p-4 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">Consent ledger</h2>
        <button className="btn-ghost text-xs" onClick={() => setOpen(!open)}>
          Record…
        </button>
      </div>
      {open && (
        <div className="mb-3 space-y-2 rounded-md bg-slate-50 p-2 dark:bg-slate-800/50">
          <div className="grid grid-cols-3 gap-1">
            <select className="input" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
              <option value="grant">Grant</option>
              <option value="withdraw">Withdraw</option>
            </select>
            <select className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="all">All</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </select>
            <select className="input" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
              <option value="marketing">Marketing</option>
              <option value="utility">Utility</option>
              <option value="all">All</option>
            </select>
          </div>
          <input className="input" placeholder="Evidence (how and when the person agreed)" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
          <button className="btn-primary w-full" disabled={f.evidence.length < 5} onClick={() => m.mutate()}>
            Save to ledger
          </button>
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {d.consent.records.map((r) => (
          <li key={r.id}>
            <span className={r.state === "granted" ? "text-emerald-600" : "text-red-600"}>{r.state}</span> · {r.channel}/{r.purpose} · {r.basis.replace(/_/g, " ")}
            <span className="text-slate-400"> · {dateTime(r.capturedAt)}</span>
          </li>
        ))}
        {d.consent.records.length === 0 && <li className="text-slate-500">No records.</li>}
      </ul>
    </section>
  );
}
