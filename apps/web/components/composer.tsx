"use client";
/**
 * §8.2 composer states. The system tells the rep what is allowed right now (§2 principle 3):
 *  - WhatsApp, window open  → free-form with a countdown chip
 *  - WhatsApp, window closed → free-form disabled; template picker with cost class + live preview
 *  - Email → subject, body, attachments, send later
 *  - Internal note → visually unmistakable, @mentions
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { api, ApiError, post, upload } from "@/lib/api";
import { useMeta, useNow } from "@/lib/hooks";
import { countdown } from "@/lib/format";
import { useRealtime } from "@/lib/realtime";
import { useToast } from "./toast";

type Template = { id: string; internalName: string; category: string; language: string; body: string; approvalStatus: string; costPerMessage: number; variables: { key: string; source?: string; example?: string }[] };
type Snippet = { id: string; shortcut: string; title: string; body: string; folder: string };

export type ComposerHandle = { focus: () => void; openTemplates: () => void; openNote: () => void };

type Props = {
  conversation: { id: string; channel: "whatsapp" | "email"; subject: string | null; leadId: string };
  window: { open: boolean; expiresAt: string | null } | null;
  disabledReason?: string | null;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ conversation, window: win, disabledReason }, ref) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(15_000);
  const { socket } = useRealtime();
  const meta = useMeta();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [snippetQuery, setSnippetQuery] = useState<string | null>(null);
  const [sendAt, setSendAt] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const msLeft = win?.expiresAt ? new Date(win.expiresAt).getTime() - now : 0;
  const waOpen = conversation.channel === "whatsapp" && msLeft > 0;
  const waClosed = conversation.channel === "whatsapp" && !waOpen;

  useImperativeHandle(ref, () => ({
    focus: () => {
      setMode("reply");
      setTimeout(() => taRef.current?.focus(), 0);
    },
    openTemplates: () => conversation.channel === "whatsapp" && setTemplateOpen(true),
    openNote: () => {
      setMode("note");
      setTimeout(() => taRef.current?.focus(), 0);
    },
  }));

  useEffect(() => {
    if (waClosed && mode === "reply") setTemplateOpen(true);
  }, [waClosed, mode]);

  const snippets = useQuery({ queryKey: ["snippets"], queryFn: () => api<{ items: Snippet[] }>("/api/snippets"), staleTime: 5 * 60_000 });

  const send = useMutation({
    mutationFn: async () => {
      if (mode === "note") return post(`/api/leads/${conversation.leadId}/notes`, { body: text, conversationId: conversation.id, mentions });
      return post(`/api/conversations/${conversation.id}/messages`, {
        type: conversation.channel === "email" ? "email" : files.length ? "media" : "text",
        body: text,
        subject: conversation.channel === "email" ? subject || undefined : undefined,
        attachmentIds: files.map((f) => f.id),
        sendAt: sendAt ? new Date(sendAt).toISOString() : undefined,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      setText("");
      setFiles([]);
      setSendAt("");
      setMentions([]);
      setError(null);
      qc.invalidateQueries({ queryKey: ["conversation", conversation.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["lead", conversation.leadId] });
      if (mode === "note") toast("Note added");
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Send failed"),
  });

  const onChange = (v: string) => {
    setText(v);
    const m = v.match(/(?:^|\s)\/(\w*)$/);
    setSnippetQuery(mode === "reply" && m ? m[1]! : null);
    if (socket) {
      socket.emit("typing", true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => socket.emit("typing", false), 2500);
    }
  };

  const insertSnippet = async (s: Snippet) => {
    const r = await api<{ body: string }>(`/api/snippets/render?id=${s.id}&leadId=${conversation.leadId}`);
    setText((t) => t.replace(/(?:^|\s)\/\w*$/, (m) => (m.startsWith(" ") ? " " : "") + r.body));
    setSnippetQuery(null);
    taRef.current?.focus();
  };

  const filteredSnippets = useMemo(
    () => (snippetQuery === null ? [] : (snippets.data?.items ?? []).filter((s) => s.shortcut.startsWith(snippetQuery) || s.title.toLowerCase().includes(snippetQuery.toLowerCase())).slice(0, 6)),
    [snippetQuery, snippets.data],
  );

  if (disabledReason) {
    return <div className="border-t border-ink-200 bg-ink-50 p-3 text-sm text-ink-600 dark:border-ink-800 dark:bg-ink-900">{disabledReason}</div>;
  }

  const canSend = text.trim().length > 0 || files.length > 0;
  const replyDisabled = mode === "reply" && waClosed;

  return (
    <div className={clsx("border-t px-4 py-3 lg:px-6", mode === "note" ? "border-amber-300 bg-amber-50" : "border-ink-200 bg-white")}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <button className={clsx("rounded-lg px-3 py-1.5 font-semibold transition", mode === "reply" ? "bg-brand-600 text-white shadow-glow" : "text-ink-600 hover:bg-ink-100")} onClick={() => setMode("reply")}>
          Reply
        </button>
        <button className={clsx("rounded-lg px-3 py-1.5 font-semibold transition", mode === "note" ? "bg-amber-500 text-white" : "text-ink-600")} onClick={() => setMode("note")}>
          Internal note
        </button>
        {mode === "reply" && conversation.channel === "whatsapp" && (
          <span className={clsx("chip ml-auto", waOpen ? (msLeft < 2 * 3600_000 ? "bg-amber-100 text-amber-800" : "bg-wa-50 text-wa-600") : "bg-ink-200 text-ink-700 dark:bg-ink-700 dark:text-ink-200")}>
            {waOpen ? `Window closes in ${countdown(msLeft)}` : "24h window closed — templates only"}
          </span>
        )}
        {mode === "note" && <span className="chip ml-auto bg-amber-200 text-amber-900">Internal only — never sent to the client</span>}
      </div>

      {mode === "reply" && conversation.channel === "email" && (
        <input className="input mb-2" placeholder={conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, "")}` : "Subject"} value={subject} onChange={(e) => setSubject(e.target.value)} />
      )}

      <div className="relative">
        <textarea
          ref={taRef}
          className={clsx("input min-h-[72px] resize-y", replyDisabled && "cursor-not-allowed opacity-60")}
          rows={3}
          disabled={replyDisabled}
          placeholder={
            replyDisabled
              ? "The client hasn't messaged in 24 hours. WhatsApp only allows an approved template now."
              : mode === "note"
                ? "Write an internal note… mention a teammate below"
                : "Type a reply… type / for snippets, ⌘↵ to send"
          }
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSend) send.mutate();
            if (e.key === "Escape") setSnippetQuery(null);
          }}
        />
        {filteredSnippets.length > 0 && (
          <div className="card absolute bottom-full left-0 z-20 mb-1 w-96 p-1">
            {filteredSnippets.map((s) => (
              <button key={s.id} className="block w-full rounded px-2 py-1.5 text-left hover:bg-ink-50 dark:hover:bg-ink-800" onClick={() => insertSnippet(s)}>
                <div className="text-sm font-medium">
                  /{s.shortcut} <span className="font-normal text-ink-500">— {s.title}</span>
                </div>
                <div className="line-clamp-1 text-xs text-ink-500">{s.body}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "note" && (
        <div className="mt-2 flex flex-wrap gap-1">
          {meta.data?.users.map((u) => (
            <button key={u.id} className={clsx("chip border", mentions.includes(u.id) ? "border-amber-600 bg-amber-200" : "border-amber-300 bg-white dark:bg-ink-900")} onClick={() => setMentions((m) => (m.includes(u.id) ? m.filter((x) => x !== u.id) : [...m, u.id]))}>
              @{u.name.split(" ")[0]}
            </button>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((f) => (
            <span key={f.id} className="chip bg-ink-100 dark:bg-ink-800">
              📎 {f.filename}
              <button onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))} aria-label="Remove">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {mode === "reply" && !replyDisabled && (
          <label className="btn-ghost cursor-pointer">
            📎 Attach
            <input
              type="file"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const a = await upload(f);
                  setFiles((x) => (conversation.channel === "whatsapp" ? [a] : [...x, a]));
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : "Upload failed");
                }
                e.target.value = "";
              }}
            />
          </label>
        )}
        {mode === "reply" && conversation.channel === "whatsapp" && (
          <button className="btn-ghost" onClick={() => setTemplateOpen(true)} title="Template (t)">
            🧩 Template
          </button>
        )}
        {mode === "reply" && conversation.channel === "email" && (
          <label className="flex items-center gap-1 text-xs text-ink-500">
            Send later
            <input type="datetime-local" className="input h-7 w-auto py-0 text-xs" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
          </label>
        )}
        <span className="ml-auto hidden text-[11px] text-ink-400 sm:inline">
          {mode === "reply" && conversation.channel === "whatsapp" ? "Each WhatsApp reply is billed — prefer one complete message." : ""}
        </span>
        <button className={mode === "note" ? "btn bg-amber-500 text-white hover:bg-amber-600" : "btn-primary"} disabled={!canSend || send.isPending || replyDisabled} onClick={() => send.mutate()}>
          {send.isPending ? "Sending…" : mode === "note" ? "Add note" : sendAt ? "Schedule" : "Send"}
        </button>
      </div>

      {templateOpen && <TemplatePicker conversationId={conversation.id} leadId={conversation.leadId} windowOpen={waOpen} onClose={() => setTemplateOpen(false)} />}
    </div>
  );
});

function TemplatePicker({ conversationId, leadId, windowOpen, onClose }: { conversationId: string; leadId: string; windowOpen: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<{ items: Template[] }>("/api/templates") });
  const [selected, setSelected] = useState<Template | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["tpl-preview", selected?.id, leadId],
    queryFn: () => api<{ values: Record<string, string>; preview: string }>(`/api/templates/${selected!.id}/preview?leadId=${leadId}`),
    enabled: !!selected,
  });
  useEffect(() => {
    if (preview.data) setValues(preview.data.values);
  }, [preview.data]);

  const rendered = selected ? selected.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => values[k] || m) : "";
  const send = useMutation({
    mutationFn: () => post(`/api/conversations/${conversationId}/messages`, { type: "template", templateId: selected!.id, templateValues: values, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast("Template sent");
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Failed"),
  });

  const approved = (templates.data?.items ?? []).filter((t) => t.approvalStatus === "approved");
  const others = (templates.data?.items ?? []).filter((t) => t.approvalStatus !== "approved");

  return (
    <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3 dark:border-ink-700 dark:bg-ink-800/50">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">{windowOpen ? "Send a template" : "Window closed — choose an approved template"}</span>
        <button className="btn-ghost text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
        <ul className="max-h-60 space-y-1 overflow-y-auto">
          {approved.map((t) => (
            <li key={t.id}>
              <button className={clsx("w-full rounded-md px-2 py-1.5 text-left text-sm", selected?.id === t.id ? "bg-brand-600 text-white" : "hover:bg-white dark:hover:bg-ink-700")} onClick={() => setSelected(t)}>
                <div className="font-medium">{t.internalName}</div>
                <div className={clsx("text-[11px]", selected?.id === t.id ? "text-white/80" : "text-ink-500")}>
                  {t.category} · ₹{t.costPerMessage.toFixed(4)}/msg{t.category === "marketing" ? " · needs opt-in" : ""}
                </div>
              </button>
            </li>
          ))}
          {others.length > 0 && <li className="px-2 pt-2 text-[11px] uppercase tracking-wide text-ink-400">Not approved yet</li>}
          {others.map((t) => (
            <li key={t.id} className="px-2 py-1 text-xs text-ink-400" title="Waiting for Meta approval">
              {t.internalName} — {t.approvalStatus}
            </li>
          ))}
        </ul>
        <div>
          {!selected && <p className="text-sm text-ink-500">Pick a template to preview it with this lead's details filled in.</p>}
          {selected && (
            <div className="space-y-2">
              {selected.variables.map((v) => (
                <div key={v.key} className="flex items-center gap-2">
                  <span className="kbd w-10 text-center">{`{{${v.key}}}`}</span>
                  <input className="input" value={values[v.key] ?? ""} placeholder={v.example} onChange={(e) => setValues((x) => ({ ...x, [v.key]: e.target.value }))} />
                </div>
              ))}
              <div className="whitespace-pre-wrap rounded-lg bg-wa-50 p-3 text-sm text-ink-800 dark:bg-emerald-950 dark:text-emerald-50">{rendered}</div>
              <div className="flex items-center justify-between gap-2">
                <span className={clsx("text-xs", selected.category === "marketing" ? "font-semibold text-amber-700" : "text-ink-500")}>
                  Cost class: {selected.category} (≈₹{selected.costPerMessage.toFixed(4)})
                  {selected.category === "marketing" ? " — about 7.5× a service message" : ""}
                </span>
                <button className="btn-primary" disabled={send.isPending || /\{\{\w+\}\}/.test(rendered)} onClick={() => send.mutate()}>
                  Send template
                </button>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
