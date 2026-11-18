/**
 * Vercel entry point: one serverless function serving both the API and the ingest endpoints.
 * Webhooks are stored and acknowledged first; processing runs via waitUntil after the response.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { env, logger } from "@lead/config";
import { ServerlessSink, background, maybeTick, processWebhookEvent, runTick, setEffectSink } from "@lead/core";
import { safeEqual } from "@lead/domain";
import { buildApi } from "./app";
import { buildIngest } from "../../ingest/src/app";

setEffectSink(new ServerlessSink());

let apps: Promise<{ api: FastifyInstance; ingest: FastifyInstance }> | undefined;

function getApps() {
  apps ??= (async () => {
    const ingest = await buildIngest({ enqueue: async (id) => background(processWebhookEvent(id)) });
    const api = await buildApi();
    // Scheduler endpoint for Vercel Cron (sends "Authorization: Bearer $CRON_SECRET") or any pinger.
    api.get("/api/cron/tick", async (req, reply) => {
      const secret = process.env.CRON_SECRET ?? "";
      const auth = req.headers.authorization ?? "";
      const q = (req.query as Record<string, string>).key ?? "";
      if (!secret || !(safeEqual(auth, `Bearer ${secret}`) || safeEqual(q, secret))) return reply.code(401).send({ error: "unauthorised" });
      return { ok: true, ran: await runTick({ heavy: true }) };
    });
    // Piggy-back scheduler: any API traffic keeps SLA timers and cadences moving (at most 1/min).
    api.addHook("onResponse", async (req) => {
      if (req.url.startsWith("/api/") && !req.url.startsWith("/api/cron")) background(maybeTick());
    });
    await Promise.all([ingest.ready(), api.ready()]);
    return { api, ingest };
  })();
  return apps;
}

const INGEST_PATHS = ["/webhooks/", "/intake/", "/unsubscribe/"];

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const { api, ingest } = await getApps();
    const url = req.url ?? "/";
    const app = INGEST_PATHS.some((p) => url.startsWith(p)) ? ingest : api;
    app.server.emit("request", req, res);
  } catch (err) {
    logger.error({ err }, "handler bootstrap failed");
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "bootstrap_failed", message: env.NODE_ENV === "production" ? "Server misconfigured" : String(err) }));
  }
}
