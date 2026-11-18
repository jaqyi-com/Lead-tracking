"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, post } from "@/lib/api";
import { useMe, useMeta, isManager } from "@/lib/hooks";
import { ago, dateTime, money, STAGE_LABEL } from "@/lib/format";
import { Modal, ScoreBadge, SourceLabel, StageBadge } from "@/components/ui";
import { useToast } from "@/components/toast";

type Row = {
  id: string;
  number: number;
  stage: string;
  source: string;
  source_detail: string | null;
  score: number;
  value_estimate: string | null;
  owner_name: string | null;
  contact_name: string | null;
  company_name: string | null;
  created_at: string;
  last_activity_at: string;
  next_step: string | null;
  next_step_at: string | null;
  first_response_business_minutes: number | null;
  parse_failed: boolean;
};

function LeadsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const meta = useMeta();
  const [newOpen, setNewOpen] = useState(false);
  const qs = params.toString();
  const q = useQuery({ queryKey: ["leads", qs], queryFn: () => api<{ items: Row[]; total: number; page: number; pageSize: number }>(`/api/leads?${qs}`) });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    p.delete("page");
    router.replace(`/leads?${p}`);
  };
  const page = Number(params.get("page") ?? 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="mr-2 text-lg font-semibold">Leads</h1>
        <input className="input h-8 w-56" placeholder="Name, company, L-123…" defaultValue={params.get("q") ?? ""} onKeyDown={(e) => e.key === "Enter" && set("q", (e.target as HTMLInputElement).value)} />
        <select className="input h-8 w-auto" value={params.get("stage") ?? ""} onChange={(e) => set("stage", e.target.value)}>
          <option value="">All stages</option>
          {meta.data?.stages.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="input h-8 w-auto" value={params.get("source") ?? ""} onChange={(e) => set("source", e.target.value)}>
          <option value="">All sources</option>
          {(meta.data?.sources as { key: string; label: string }[] | undefined)?.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="input h-8 w-auto" value={params.get("owner") ?? ""} onChange={(e) => set("owner", e.target.value)}>
          <option value="">Any owner</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {isManager(me.data) &&
            meta.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
        <select className="input h-8 w-auto" value={params.get("open") ?? ""} onChange={(e) => set("open", e.target.value)}>
          <option value="">Open & closed</option>
          <option value="true">Open</option>
          <option value="false">Closed</option>
        </select>
        <select className="input h-8 w-auto" value={params.get("sort") ?? "recent"} onChange={(e) => set("sort", e.target.value)}>
          <option value="recent">Newest</option>
          <option value="score">Score</option>
          <option value="activity">Last activity</option>
          <option value="next_step">Next step due</option>
        </select>
        <div className="ml-auto flex gap-2">
          {me.data?.role === "admin" && (
            <a className="btn" href="/api/admin/export/leads.csv">
              Export CSV
            </a>
          )}
          <button className="btn-primary" onClick={() => setNewOpen(true)}>
            + New lead
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full">
          <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900">
            <tr>
              <th className="th">Lead</th>
              <th className="th">Contact</th>
              <th className="th">Stage</th>
              <th className="th">Source</th>
              <th className="th">Score</th>
              <th className="th">Owner</th>
              <th className="th">Value</th>
              <th className="th">Next step</th>
              <th className="th">1st response</th>
              <th className="th">Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-950">
            {q.data?.items.map((l) => (
              <tr key={l.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900" onClick={() => router.push(`/leads/${l.id}`)}>
                <td className="td font-medium">
                  <Link href={`/leads/${l.id}`}>L-{l.number}</Link>
                  {l.parse_failed && <span className="chip ml-1 bg-amber-100 text-amber-800">parse failed</span>}
                </td>
                <td className="td">
                  <div className="font-medium">{l.contact_name ?? "—"}</div>
                  <div className="text-xs text-slate-500">{l.company_name}</div>
                </td>
                <td className="td">
                  <StageBadge stage={l.stage} />
                </td>
                <td className="td text-xs">
                  <SourceLabel source={l.source} />
                </td>
                <td className="td">
                  <ScoreBadge score={l.score} />
                </td>
                <td className="td text-xs">{l.owner_name ?? <span className="text-red-600">Unassigned</span>}</td>
                <td className="td text-xs tabular-nums">{money(l.value_estimate)}</td>
                <td className="td text-xs">
                  {l.next_step ? (
                    <>
                      <div className="line-clamp-1">{l.next_step}</div>
                      <div className={l.next_step_at && new Date(l.next_step_at) < new Date() ? "text-red-600" : "text-slate-500"}>{dateTime(l.next_step_at)}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="td text-xs tabular-nums">{l.first_response_business_minutes != null ? `${l.first_response_business_minutes}m` : "—"}</td>
                <td className="td text-xs text-slate-500">{ago(l.last_activity_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data && q.data.items.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No leads match.</p>}
      </div>
      {q.data && q.data.total > q.data.pageSize && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-white p-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="text-slate-500">
            {(page - 1) * q.data.pageSize + 1}–{Math.min(page * q.data.pageSize, q.data.total)} of {q.data.total}
          </span>
          <button className="btn" disabled={page <= 1} onClick={() => router.replace(`/leads?${new URLSearchParams({ ...Object.fromEntries(params), page: String(page - 1) })}`)}>
            Prev
          </button>
          <button className="btn" disabled={page * q.data.pageSize >= q.data.total} onClick={() => router.replace(`/leads?${new URLSearchParams({ ...Object.fromEntries(params), page: String(page + 1) })}`)}>
            Next
          </button>
        </div>
      )}
      {newOpen && <NewLeadDialog onClose={() => setNewOpen(false)} />}
    </div>
  );
}

function NewLeadDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "", jobTitle: "", source: "manual", enquiry: "", consent: false, evidence: "" });
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      post<{ lead: { id: string } }>("/api/leads", {
        ...f,
        consent: f.consent ? { marketing: true, evidence: f.evidence } : undefined,
      }),
    onSuccess: (r) => {
      toast("Lead created");
      qc.invalidateQueries({ queryKey: ["leads"] });
      router.push(`/leads/${r.lead.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });
  const field = (k: keyof typeof f, label: string, type = "text") => (
    <div>
      <label className="label">{label}</label>
      <input className="input" type={type} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );
  return (
    <Modal title="New lead (manual entry)" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        {field("name", "Name")}
        {field("company", "Company")}
        {field("email", "Email", "email")}
        {field("phone", "Phone (WhatsApp)")}
        {field("jobTitle", "Job title")}
        <div>
          <label className="label">Source</label>
          <select className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            {(meta.data?.sources as { key: string; label: string }[] | undefined)?.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label">Enquiry</label>
          <textarea className="input" rows={3} value={f.enquiry} onChange={(e) => setF({ ...f, enquiry: e.target.value })} />
        </div>
        <label className="col-span-2 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} className="mt-1" />
          <span>The contact explicitly agreed to receive WhatsApp/email updates from Doott (not pre-ticked; record how).</span>
        </label>
        {f.consent && (
          <div className="col-span-2">
            <input className="input" placeholder="Evidence, e.g. 'Verbal consent on call 18 Nov, 3:10pm'" value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={(!f.email && !f.phone) || (f.consent && f.evidence.length < 3) || m.isPending} onClick={() => m.mutate()}>
          Create lead
        </button>
      </div>
    </Modal>
  );
}

export default function LeadsPage() {
  return (
    <Suspense>
      <LeadsInner />
    </Suspense>
  );
}
