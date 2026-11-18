"use client";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, ApiError, post } from "@/lib/api";
import { useMe, useMeta, isManager } from "@/lib/hooks";
import { ago, money, STAGE_LABEL } from "@/lib/format";
import { ScoreBadge, SlaDot } from "@/components/ui";
import { StageDialog } from "@/components/lead-actions";
import { useToast } from "@/components/toast";

type Card = { id: string; number: number; stage: string; score: number; value_estimate: string | null; contact_name: string | null; company_name: string | null; owner_name: string | null; next_step: string | null; next_step_at: string | null; last_activity_at: string; sla_level: number | null };

export default function PipelinePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const meta = useMeta();
  const [owner, setOwner] = useState("");
  const [dragging, setDragging] = useState<Card | null>(null);
  const [needsDialog, setNeedsDialog] = useState<{ card: Card; stage: string } | null>(null);
  const q = useQuery({ queryKey: ["pipeline", owner], queryFn: () => api<{ columns: { stage: string; count: number; value: number; cards: Card[] }[] }>(`/api/pipeline${owner ? `?owner=${owner}` : ""}`) });

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) => post(`/api/leads/${id}/stage`, { stage }),
    onSuccess: (_r, v) => {
      toast(`Moved to ${STAGE_LABEL[v.stage]}`);
      qc.invalidateQueries({ queryKey: ["pipeline"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Move failed", "error"),
  });

  const drop = (stage: string) => {
    if (!dragging || dragging.stage === stage) return;
    // Lost needs a reason and Nurture a revisit date — open the dialog instead of failing.
    if (stage === "lost" || stage === "nurture") setNeedsDialog({ card: dragging, stage });
    else move.mutate({ id: dragging.id, stage });
    setDragging(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <select className="input h-8 w-auto" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{isManager(me.data) ? "Everyone" : "Mine + unassigned"}</option>
          <option value="me">Only mine</option>
          {isManager(me.data) &&
            meta.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </select>
        <span className="text-xs text-slate-500">Drag cards between columns. Past Engaged requires the qualification block.</span>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {q.data?.columns.map((col) => (
          <div
            key={col.stage}
            className={clsx("flex w-72 shrink-0 flex-col rounded-lg bg-slate-100 dark:bg-slate-900", dragging && dragging.stage !== col.stage && "ring-2 ring-brand-300")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(col.stage)}
          >
            <div className="flex items-baseline justify-between px-3 py-2">
              <span className="text-sm font-semibold">{STAGE_LABEL[col.stage]}</span>
              <span className="text-xs text-slate-500 tabular-nums">
                {col.count} · {money(col.value)}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {col.cards.map((c) => (
                <div key={c.id} draggable onDragStart={() => setDragging(c)} onDragEnd={() => setDragging(null)} className="card cursor-grab p-2.5 text-sm active:cursor-grabbing">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/leads/${c.id}`} className="truncate font-medium hover:underline">
                      {c.contact_name ?? `L-${c.number}`}
                    </Link>
                    <ScoreBadge score={c.score} />
                  </div>
                  <div className="truncate text-xs text-slate-500">{c.company_name ?? "—"}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                    <span>L-{c.number}</span>
                    <span>· {money(c.value_estimate)}</span>
                    <span>· {c.owner_name?.split(" ")[0] ?? "unassigned"}</span>
                    <SlaDot level={c.sla_level} />
                  </div>
                  {c.next_step && (
                    <div className={clsx("mt-1 line-clamp-1 text-[11px]", c.next_step_at && new Date(c.next_step_at) < new Date() ? "text-red-600" : "text-slate-600 dark:text-slate-300")}>
                      → {c.next_step} ({ago(c.next_step_at)})
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {needsDialog && <StageDialog leadId={needsDialog.card.id} current={needsDialog.card.stage} initial={needsDialog.stage} onClose={() => setNeedsDialog(null)} />}
    </div>
  );
}
