"use client";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, patch } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { ago, dateTime } from "@/lib/format";
import { ChannelIcon, StageBadge } from "@/components/ui";

type Task = { id: string; title: string; due_at: string; lead_id: string | null; lead_number: number | null; contact_name: string | null };

export default function MyDayPage() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["my-day"],
    queryFn: () =>
      api<{
        overdue: Task[];
        today: Task[];
        slaRisk: { kind: string; breach_at: string; breached_at: string | null; lead_id: string; lead_number: number; contact_name: string; conversation_id: string | null }[];
        unanswered: { conversation_id: string; channel: string; last_message_at: string; last_message_preview: string; lead_number: number; contact_name: string }[];
        nextSteps: { lead_id: string; lead_number: number; next_step: string; next_step_at: string; stage: string; contact_name: string }[];
        missingNextStep: { id: string; number: number; stage: string }[];
      }>("/api/my-day"),
    refetchInterval: 60_000,
  });
  const done = useMutation({ mutationFn: (id: string) => patch(`/api/tasks/${id}`, { completed: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ["my-day"] }) });
  const d = q.data;
  const hour = new Date().getHours();

  const TaskList = ({ items, tone }: { items: Task[]; tone?: string }) => (
    <ul className="divide-y divide-ink-100 dark:divide-ink-800">
      {items.map((t) => (
        <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
          <input type="checkbox" onChange={() => done.mutate(t.id)} aria-label={`Complete ${t.title}`} />
          <span className="flex-1">
            {t.title}
            {t.lead_id && (
              <Link href={`/leads/${t.lead_id}`} className="ml-2 text-xs text-brand-600 hover:underline">
                L-{t.lead_number} {t.contact_name}
              </Link>
            )}
          </span>
          <span className={`text-xs ${tone ?? "text-ink-500"}`}>{dateTime(t.due_at)}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <h1 className="page-title">
          Good {hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, {me.data?.name.split(" ")[0]}
        </h1>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="card p-4">
            <h2 className="section-title mb-2 text-red-700 dark:text-red-400">SLA at risk ({d?.slaRisk.length ?? 0})</h2>
            {d?.slaRisk.length === 0 && <p className="text-sm text-ink-500">All clocks healthy.</p>}
            <ul className="space-y-1.5 text-sm">
              {d?.slaRisk.map((s) => (
                <li key={s.lead_id + s.kind}>
                  <Link href={s.conversation_id ? `/inbox?c=${s.conversation_id}` : `/leads/${s.lead_id}`} className="hover:underline">
                    L-{s.lead_number} {s.contact_name}
                  </Link>{" "}
                  <span className="text-xs text-ink-500">
                    {s.kind.replace(/_/g, " ")} · {s.breached_at ? "breached" : `due ${ago(s.breach_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-4">
            <h2 className="section-title mb-2">Waiting for your reply ({d?.unanswered.length ?? 0})</h2>
            {d?.unanswered.length === 0 && <p className="text-sm text-ink-500">Inbox zero.</p>}
            <ul className="space-y-1.5 text-sm">
              {d?.unanswered.map((u) => (
                <li key={u.conversation_id} className="flex items-start gap-2">
                  <ChannelIcon channel={u.channel} className="mt-1" />
                  <Link href={`/inbox?c=${u.conversation_id}`} className="min-w-0 flex-1 hover:underline">
                    <span className="font-medium">{u.contact_name}</span> <span className="text-ink-500">— {u.last_message_preview}</span>
                  </Link>
                  <span className="text-xs text-ink-400">{ago(u.last_message_at)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-4">
            <h2 className="section-title mb-2 text-red-700 dark:text-red-400">Overdue tasks ({d?.overdue.length ?? 0})</h2>
            {d && <TaskList items={d.overdue} tone="text-red-600" />}
          </section>
          <section className="card p-4">
            <h2 className="section-title mb-2">Today ({d?.today.length ?? 0})</h2>
            {d && <TaskList items={d.today} />}
          </section>
          <section className="card p-4 md:col-span-2">
            <h2 className="section-title mb-2">Next steps due</h2>
            <ul className="space-y-1.5 text-sm">
              {d?.nextSteps.map((n) => (
                <li key={n.lead_id} className="flex items-center gap-2">
                  <StageBadge stage={n.stage} />
                  <Link href={`/leads/${n.lead_id}`} className="hover:underline">
                    L-{n.lead_number} {n.contact_name}
                  </Link>
                  <span className="text-ink-500">— {n.next_step}</span>
                  <span className={`ml-auto text-xs ${new Date(n.next_step_at) < new Date() ? "text-red-600" : "text-ink-500"}`}>{dateTime(n.next_step_at)}</span>
                </li>
              ))}
            </ul>
            {!!d?.missingNextStep.length && (
              <p className="mt-3 text-sm text-amber-700">
                {d.missingNextStep.length} open lead(s) have no next step:{" "}
                {d.missingNextStep.map((l) => (
                  <Link key={l.id} href={`/leads/${l.id}`} className="mr-1 underline">
                    L-{l.number}
                  </Link>
                ))}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
