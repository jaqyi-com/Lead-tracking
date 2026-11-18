"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, ApiError, del, patch, post } from "@/lib/api";
import { useMe, useMeta } from "@/lib/hooks";
import { ago, dateTime, money } from "@/lib/format";
import { Modal } from "@/components/ui";
import { useToast } from "@/components/toast";

const TABS = ["Team", "Routing", "Hours & SLA", "Templates", "Sequences", "Broadcasts", "Import", "Queue health", "Parser queue", "Duplicates", "Data requests", "Audit"] as const;
type Tab = (typeof TABS)[number];

function useErr() {
  const toast = useToast();
  return (e: unknown) => toast(e instanceof ApiError ? e.message : "Failed", "error");
}

function AdminInner() {
  const router = useRouter();
  const params = useSearchParams();
  const me = useMe();
  const tab = (params.get("tab") as Tab) ?? "Team";
  if (me.data && me.data.role !== "admin" && me.data.role !== "manager") return <p className="p-6 text-sm">Managers and admins only.</p>;
  return (
    <div className="flex h-full">
      <nav className="w-48 shrink-0 space-y-0.5 overflow-y-auto border-r border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
        {TABS.map((t) => (
          <button key={t} onClick={() => router.replace(`/admin?tab=${encodeURIComponent(t)}`)} className={clsx("block w-full rounded-md px-3 py-1.5 text-left text-sm", tab === t ? "bg-slate-100 font-medium dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/50")}>
            {t}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-4 text-xl font-semibold">{tab}</h1>
          {tab === "Team" && <TeamTab />}
          {tab === "Routing" && <RoutingTab />}
          {tab === "Hours & SLA" && <HoursTab />}
          {tab === "Templates" && <TemplatesTab />}
          {tab === "Sequences" && <SequencesTab />}
          {tab === "Broadcasts" && <BroadcastsTab />}
          {tab === "Import" && <ImportTab />}
          {tab === "Queue health" && <QueueTab />}
          {tab === "Parser queue" && <ParserTab />}
          {tab === "Duplicates" && <DuplicatesTab />}
          {tab === "Data requests" && <DataRequestsTab />}
          {tab === "Audit" && <AuditTab />}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <Suspense>
      <AdminInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------

function TeamTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const me = useMe();
  const q = useQuery({ queryKey: ["admin-users"], queryFn: () => api<{ items: any[]; teams: any[] }>("/api/admin/users") });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", email: "", role: "rep", password: "", capacity: 60 });
  const save = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patch(`/api/admin/users/${id}`, body), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }), onError: onErr });
  const create = useMutation({ mutationFn: () => post("/api/admin/users", { ...f, teamId: q.data?.teams[0]?.id, password: f.password || undefined }), onSuccess: () => (setAdding(false), qc.invalidateQueries({ queryKey: ["admin-users"] })), onError: onErr });
  const isAdmin = me.data?.role === "admin";
  return (
    <div className="space-y-3">
      {isAdmin && (
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Add user
        </button>
      )}
      <div className="card overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr>
              {["Name", "Role", "Available", "Open leads / cap", "2FA", "Active"].map((h) => (
                <th key={h} className="th">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {q.data?.items.map((u) => (
              <tr key={u.id}>
                <td className="td">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className="td">
                  <select className="input h-8 w-auto" disabled={!isAdmin} value={u.role} onChange={(e) => save.mutate({ id: u.id, body: { role: e.target.value } })}>
                    {["admin", "manager", "rep", "viewer", "service"].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td className="td">
                  <input type="checkbox" disabled={!isAdmin} checked={u.isAvailable} onChange={(e) => save.mutate({ id: u.id, body: { isAvailable: e.target.checked } })} />
                </td>
                <td className="td tabular-nums">
                  {u.openLeads} /{" "}
                  <input className="input inline h-7 w-16" type="number" disabled={!isAdmin} defaultValue={u.capacity} onBlur={(e) => Number(e.target.value) !== u.capacity && save.mutate({ id: u.id, body: { capacity: Number(e.target.value) } })} />
                </td>
                <td className="td text-xs">{u.totpEnabled ? "✓" : u.role === "admin" ? <span className="text-red-600">required</span> : "—"}</td>
                <td className="td">
                  <input type="checkbox" disabled={!isAdmin} checked={u.active} onChange={(e) => save.mutate({ id: u.id, body: { active: e.target.checked } })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Add user" onClose={() => setAdding(false)}>
          <div className="space-y-2">
            <input className="input" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input className="input" placeholder="Work email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {["rep", "manager", "admin", "viewer"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <input className="input" type="password" placeholder="Initial password (min 10 chars) — or leave empty for Google SSO only" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <div className="flex justify-end">
              <button className="btn-primary" disabled={!f.name || !f.email || (!!f.password && f.password.length < 10)} onClick={() => create.mutate()}>
                Create
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RoutingTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const meta = useMeta();
  const toast = useToast();
  const q = useQuery({ queryKey: ["routing"], queryFn: () => api<{ items: any[] }>("/api/admin/routing-rules") });
  const [edit, setEdit] = useState<any | null>(null);
  const [test, setTest] = useState({ source: "whatsapp_inbound", city: "", text: "" });
  const [testResult, setTestResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (r: any) => {
      const body = { name: r.name, priority: Number(r.priority), strategy: r.strategy, targetUserId: r.targetUserId || null, targetTeamId: r.targetTeamId || null, fallback: r.fallback, active: r.active, conditions: r.conditions };
      return r.id ? patch(`/api/admin/routing-rules/${r.id}`, body) : post("/api/admin/routing-rules", body);
    },
    onSuccess: () => (setEdit(null), qc.invalidateQueries({ queryKey: ["routing"] }), toast("Rule saved")),
    onError: onErr,
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/api/admin/routing-rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["routing"] }) });
  const runTest = useMutation({
    mutationFn: () => post<{ ownerName: string | null; rule: string }>("/api/admin/routing-rules/test", { source: test.source, city: test.city || undefined, text: test.text || undefined }),
    onSuccess: (r) => setTestResult(`${r.ownerName ?? "Unassigned"} — via "${r.rule}"`),
  });
  const csv = (v?: string[]) => (v ?? []).join(", ");
  const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">Sticky owner always wins first. Then rules run top-down by priority; the first match assigns. Leads nobody can take sit in Unassigned and the after-hours acknowledgement goes out.</p>
      <button className="btn-primary" onClick={() => setEdit({ name: "", priority: 100, strategy: "round_robin", fallback: "next_rule", active: true, conditions: {} })}>
        + Add rule
      </button>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {q.data?.items.map((r) => (
          <div key={r.id} className="flex items-center gap-3 p-3 text-sm">
            <span className="kbd">{r.priority}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {r.name} {!r.active && <span className="chip bg-slate-200">off</span>}
              </div>
              <div className="text-xs text-slate-500">
                {Object.entries(r.conditions).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : v}`).join(" · ") || "matches everything"} → {r.strategy.replace(/_/g, " ")}
                {r.targetUserId && ` (${meta.data?.users.find((u) => u.id === r.targetUserId)?.name ?? "user"})`} · fallback {r.fallback.replace(/_/g, " ")}
              </div>
            </div>
            <button className="btn" onClick={() => setEdit(r)}>
              Edit
            </button>
            <button className="btn" onClick={() => remove.mutate(r.id)}>
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="card space-y-2 p-4">
        <div className="text-sm font-semibold">Test routing</div>
        <div className="flex flex-wrap gap-2">
          <select className="input w-auto" value={test.source} onChange={(e) => setTest({ ...test, source: e.target.value })}>
            {(meta.data?.sources as any[] | undefined)?.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <input className="input w-40" placeholder="City" value={test.city} onChange={(e) => setTest({ ...test, city: e.target.value })} />
          <input className="input w-64" placeholder="Message text" value={test.text} onChange={(e) => setTest({ ...test, text: e.target.value })} />
          <button className="btn" onClick={() => runTest.mutate()}>
            Who gets it?
          </button>
        </div>
        {testResult && <p className="text-sm">→ {testResult}</p>}
      </div>
      {edit && (
        <Modal title={edit.id ? "Edit rule" : "New rule"} onClose={() => setEdit(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label">Name</label>
              <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Priority (lower runs first)</label>
              <input className="input" type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} />
            </div>
            <div>
              <label className="label">Strategy</label>
              <select className="input" value={edit.strategy} onChange={(e) => setEdit({ ...edit, strategy: e.target.value })}>
                <option value="round_robin">Round robin (capacity + working hours)</option>
                <option value="specific_user">Specific person</option>
                <option value="unassigned">Leave unassigned</option>
              </select>
            </div>
            {edit.strategy === "specific_user" && (
              <div>
                <label className="label">Person</label>
                <select className="input" value={edit.targetUserId ?? ""} onChange={(e) => setEdit({ ...edit, targetUserId: e.target.value })}>
                  <option value="">Choose…</option>
                  {meta.data?.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="label">If nobody is available</label>
              <select className="input" value={edit.fallback} onChange={(e) => setEdit({ ...edit, fallback: e.target.value })}>
                <option value="next_rule">Try the next rule</option>
                <option value="unassigned">Leave unassigned</option>
              </select>
            </div>
            {(["sources", "keywords", "cities", "states", "languages", "sizeBands"] as const).map((k) => (
              <div key={k}>
                <label className="label">{k} (comma-separated)</label>
                <input className="input" defaultValue={csv(edit.conditions[k])} onBlur={(e) => setEdit({ ...edit, conditions: { ...edit.conditions, [k]: parseCsv(e.target.value).length ? parseCsv(e.target.value) : undefined } })} />
              </div>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button className="btn-primary" disabled={!edit.name} onClick={() => save.mutate(edit)}>
              Save rule
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function HoursTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const toast = useToast();
  const hours = useQuery({ queryKey: ["hours"], queryFn: () => api<{ items: any[]; holidays: any[] }>("/api/admin/business-hours") });
  const sla = useQuery({ queryKey: ["sla"], queryFn: () => api<{ items: any[] }>("/api/admin/sla-policies") });
  const [hol, setHol] = useState({ day: "", name: "" });
  const bh = hours.data?.items[0];
  const [weekly, setWeekly] = useState<Record<string, [string, string][]> | null>(null);
  const w = weekly ?? bh?.weekly ?? {};
  const saveHours = useMutation({ mutationFn: () => patch(`/api/admin/business-hours/${bh.id}`, { weekly: w }), onSuccess: () => (toast("Hours saved"), qc.invalidateQueries({ queryKey: ["hours"] })), onError: onErr });
  const addHol = useMutation({ mutationFn: () => post("/api/admin/holidays", hol), onSuccess: () => (setHol({ day: "", name: "" }), qc.invalidateQueries({ queryKey: ["hours"] })), onError: onErr });
  const delHol = useMutation({ mutationFn: (id: string) => del(`/api/admin/holidays/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["hours"] }) });
  const saveSla = useMutation({ mutationFn: ({ id, targetMinutes }: { id: string; targetMinutes: number }) => patch(`/api/admin/sla-policies/${id}`, { targetMinutes }), onSuccess: () => (toast("SLA saved"), qc.invalidateQueries({ queryKey: ["sla"] })), onError: onErr });
  if (!bh) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="font-semibold">{bh.name}</div>
            <div className="text-xs text-slate-500">
              {bh.description} · {bh.openNow ? "open now" : "closed now"}
            </div>
          </div>
          <button className="btn-primary" onClick={() => saveHours.mutate()}>
            Save hours
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-7">
          {DAYS.map((d, i) => {
            const slot = w[String(i)]?.[0];
            return (
              <div key={d} className="rounded-md border border-slate-200 p-2 text-xs dark:border-slate-700">
                <label className="flex items-center gap-1 font-medium">
                  <input type="checkbox" checked={!!slot} onChange={(e) => setWeekly({ ...w, [String(i)]: e.target.checked ? [["09:30", "18:30"]] : [] })} /> {d}
                </label>
                {slot && (
                  <div className="mt-1 space-y-1">
                    <input className="input h-7 px-1 text-xs" type="time" value={slot[0]} onChange={(e) => setWeekly({ ...w, [String(i)]: [[e.target.value, slot[1]]] })} />
                    <input className="input h-7 px-1 text-xs" type="time" value={slot[1]} onChange={(e) => setWeekly({ ...w, [String(i)]: [[slot[0], e.target.value]] })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="card p-4">
        <div className="mb-2 font-semibold">Holidays (SLA clocks pause; no cadence sends)</div>
        <div className="mb-2 flex gap-2">
          <input className="input w-40" type="date" value={hol.day} onChange={(e) => setHol({ ...hol, day: e.target.value })} />
          <input className="input w-64" placeholder="Name (e.g. Diwali)" value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} />
          <button className="btn" disabled={!hol.day || !hol.name} onClick={() => addHol.mutate()}>
            Add
          </button>
        </div>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {hours.data?.holidays.map((h) => (
            <li key={h.id} className="flex justify-between rounded bg-slate-50 px-2 py-1 dark:bg-slate-800">
              <span>
                {h.day} — {h.name}
              </span>
              <button className="text-xs text-red-600" onClick={() => delHol.mutate(h.id)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="card p-4">
        <div className="mb-2 font-semibold">SLA targets (business minutes; warn at 50%, breach at 100%, auto-reassign at 200%)</div>
        <table className="min-w-full">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {sla.data?.items.map((p) => (
              <tr key={p.id}>
                <td className="td capitalize">{p.kind.replace(/_/g, " ")}</td>
                <td className="td capitalize text-slate-500">{p.stage}</td>
                <td className="td">
                  <input className="input h-8 w-24" type="number" defaultValue={p.targetMinutes} onBlur={(e) => Number(e.target.value) !== p.targetMinutes && saveSla.mutate({ id: p.id, targetMinutes: Number(e.target.value) })} /> min
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function TemplatesTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const toast = useToast();
  const q = useQuery({ queryKey: ["templates"], queryFn: () => api<{ items: any[] }>("/api/templates") });
  const [edit, setEdit] = useState<any | null>(null);
  const sync = useMutation({ mutationFn: () => post<{ updated: number; created: number }>("/api/admin/templates/sync"), onSuccess: (r) => (toast(`Synced: ${r.updated} updated, ${r.created} new`), qc.invalidateQueries({ queryKey: ["templates"] })), onError: onErr });
  const submit = useMutation({ mutationFn: (id: string) => post(`/api/admin/templates/${id}/submit`), onSuccess: () => (toast("Submitted to Meta"), qc.invalidateQueries({ queryKey: ["templates"] })), onError: onErr });
  const save = useMutation({
    mutationFn: (t: any) => (t.id ? patch(`/api/admin/templates/${t.id}`, { body: t.body, category: t.category, variables: t.variables, approvalStatus: t.approvalStatus }) : post("/api/admin/templates", t)),
    onSuccess: () => (setEdit(null), qc.invalidateQueries({ queryKey: ["templates"] })),
    onError: onErr,
  });
  const statusCls = (s: string) => (s === "approved" ? "bg-emerald-100 text-emerald-700" : s === "rejected" || s === "disabled" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800");
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => setEdit({ internalName: "", category: "utility", language: "en", body: "", variables: [] })}>
          + New template
        </button>
        <button className="btn" onClick={() => sync.mutate()}>
          Sync from Meta
        </button>
      </div>
      <p className="text-xs text-slate-500">Keep variables few, never make the whole message one variable, and categorise honestly — marketing sent as utility is a policy and billing violation.</p>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {q.data?.items.map((t) => (
          <div key={t.id} className="flex items-start gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium">
                {t.internalName} <span className="chip bg-slate-100 dark:bg-slate-800">{t.category}</span> <span className="chip bg-slate-100 dark:bg-slate-800">{t.language}</span> <span className={clsx("chip", statusCls(t.approvalStatus))}>{t.approvalStatus}</span>
                <span className="text-xs text-slate-400">used {t.usageCount}×</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">{t.body}</div>
              {t.rejectionReason && <div className="mt-1 text-xs text-red-600">Rejected: {t.rejectionReason}</div>}
            </div>
            <button className="btn" onClick={() => setEdit(t)}>
              Edit
            </button>
            {["draft", "rejected"].includes(t.approvalStatus) && (
              <button className="btn" onClick={() => submit.mutate(t.id)}>
                Submit
              </button>
            )}
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.internalName}` : "New template"} onClose={() => setEdit(null)} wide>
          <div className="space-y-2">
            {!edit.id && <input className="input" placeholder="internal_name (lowercase_underscores)" value={edit.internalName} onChange={(e) => setEdit({ ...edit, internalName: e.target.value })} />}
            <div className="flex gap-2">
              <select className="input w-auto" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
                <option value="utility">utility</option>
                <option value="marketing">marketing</option>
                <option value="authentication">authentication</option>
              </select>
              {edit.id && (
                <select className="input w-auto" value={edit.approvalStatus} onChange={(e) => setEdit({ ...edit, approvalStatus: e.target.value })} title="Set manually only for testing; Meta's webhook keeps this in sync">
                  {["draft", "pending", "approved", "rejected", "paused", "disabled"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>
            <textarea className="input font-mono" rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} placeholder="Hi {{1}}, …" />
            <div className="text-xs text-slate-500">Variables — source: contact.first_name, owner.first_name, company.name, lead.number, org.working_hours, or manual.</div>
            {[...new Set([...(edit.body as string).matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]!))].map((key) => {
              const v = edit.variables.find((x: any) => x.key === key) ?? { key };
              const setV = (patchV: any) => setEdit({ ...edit, variables: [...edit.variables.filter((x: any) => x.key !== key), { ...v, ...patchV }].sort((a: any, b: any) => Number(a.key) - Number(b.key)) });
              return (
                <div key={key} className="flex gap-2">
                  <span className="kbd w-12 text-center">{`{{${key}}}`}</span>
                  <input className="input" placeholder="source" value={v.source ?? ""} onChange={(e) => setV({ source: e.target.value })} />
                  <input className="input" placeholder="example (for Meta review)" value={v.example ?? ""} onChange={(e) => setV({ example: e.target.value })} />
                </div>
              );
            })}
            <div className="flex justify-end">
              <button className="btn-primary" onClick={() => save.mutate(edit)}>
                Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SequencesTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const q = useQuery({ queryKey: ["sequences"], queryFn: () => api<{ items: any[] }>("/api/admin/sequences") });
  const save = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => patch(`/api/admin/sequence-steps/${id}`, body), onSuccess: () => qc.invalidateQueries({ queryKey: ["sequences"] }), onError: onErr });
  const fmt = (m: number) => (m >= 1440 ? `Day ${Math.round(m / 1440)}` : `+${Math.round(m / 60)}h`);
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Enrollment starts at Attempting and stops on any client reply, a stage past Engaged, or close. WhatsApp steps use the free-form text when the window is open, the approved template when it's closed, and fall back to email if neither works. Quiet hours 09:00–20:00 contact time; one channel per day.
      </p>
      {q.data?.items.map((s) => (
        <div key={s.id} className="card">
          <div className="border-b border-slate-200 p-3 font-semibold dark:border-slate-800">
            {s.name} {s.isDefault && <span className="chip bg-brand-100 text-brand-700">default</span>}
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {s.steps.map((st: any) => (
              <div key={st.id} className="grid gap-2 p-3 text-sm md:grid-cols-[6rem_8rem_1fr]">
                <div>
                  <div className="font-medium">Step {st.position}</div>
                  <div className="text-xs text-slate-500">
                    {fmt(st.offsetMinutes)} {st.offsetBusiness && "(business)"}
                  </div>
                </div>
                <div className="text-xs">
                  <div className="font-medium">{st.action.replace(/_/g, " ")}</div>
                  <div className="text-slate-500">{st.channel.replace(/_/g, " ")}</div>
                  {st.templateInternalName && <div className="text-slate-500">template: {st.templateInternalName}</div>}
                </div>
                <div className="space-y-1">
                  {st.action === "task" && <input className="input" defaultValue={st.taskTitle ?? ""} onBlur={(e) => save.mutate({ id: st.id, body: { taskTitle: e.target.value } })} />}
                  {st.action === "send" && (
                    <>
                      <input className="input" placeholder="Email subject" defaultValue={st.emailSubject ?? ""} onBlur={(e) => save.mutate({ id: st.id, body: { emailSubject: e.target.value || null } })} />
                      <textarea className="input" rows={3} placeholder="Email body ({{first_name}}, {{owner}})" defaultValue={st.emailBody ?? ""} onBlur={(e) => save.mutate({ id: st.id, body: { emailBody: e.target.value || null } })} />
                      {st.channel !== "email" && <textarea className="input" rows={2} placeholder="WhatsApp free-form (used only while the window is open)" defaultValue={st.waBody ?? ""} onBlur={(e) => save.mutate({ id: st.id, body: { waBody: e.target.value || null } })} />}
                    </>
                  )}
                  {st.action === "move_to_nurture" && <div className="text-xs text-slate-500">Moves to Nurture with a {st.revisitDays}-day revisit task.</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BroadcastsTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const toast = useToast();
  const meta = useMeta();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<{ items: any[] }>("/api/templates") });
  const list = useQuery({ queryKey: ["broadcasts"], queryFn: () => api<{ items: any[] }>("/api/broadcasts") });
  const [f, setF] = useState({ name: "", templateId: "", stages: [] as string[], sources: [] as string[] });
  const [preview, setPreview] = useState<any | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; count: number } | null>(null);
  const [typed, setTyped] = useState("");
  const seg = { stages: f.stages.length ? f.stages : undefined, sources: f.sources.length ? f.sources : undefined };
  const doPreview = useMutation({ mutationFn: () => post("/api/broadcasts/preview", { templateId: f.templateId, segment: seg }), onSuccess: setPreview, onError: onErr });
  const create = useMutation({
    mutationFn: () => post<{ broadcast: any }>("/api/broadcasts", { name: f.name, templateId: f.templateId, segment: seg }),
    onSuccess: (r) => (qc.invalidateQueries({ queryKey: ["broadcasts"] }), setConfirm({ id: r.broadcast.id, count: r.broadcast.recipientCount })),
    onError: onErr,
  });
  const approve = useMutation({
    mutationFn: () => post(`/api/broadcasts/${confirm!.id}/approve`, { confirmation: typed }),
    onSuccess: () => (toast("Broadcast sending"), setConfirm(null), setTyped(""), qc.invalidateQueries({ queryKey: ["broadcasts"] })),
    onError: onErr,
  });
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <div className="font-semibold">New broadcast</div>
        <input className="input" placeholder="Name (e.g. Nov re-engagement — Gujarat coverage)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className="input" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
          <option value="">Template…</option>
          {templates.data?.items
            .filter((t) => t.approvalStatus === "approved")
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.internalName} ({t.category}, ₹{t.costPerMessage}/msg)
              </option>
            ))}
        </select>
        <div className="flex flex-wrap gap-1 text-xs">
          <span className="text-slate-500">Stages:</span>
          {meta.data?.stages.map((s) => (
            <button key={s} className={clsx("chip border", f.stages.includes(s) ? "border-brand-600 bg-brand-100" : "border-slate-300")} onClick={() => setF({ ...f, stages: toggle(f.stages, s) })}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 text-xs">
          <span className="text-slate-500">Sources:</span>
          {(meta.data?.sources as any[] | undefined)?.map((s) => (
            <button key={s.key} className={clsx("chip border", f.sources.includes(s.key) ? "border-brand-600 bg-brand-100" : "border-slate-300")} onClick={() => setF({ ...f, sources: toggle(f.sources, s.key) })}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={!f.templateId} onClick={() => doPreview.mutate()}>
            Preview recipients & cost
          </button>
          <button className="btn-primary" disabled={!preview || !f.name || preview.eligible === 0} onClick={() => create.mutate()}>
            Create for approval
          </button>
        </div>
        {preview && (
          <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800">
            <div>
              Segment: <b>{preview.segmentSize}</b> · eligible after consent checks: <b>{preview.eligible}</b> · estimated cost <b>{money(preview.estimatedCost)}</b> (₹{preview.ratePerMessage}/msg)
            </div>
            {Object.keys(preview.excluded).length > 0 && <div className="text-xs text-slate-500">Excluded: {Object.entries(preview.excluded).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ")}</div>}
            <div className="mt-2 whitespace-pre-wrap rounded bg-white p-2 text-xs dark:bg-slate-900">{preview.template.body}</div>
          </div>
        )}
      </section>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {list.data?.items.map((b) => (
          <div key={b.id} className="flex items-center gap-3 p-3 text-sm">
            <div className="flex-1">
              <div className="font-medium">{b.name}</div>
              <div className="text-xs text-slate-500">
                {b.recipientCount} recipients · {money(b.estimatedCost)} · {dateTime(b.createdAt)}
              </div>
            </div>
            <span className="chip bg-slate-100 dark:bg-slate-800">{b.status.replace(/_/g, " ")}</span>
            {b.status === "pending_approval" && (
              <button className="btn" onClick={() => setConfirm({ id: b.id, count: b.recipientCount })}>
                Approve…
              </button>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <Modal title="Confirm broadcast" onClose={() => setConfirm(null)}>
          <p className="mb-3 text-sm">
            This sends a WhatsApp template to <b>{confirm.count}</b> people. Consent is re-checked for every recipient at send time. Type <span className="kbd">SEND {confirm.count}</span> to confirm.
          </p>
          <input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          <div className="mt-3 flex justify-end">
            <button className="btn-danger" disabled={typed !== `SEND ${confirm.count}`} onClick={() => approve.mutate()}>
              Send broadcast
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ImportTab() {
  const onErr = useErr();
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<any | null>(null);
  const run = useMutation({ mutationFn: (dryRun: boolean) => post("/api/admin/import", { csv, dryRun }), onSuccess: setReport, onError: onErr });
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Columns: <code>name, email, phone, company, job_title, city, source, stage, owner_email, value, notes, next_step, next_step_date</code>. Contacts are matched on phone/email; imported leads don't trigger acknowledgements or cadences.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setCsv(await f.text());
        }}
      />
      <textarea className="input font-mono text-xs" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="…or paste CSV here" />
      <div className="flex gap-2">
        <button className="btn" disabled={!csv} onClick={() => run.mutate(true)}>
          Dry run
        </button>
        <button className="btn-primary" disabled={!report || report.created !== 0 || !!report.errors?.length || !csv} onClick={() => run.mutate(false)} title="Run a clean dry run first">
          Import
        </button>
      </div>
      {report && (
        <div className="card p-3 text-sm">
          {report.total} rows · {report.valid} valid · {report.created} created · {report.attached} attached to existing leads
          {report.errors.length > 0 && (
            <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-red-600">
              {report.errors.map((e: any) => (
                <li key={e.row}>
                  Row {e.row}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function QueueTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["queue"], queryFn: () => api<any>("/api/admin/queue-health"), refetchInterval: 15_000 });
  const replay = useMutation({ mutationFn: (id: string) => post(`/api/admin/webhook-events/${id}/replay`), onSuccess: () => (toast("Replay queued"), qc.invalidateQueries({ queryKey: ["queue"] })) });
  const d = q.data;
  if (!d) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-3 text-sm">
          Unprocessed webhooks <div className="text-2xl font-semibold">{d.webhooks.unprocessed}</div>
          {d.webhooks.oldest_unprocessed && <div className="text-xs text-slate-500">oldest {ago(d.webhooks.oldest_unprocessed)}</div>}
        </div>
        <div className="card p-3 text-sm">
          Failing <div className={clsx("text-2xl font-semibold", d.webhooks.failing && "text-red-600")}>{d.webhooks.failing}</div>
        </div>
        <div className="card p-3 text-sm">
          Outbound queue <div className="text-2xl font-semibold">{d.messages.outbound_queue}</div>
        </div>
        <div className="card p-3 text-sm">
          Failed sends (24h) <div className="text-2xl font-semibold">{d.messages.failed_24h}</div>
        </div>
      </div>
      <section className="card p-3 text-sm">
        <div className="mb-1 font-semibold">Gmail mailboxes</div>
        {d.mailboxes.length === 0 && <p className="text-xs text-slate-500">None connected. Reps connect from Settings.</p>}
        {d.mailboxes.map((m: any) => (
          <div key={m.email} className="text-xs">
            {m.email} — {m.status} · watch expires {ago(m.watchExpiresAt)} {m.lastError && <span className="text-red-600">· {m.lastError}</span>}
          </div>
        ))}
      </section>
      <section className="card">
        <div className="border-b border-slate-200 p-3 text-sm font-semibold dark:border-slate-800">Webhook events with errors (dead letters)</div>
        {d.failedEvents.length === 0 && <p className="p-3 text-xs text-slate-500">None.</p>}
        {d.failedEvents.map((e: any) => (
          <div key={e.id} className="flex items-start gap-3 border-b border-slate-100 p-3 text-xs dark:border-slate-800">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {e.provider} · {e.externalId.slice(0, 60)} · {e.attempts} attempts · {ago(e.receivedAt)}
              </div>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-red-700">{e.error}</pre>
            </div>
            <button className="btn" onClick={() => replay.mutate(e.id)}>
              Replay
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

function ParserTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["parse-failures"], queryFn: () => api<{ items: any[] }>("/api/admin/parse-failures") });
  const resolve = useMutation({ mutationFn: (id: string) => post(`/api/admin/parse-failures/${id}/resolve`), onSuccess: () => qc.invalidateQueries({ queryKey: ["parse-failures"] }) });
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">Portal emails that didn't parse cleanly. The lead was still created (nothing is lost) — open it, fix the contact details, then resolve. Add the email to <code>fixtures/portal/</code> and fix the parser so it doesn't recur.</p>
      {q.data?.items.length === 0 && <p className="text-sm text-slate-500">Queue is empty.</p>}
      {q.data?.items.map((p) => (
        <div key={p.id} className="card p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="chip bg-amber-100 text-amber-800">{p.parser}</span>
            <span className="flex-1">{p.reason}</span>
            {p.leadId && (
              <a className="btn" href={`/leads/${p.leadId}`}>
                Open lead
              </a>
            )}
            <button className="btn" onClick={() => resolve.mutate(p.id)}>
              Resolve
            </button>
          </div>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-slate-500">Raw email</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{p.raw?.subject}{"\n\n"}{p.raw?.text}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}

function DuplicatesTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const q = useQuery({ queryKey: ["duplicates"], queryFn: () => api<{ items: any[] }>("/api/admin/duplicates") });
  const merge = useMutation({ mutationFn: ({ id, keep }: { id: string; keep: "a" | "b" }) => post(`/api/admin/duplicates/${id}/merge`, { keep }), onSuccess: () => qc.invalidateQueries({ queryKey: ["duplicates"] }), onError: onErr });
  const dismiss = useMutation({ mutationFn: (id: string) => post(`/api/admin/duplicates/${id}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ["duplicates"] }) });
  const side = (c: any, ids: any[]) => (
    <div className="rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-800">
      <div className="text-sm font-medium">{c.display_name ?? "—"}</div>
      <div className="text-slate-500">{[c.job_title, c.city].filter(Boolean).join(" · ")}</div>
      {(ids ?? []).map((i: any) => (
        <div key={i.kind + i.value} className="font-mono">
          {i.kind}: {i.value}
        </div>
      ))}
    </div>
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-300">The system never auto-merges on name similarity. Merging moves identities, leads, conversations and consent to the kept contact and writes an audit record.</p>
      {q.data?.items.length === 0 && <p className="text-sm text-slate-500">No suggestions.</p>}
      {q.data?.items.map((d) => (
        <div key={d.id} className="card space-y-2 p-3">
          <div className="text-xs text-slate-500">{d.reason}</div>
          <div className="grid grid-cols-2 gap-2">
            {side(d.a, d.a_identities)}
            {side(d.b, d.b_identities)}
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={() => merge.mutate({ id: d.id, keep: "a" })}>
              Keep left, merge right into it
            </button>
            <button className="btn" onClick={() => merge.mutate({ id: d.id, keep: "b" })}>
              Keep right
            </button>
            <button className="btn-ghost" onClick={() => dismiss.mutate(d.id)}>
              Not duplicates
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DataRequestsTab() {
  const qc = useQueryClient();
  const onErr = useErr();
  const me = useMe();
  const q = useQuery({ queryKey: ["data-requests"], queryFn: () => api<{ items: any[] }>("/api/admin/data-requests"), enabled: me.data?.role === "admin" });
  const [f, setF] = useState({ kind: "access", contactId: "", requesterEmail: "", details: "" });
  const create = useMutation({ mutationFn: () => post("/api/admin/data-requests", { ...f, contactId: f.contactId || undefined, requesterEmail: f.requesterEmail || undefined }), onSuccess: () => qc.invalidateQueries({ queryKey: ["data-requests"] }), onError: onErr });
  const complete = useMutation({
    mutationFn: ({ id, execute }: { id: string; execute: boolean }) => post<{ data: unknown }>(`/api/admin/data-requests/${id}/complete`, { resolution: execute ? "Executed from admin console" : "Handled manually", execute }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["data-requests"] });
      if (r.data) {
        const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "data-access-export.json";
        a.click();
      }
    },
    onError: onErr,
  });
  if (me.data?.role !== "admin") return <p className="text-sm">Admins only.</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">DPDP data-principal rights: access, correction, erasure and grievances, with a 30-day due date. Erasure anonymises in place so aggregate reports survive; the consent ledger and audit log are kept.</p>
      <section className="card grid gap-2 p-3 sm:grid-cols-4">
        <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {["access", "correction", "erasure", "grievance"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <input className="input" placeholder="Contact ID (from lead page URL)" value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })} />
        <input className="input" placeholder="Requester email" value={f.requesterEmail} onChange={(e) => setF({ ...f, requesterEmail: e.target.value })} />
        <button className="btn-primary" onClick={() => create.mutate()}>
          Log request
        </button>
      </section>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {q.data?.items.map((r) => (
          <div key={r.id} className="flex items-center gap-3 p-3 text-sm">
            <span className="chip bg-slate-100 dark:bg-slate-800">{r.kind}</span>
            <div className="flex-1">
              <div>{r.requesterEmail ?? r.contactId ?? "—"}</div>
              <div className="text-xs text-slate-500">
                logged {dateTime(r.requestedAt)} · due {dateTime(r.dueAt)} · {r.status}
              </div>
            </div>
            {r.status !== "done" && (
              <>
                {r.contactId && (r.kind === "erasure" || r.kind === "access") && (
                  <button className={r.kind === "erasure" ? "btn-danger" : "btn"} onClick={() => confirm(r.kind === "erasure" ? "Permanently anonymise this contact's data?" : "Export this contact's data?") && complete.mutate({ id: r.id, execute: true })}>
                    {r.kind === "erasure" ? "Erase now" : "Export data"}
                  </button>
                )}
                <button className="btn" onClick={() => complete.mutate({ id: r.id, execute: false })}>
                  Mark done
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditTab() {
  const me = useMe();
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<{ items: any[] }>("/api/admin/audit"), enabled: me.data?.role === "admin" });
  if (me.data?.role !== "admin") return <p className="text-sm">Admins only.</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr>
            {["When", "Actor", "Action", "Entity", "IP"].map((h) => (
              <th key={h} className="th">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
          {q.data?.items.map((a) => (
            <tr key={a.id}>
              <td className="td text-xs">{dateTime(a.at)}</td>
              <td className="td font-mono text-xs">{a.actorId?.slice(0, 8) ?? a.actorType}</td>
              <td className="td text-xs">{a.action}</td>
              <td className="td text-xs">
                {a.entity} {a.entityId?.slice(0, 8)}
              </td>
              <td className="td text-xs">{a.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
