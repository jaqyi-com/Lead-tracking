"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, post, patch } from "@/lib/api";
import { useMeta } from "@/lib/hooks";
import { STAGE_LABEL } from "@/lib/format";
import { Modal } from "./ui";
import { useToast } from "./toast";

function useInvalidateLead(leadId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["lead", leadId] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
    qc.invalidateQueries({ queryKey: ["pipeline"] });
    qc.invalidateQueries({ queryKey: ["leads"] });
  };
}

const inDays = (d: number) => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setHours(11, 0, 0, 0);
  return t.toISOString().slice(0, 16);
};

export function StageDialog({ leadId, current, initial, onClose }: { leadId: string; current: string; initial?: string; onClose: () => void }) {
  const meta = useMeta();
  const toast = useToast();
  const done = useInvalidateLead(leadId);
  const [stage, setStage] = useState(initial ?? current);
  const [lostReason, setLostReason] = useState("");
  const [lostNote, setLostNote] = useState("");
  const [revisit, setRevisit] = useState(inDays(60));
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      post(`/api/leads/${leadId}/stage`, {
        stage,
        ...(stage === "lost" ? { lostReason, lostNote: lostNote || undefined } : {}),
        ...(stage === "nurture" ? { revisitAt: new Date(revisit).toISOString() } : {}),
      }),
    onSuccess: () => {
      toast(`Moved to ${STAGE_LABEL[stage]}`);
      done();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });
  return (
    <Modal title="Change stage" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1.5">
          {(meta.data?.stages ?? []).map((s) => (
            <button key={s} className={stage === s ? "btn-primary" : "btn"} onClick={() => setStage(s)} disabled={s === current}>
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
        {stage === "lost" && (
          <div className="space-y-2">
            <label className="label">Lost reason (required)</label>
            <select className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
              <option value="">Choose…</option>
              {meta.data?.lostReasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            <textarea className="input" rows={2} placeholder="Note (optional)" value={lostNote} onChange={(e) => setLostNote(e.target.value)} />
          </div>
        )}
        {stage === "nurture" && (
          <div>
            <label className="label">Revisit on</label>
            <div className="mb-2 flex gap-1">
              {[30, 60, 90].map((d) => (
                <button key={d} className="btn" onClick={() => setRevisit(inDays(d))}>
                  {d} days
                </button>
              ))}
            </div>
            <input type="datetime-local" className="input" value={revisit} onChange={(e) => setRevisit(e.target.value)} />
          </div>
        )}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={stage === current || m.isPending || (stage === "lost" && !lostReason)} onClick={() => m.mutate()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function NextStepDialog({ leadId, current, currentAt, onClose }: { leadId: string; current?: string | null; currentAt?: string | null; onClose: () => void }) {
  const toast = useToast();
  const done = useInvalidateLead(leadId);
  const [text, setText] = useState(current ?? "");
  const [at, setAt] = useState(currentAt ? new Date(currentAt).toISOString().slice(0, 16) : inDays(1));
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => patch(`/api/leads/${leadId}`, { nextStep: text, nextStepAt: new Date(at).toISOString() }),
    onSuccess: () => {
      toast("Next step saved");
      done();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });
  return (
    <Modal title="Next step" onClose={onClose}>
      <div className="space-y-3">
        <input className="input" placeholder="e.g. Send quote for 5,000 HR contacts" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        <div className="flex gap-1">
          {[
            ["Today 5pm", 0],
            ["Tomorrow", 1],
            ["In 2 days", 2],
            ["Next week", 7],
          ].map(([l, d]) => (
            <button key={l as string} className="btn" onClick={() => setAt(d === 0 ? new Date(new Date().setHours(17, 0, 0, 0)).toISOString().slice(0, 16) : inDays(d as number))}>
              {l}
            </button>
          ))}
        </div>
        <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!text.trim() || !at || m.isPending} onClick={() => m.mutate()}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function TaskDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const toast = useToast();
  const done = useInvalidateLead(leadId);
  const [title, setTitle] = useState("");
  const [at, setAt] = useState(inDays(1));
  const m = useMutation({
    mutationFn: () => post(`/api/leads/${leadId}/tasks`, { title, dueAt: new Date(at).toISOString() }),
    onSuccess: () => {
      toast("Task added");
      done();
      onClose();
    },
  });
  return (
    <Modal title="Add task" onClose={onClose}>
      <div className="space-y-3">
        <input className="input" placeholder="Task" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!title.trim() || m.isPending} onClick={() => m.mutate()}>
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SnoozeDialog({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [at, setAt] = useState(inDays(1));
  const m = useMutation({
    mutationFn: (until: string) => post(`/api/conversations/${conversationId}/snooze`, { until }),
    onSuccess: () => {
      toast("Snoozed");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      onClose();
    },
  });
  return (
    <Modal title="Snooze until" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {[
            ["3 hours", 3 / 24],
            ["Tomorrow", 1],
            ["In 3 days", 3],
            ["Next week", 7],
          ].map(([l, d]) => (
            <button key={l as string} className="btn" onClick={() => m.mutate(new Date(Date.now() + (d as number) * 86_400_000).toISOString())}>
              {l}
            </button>
          ))}
        </div>
        <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} />
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => m.mutate(new Date(at).toISOString())}>
            Snooze
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function AssignDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const meta = useMeta();
  const toast = useToast();
  const done = useInvalidateLead(leadId);
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => post(`/api/leads/${leadId}/assign`, { userId, reason }),
    onSuccess: () => {
      toast("Reassigned");
      done();
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });
  return (
    <Modal title="Reassign lead" onClose={onClose}>
      <div className="space-y-3">
        <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person…</option>
          {meta.data?.users
            .filter((u) => u.role === "rep" || u.role === "manager")
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.isAvailable ? "" : "(away)"}
              </option>
            ))}
        </select>
        <input className="input" placeholder="Reason (written to the timeline)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!userId || reason.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>
            Reassign
          </button>
        </div>
      </div>
    </Modal>
  );
}
