import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { env } from "@lead/config";
import { getDb, sql } from "@lead/db";
import { registerAuth } from "./auth";
import { errorHandler } from "./http";
import { inboxRoutes } from "./routes/inbox";
import { leadRoutes } from "./routes/leads";
import { miscRoutes } from "./routes/misc";
import { adminRoutes } from "./routes/admin";

export async function buildApi(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 12 * 1024 * 1024 });
  app.setErrorHandler(errorHandler);
  await app.register(cors, { origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1 } });
  // Per-endpoint rate limiting (§11.2); generous default for the app, strict on login/export.
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  app.get("/healthz", async () => {
    await getDb().execute(sql`select 1`);
    return { ok: true };
  });

  await registerAuth(app);
  await inboxRoutes(app);
  await leadRoutes(app);
  await miscRoutes(app);
  await adminRoutes(app);
  return app;
}
