/**
 * WebSocket gateway (§4.1): live inbox updates, viewing/typing presence, SLA countdowns.
 * Events carry ids only; clients refetch through the permission-checked REST API, so a socket can
 * never leak content a rep isn't allowed to see.
 */
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { env, logger } from "@lead/config";
import { REALTIME_CHANNEL, redisConnection, type RealtimeEvent } from "@lead/core";
import { userFromToken } from "./auth";

type Presence = { userId: string; name: string; conversationId: string; typing: boolean; at: number };

export function attachRealtime(server: HttpServer) {
  const io = new Server(server, {
    path: "/ws",
    cors: { origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : true, credentials: true },
  });
  const pub = redisConnection();
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));

  io.use(async (socket, next) => {
    const cookie = socket.handshake.headers.cookie ?? "";
    const token = cookie.split(/;\s*/).find((c) => c.startsWith("lead_sid="))?.slice("lead_sid=".length) ?? (socket.handshake.auth?.token as string | undefined);
    const s = await userFromToken(token ? decodeURIComponent(token) : undefined);
    if (!s || s.pendingTotp) return next(new Error("unauthenticated"));
    socket.data.user = s.user;
    next();
  });

  const presence = new Map<string, Presence>(); // socket.id → presence

  const broadcastPresence = (conversationId: string) => {
    const viewers = [...presence.values()].filter((p) => p.conversationId === conversationId && Date.now() - p.at < 60_000);
    io.to(`conv:${conversationId}`).emit("presence", { conversationId, viewers: viewers.map(({ userId, name, typing }) => ({ userId, name, typing })) });
  };

  io.on("connection", (socket) => {
    const user = socket.data.user as { id: string; name: string; role: string };
    socket.join(`user:${user.id}`);
    socket.join("org");

    socket.on("view", (conversationId: string) => {
      const prev = presence.get(socket.id);
      if (prev && prev.conversationId !== conversationId) {
        socket.leave(`conv:${prev.conversationId}`);
        presence.delete(socket.id);
        broadcastPresence(prev.conversationId);
      }
      if (!conversationId) return;
      socket.join(`conv:${conversationId}`);
      presence.set(socket.id, { userId: user.id, name: user.name, conversationId, typing: false, at: Date.now() });
      broadcastPresence(conversationId);
    });

    socket.on("typing", (typing: boolean) => {
      const p = presence.get(socket.id);
      if (!p) return;
      p.typing = !!typing;
      p.at = Date.now();
      broadcastPresence(p.conversationId);
    });

    socket.on("disconnect", () => {
      const p = presence.get(socket.id);
      presence.delete(socket.id);
      if (p) broadcastPresence(p.conversationId);
    });
  });

  // Fan out core events published by the API and the worker.
  const events = pub.duplicate();
  events.subscribe(REALTIME_CHANNEL).catch((err) => logger.error({ err }, "realtime subscribe failed"));
  events.on("message", (_channel, raw) => {
    let e: RealtimeEvent;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = { type: e.type, leadId: e.leadId, conversationId: e.conversationId, messageId: e.messageId, data: e.data };
    if (e.userIds?.length) for (const id of e.userIds) io.local.to(`user:${id}`).emit("event", payload);
    else io.local.to("org").emit("event", payload);
  });

  return io;
}
