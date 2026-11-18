"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";

export const REALTIME_ON = process.env.NEXT_PUBLIC_REALTIME !== "off";
/** Refetch intervals: relaxed with realtime, tighter when polling is the only update path. */
export const POLL_MS = { list: REALTIME_ON ? 30_000 : 8_000, thread: REALTIME_ON ? false : (5_000 as number | false), lead: REALTIME_ON ? false : (15_000 as number | false) };

type Ev = { type: string; leadId?: string; conversationId?: string; messageId?: string; data?: Record<string, unknown> };
type Viewer = { userId: string; name: string; typing: boolean };

const Ctx = createContext<{ socket: Socket | null; presence: Record<string, Viewer[]> }>({ socket: null, presence: {} });

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [presence, setPresence] = useState<Record<string, Viewer[]>>({});
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Serverless backends (Vercel) have no Socket.IO server; the app polls instead (see POLL_MS).
    if (!REALTIME_ON) return;
    const url = process.env.NEXT_PUBLIC_WS_URL || undefined;
    const s = io(url ?? "", { path: "/ws", withCredentials: true, transports: ["polling", "websocket"] });
    setSocket(s);

    // Coalesce bursts of events into one round of invalidations.
    const invalidate = (key: string) => {
      pending.current.add(key);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        for (const k of pending.current) qc.invalidateQueries({ queryKey: JSON.parse(k) });
        pending.current.clear();
        timer.current = null;
      }, 250);
    };

    s.on("event", (e: Ev) => {
      invalidate(JSON.stringify(["conversations"]));
      if (e.conversationId) invalidate(JSON.stringify(["conversation", e.conversationId]));
      if (e.leadId) invalidate(JSON.stringify(["lead", e.leadId]));
      if (e.type === "notification") invalidate(JSON.stringify(["notifications"]));
      if (e.type.startsWith("lead")) {
        invalidate(JSON.stringify(["leads"]));
        invalidate(JSON.stringify(["pipeline"]));
        invalidate(JSON.stringify(["my-day"]));
      }
      if (e.type === "notification" && typeof window !== "undefined" && document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(String(e.data?.title ?? "Doott Lead OS"));
      }
    });
    s.on("presence", (p: { conversationId: string; viewers: Viewer[] }) => setPresence((prev) => ({ ...prev, [p.conversationId]: p.viewers })));
    return () => {
      s.close();
    };
  }, [qc]);

  return <Ctx.Provider value={{ socket, presence }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
