"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, ApiError, post } from "@/lib/api";
import { useHotkeys, useMe, isManager } from "@/lib/hooks";
import { POLL_MS, useRealtime } from "@/lib/realtime";
import { ago, dateTime } from "@/lib/format";
import { ChannelIcon, StageBadge } from "./ui";
import { Composer, type ComposerHandle } from "./composer";
import { ContextRail } from "./rail";
import { AssignDialog, NextStepDialog, SnoozeDialog, StageDialog, TaskDialog } from "./lead-actions";
import { useToast } from "./toast";

type Media = { id: string; filename: string | null; mime: string | null; url: string | null; status: string };
type Msg = {
  id: string;
  direction: "inbound" | "outbound";
  channel: string;
  authorType: string;
  authorName: string | null;
  kind: string;
  body: string | null;
  subject: string | null;
  status: string;
  errorMessage: string | null;
  isAuto: boolean;
  isAutoReply: boolean;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  sendAt: string | null;
  hasFullBody: boolean;
  media: Media[];
  pricingCategory: string | null;
};
type Note = { id: string; body: string; authorName: string; createdAt: string; conversationId: string | null };

export function Thread({ conversationId, onBack, onNext }: { conversationId: string; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const { socket, presence } = useRealtime();
  const composer = useRef<ComposerHandle>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<null | "stage" | "lost" | "next" | "task" | "snooze" | "assign">(null);

  const q = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () =>
      api<{
        conversation: { id: string; channel: "whatsapp" | "email"; subject: string | null; leadId: string; state: string; isJunk: boolean; unreadCount: number };
        lead: { id: string; number: number; stage: string; ownerId: string | null; nextStep: string | null; nextStepAt: string | null };
        window: { open: boolean; expiresAt: string | null } | null;
        messages: Msg[];
        notes: Note[];
      }>(`/api/conversations/${conversationId}`),
    refetchInterval: POLL_MS.thread,
  });

  const leadId = q.data?.lead.id;
  const convs = useQuery({
    queryKey: ["lead-convs", leadId],
    queryFn: () => api<{ items: { id: string; channel: string }[] }>(`/api/leads/${leadId}/conversations`),
    enabled: !!leadId,
  });

  useEffect(() => {
    socket?.emit("view", conversationId);
    return () => {
      socket?.emit("view", "");
    };
  }, [socket, conversationId]);

  useEffect(() => {
    if (q.data?.conversation.unreadCount) post(`/api/conversations/${conversationId}/read`).then(() => qc.invalidateQueries({ queryKey: ["conversations"] }));
  }, [q.data?.conversation.unreadCount, conversationId, qc]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [q.data?.messages.length, q.data?.notes.length]);

  const claim = useMutation({
    mutationFn: () => post(`/api/leads/${leadId}/claim`),
    onSuccess: () => {
      toast("Lead claimed — it's yours");
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Claim failed", "error"),
  });
  const setState = useMutation({
    mutationFn: (state: string) => post(`/api/conversations/${conversationId}/state`, { state }),
    onSuccess: (_d, state) => {
      toast(state === "closed" ? "Conversation closed" : "Updated");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      if (state === "closed") onNext();
    },
  });
  const junk = useMutation({
    mutationFn: (v: boolean) => post(`/api/conversations/${conversationId}/junk`, { junk: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });
  const startChannel = useMutation({
    mutationFn: (channel: string) => post<{ conversation: { id: string } }>(`/api/leads/${leadId}/conversations`, { channel }),
    onSuccess: (r) => (window.location.search = `?c=${r.conversation.id}`),
  });
  const retry = useMutation({
    mutationFn: (id: string) => post(`/api/messages/${id}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", conversationId] }),
    onError: (e) => toast(e instanceof ApiError ? e.message : "Retry failed", "error"),
  });

  useHotkeys(
    {
      r: () => composer.current?.focus(),
      t: () => composer.current?.openTemplates(),
      n: () => composer.current?.openNote(),
      a: () => q.data && !q.data.lead.ownerId && claim.mutate(),
      e: () => setState.mutate("closed"),
      s: () => setDialog("stage"),
    },
    [q.data],
  );

  const timeline = useMemo(() => {
    if (!q.data) return [];
    const items: ({ kind: "msg"; at: string; m: Msg } | { kind: "note"; at: string; n: Note })[] = [
      ...q.data.messages.map((m) => ({ kind: "msg" as const, at: m.createdAt, m })),
      ...q.data.notes.filter((n) => !n.conversationId || n.conversationId === conversationId).map((n) => ({ kind: "note" as const, at: n.createdAt, n })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [q.data, conversationId]);

  if (q.isLoading) return <div className="p-6 text-sm text-ink-500">Loading…</div>;
  if (q.isError || !q.data) return <div className="p-6 text-sm text-red-600">{q.error instanceof ApiError ? q.error.message : "Couldn't load conversation"}</div>;
  const { conversation, lead } = q.data;
  const viewers = (presence[conversationId] ?? []).filter((v) => v.userId !== me.data?.id);
  const ownedByOther = lead.ownerId && lead.ownerId !== me.data?.id && !isManager(me.data);
  const other = convs.data?.items.find((c) => c.channel !== conversation.channel);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 bg-white px-4 py-3">
          <button className="btn-ghost lg:hidden" onClick={onBack} aria-label="Back">
            ←
          </button>
          <ChannelIcon channel={conversation.channel} />
          <Link href={`/leads/${lead.id}`} className="font-display text-base font-bold text-ink-900 hover:text-brand-600">
            L-{lead.number}
          </Link>
          <button onClick={() => setDialog("stage")} title="Change stage (s)">
            <StageBadge stage={lead.stage} />
          </button>
          {other ? (
            <Link href={`/inbox?c=${other.id}`} className="btn-ghost text-xs">
              <ChannelIcon channel={other.channel} /> Switch to {other.channel === "whatsapp" ? "WhatsApp" : "email"}
            </Link>
          ) : (
            <button className="btn-ghost text-xs" onClick={() => startChannel.mutate(conversation.channel === "whatsapp" ? "email" : "whatsapp")}>
              + {conversation.channel === "whatsapp" ? "Email" : "WhatsApp"} this contact
            </button>
          )}
          {viewers.length > 0 && (
            <span className="chip bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
              {viewers.map((v) => `${v.name.split(" ")[0]} ${v.typing ? "is typing…" : "is viewing"}`).join(", ")}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1 [&_.btn]:h-8 [&_.btn]:px-2.5 [&_.btn]:text-xs [&_.btn-primary]:h-8 [&_.btn-primary]:text-xs">
            {!lead.ownerId && (
              <button className="btn-primary" onClick={() => claim.mutate()} title="Assign to me (a)">
                Claim
              </button>
            )}
            {isManager(me.data) && (
              <button className="btn" onClick={() => setDialog("assign")}>
                Reassign
              </button>
            )}
            <button className="btn" onClick={() => setDialog("next")} title="Set next step">
              Next step
            </button>
            <button className="btn" onClick={() => setDialog("task")}>
              Task
            </button>
            <button className="btn" onClick={() => setDialog("snooze")}>
              Snooze
            </button>
            <button className="btn" onClick={() => junk.mutate(!conversation.isJunk)}>
              {conversation.isJunk ? "Not junk" : "Junk"}
            </button>
            <button className="btn" onClick={() => setDialog("lost")}>
              Lost
            </button>
            {conversation.state !== "closed" ? (
              <button className="btn" onClick={() => setState.mutate("closed")} title="Close (e)">
                Close
              </button>
            ) : (
              <button className="btn" onClick={() => setState.mutate("open")}>
                Reopen
              </button>
            )}
          </div>
        </div>

        {viewers.some((v) => v.typing) && (
          <div className="bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">Someone else is composing a reply on this conversation.</div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-ink-50 px-4 py-5 lg:px-8">
          {timeline.map((item) =>
            item.kind === "note" ? (
              <div key={item.n.id} className="mx-auto max-w-2xl rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2.5 text-sm">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  Internal note · {item.n.authorName} · {dateTime(item.n.createdAt)}
                </div>
                <div className="whitespace-pre-wrap">{item.n.body}</div>
              </div>
            ) : (
              <MessageBubble key={item.m.id} m={item.m} onRetry={() => retry.mutate(item.m.id)} />
            ),
          )}
          <div ref={bottom} />
        </div>

        <Composer
          ref={composer}
          conversation={{ id: conversation.id, channel: conversation.channel, subject: conversation.subject, leadId: lead.id }}
          window={q.data.window}
          disabledReason={ownedByOther ? "This lead belongs to someone else. Ask a manager to reassign it, or add an internal note from the lead page." : null}
        />
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900 xl:block">
        <ContextRail leadId={lead.id} />
      </aside>

      {dialog === "stage" && <StageDialog leadId={lead.id} current={lead.stage} onClose={() => setDialog(null)} />}
      {dialog === "lost" && <StageDialog leadId={lead.id} current={lead.stage} initial="lost" onClose={() => setDialog(null)} />}
      {dialog === "next" && <NextStepDialog leadId={lead.id} current={lead.nextStep} currentAt={lead.nextStepAt} onClose={() => setDialog(null)} />}
      {dialog === "task" && <TaskDialog leadId={lead.id} onClose={() => setDialog(null)} />}
      {dialog === "snooze" && <SnoozeDialog conversationId={conversation.id} onClose={() => setDialog(null)} />}
      {dialog === "assign" && <AssignDialog leadId={lead.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function StatusTicks({ m }: { m: Msg }) {
  if (m.direction !== "outbound") return null;
  if (m.status === "failed") return <span className="text-red-500">failed</span>;
  if (m.status === "queued" && m.sendAt) return <span title={`Scheduled ${dateTime(m.sendAt)}`}>🕒 scheduled</span>;
  if (m.status === "queued" || m.status === "sending") return <span>sending…</span>;
  if (m.readAt) return <span className="text-sky-500" title={`Read ${dateTime(m.readAt)}`}>✓✓ read</span>;
  if (m.deliveredAt) return <span title={`Delivered ${dateTime(m.deliveredAt)}`}>✓✓</span>;
  return <span title={`Sent ${dateTime(m.sentAt)}`}>✓</span>;
}

function MessageBubble({ m, onRetry }: { m: Msg; onRetry: () => void }) {
  const out = m.direction === "outbound";
  const [full, setFull] = useState<string | null>(null);
  return (
    <div className={clsx("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm md:max-w-[68%]",
          out
            ? m.isAuto
              ? "rounded-br-md bg-ink-100 text-ink-700 ring-1 ring-ink-200"
              : "rounded-br-md bg-brand-600 text-white shadow-glow [&_a]:text-white"
            : "rounded-bl-md bg-white text-ink-900 shadow-card ring-1 ring-ink-200",
          m.status === "failed" && "ring-2 ring-red-400",
          m.isAutoReply && "opacity-70",
        )}
      >
        {(m.subject && m.channel === "email") && <div className={clsx("mb-1 text-xs font-semibold", out && !m.isAuto ? "text-white/90" : "text-ink-600")}>{m.subject}</div>}
        {m.media.map((a) =>
          a.url && a.mime?.startsWith("image/") ? (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
              <img src={a.url} alt={a.filename ?? "image"} className="mb-1 max-h-60 rounded-lg" />
            </a>
          ) : (
            <a key={a.id} href={a.url ?? undefined} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 rounded bg-black/5 px-2 py-1 text-xs underline dark:bg-white/10">
              📎 {a.filename ?? a.mime ?? "file"} {a.status !== "stored" && `(${a.status})`}
            </a>
          ),
        )}
        {m.body && <div className="whitespace-pre-wrap break-words">{full ?? m.body}</div>}
        {m.hasFullBody && !full && (
          <button className="mt-1 text-[11px] text-ink-500 underline" onClick={() => api<{ bodyFull: string }>(`/api/messages/${m.id}/full`).then((r) => setFull(r.bodyFull))}>
            Show full email
          </button>
        )}
        {m.status === "failed" && (
          <div className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
            {m.errorMessage}
            <button className="ml-2 underline" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        <div className={clsx("mt-1 flex items-center justify-end gap-2 text-[10px]", out && !m.isAuto ? "text-white/75" : "text-ink-400")}>
          {m.isAutoReply && <span>auto-reply</span>}
          {out && <span>{m.authorName ?? (m.isAuto ? "Automatic" : "")}</span>}
          {m.kind === "template" && <span className="chip bg-white/60 dark:bg-black/20">template{m.pricingCategory ? ` · ${m.pricingCategory}` : ""}</span>}
          <span title={dateTime(m.createdAt)}>{ago(m.createdAt)}</span>
          <StatusTicks m={m} />
        </div>
      </div>
    </div>
  );
}
