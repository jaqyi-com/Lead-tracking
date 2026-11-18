"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Me = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "rep" | "viewer" | "service";
  teamId: string | null;
  totpEnabled: boolean;
  isAvailable: boolean;
  mailbox: { email: string; status: string } | null;
  vapidPublicKey: string | null;
  googleSso: boolean;
};

export function useMe() {
  return useQuery<Me>({ queryKey: ["me"], queryFn: () => api("/api/me"), staleTime: 60_000, retry: false });
}

export type Meta = {
  stages: string[];
  openStages: string[];
  lostReasons: { key: string; label: string }[];
  users: { id: string; name: string; role: string; isAvailable: boolean }[];
  sources: { key: string; label: string }[];
  qualificationFields: { key: string; label: string; type: string; options?: string[]; required: boolean }[];
};

export function useMeta() {
  return useQuery<Meta>({ queryKey: ["meta"], queryFn: () => api("/api/meta"), staleTime: 5 * 60_000 });
}

export const isManager = (me?: Me) => me?.role === "admin" || me?.role === "manager";

/**
 * Keyboard-first (§8.2). Single keys and "g x" chords; ignored while typing in inputs.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  const chord = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        if (e.key === "Escape") (t as HTMLInputElement).blur();
        return;
      }
      const key = chord.current ? `${chord.current} ${e.key}` : e.key;
      if (!chord.current && e.key === "g") {
        chord.current = "g";
        chordTimer.current = setTimeout(() => (chord.current = null), 800);
        return;
      }
      chord.current = null;
      if (chordTimer.current) clearTimeout(chordTimer.current);
      const fn = map[key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Re-render every `ms` (countdowns). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
