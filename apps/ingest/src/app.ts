/**
 * Ingestion endpoints (§4.1, §5.7). Contract: verify → store raw event → enqueue → 200, in <200ms.
 * Nothing is parsed on the request thread. This service is deployed on its own so API deploys
 * never drop webhooks.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import { env, logger } from "@lead/config";
import { getDb, sql } from "@lead/db";
import {
  storeWebhookEvent,
  whatsappExternalId,
  withTx,
  withdrawConsent,
  logActivity,
  type WhatsAppPayload,
} from "@lead/core";
import { parseUnsubscribeToken, safeEqual, sha256, verifyMetaSignature } from "@lead/domain";

export type Enqueue = (webhookEventId: string) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function buildIngest(opts: { enqueue: Enqueue; healthCheck?: () => Promise<boolean> }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
  const db = getDb();

  // Keep the raw body: Meta's signature is over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(formbody);
  await app.register(rateLimit, { global: false });

  const enqueueSafe = async (id: string) => {
    try {
      await opts.enqueue(id);
    } catch (err) {
      // Event is durable in Postgres; the worker's sweeper re-enqueues it.
      logger.error({ err, id }, "enqueue failed — sweeper will recover");
    }
  };

  app.get("/healthz", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      const ok = opts.healthCheck ? await opts.healthCheck() : true;
      return reply.code(ok ? 200 : 503).send({ ok, db: true, queue: ok });
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  // ---- WhatsApp ----
  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] && safeEqual(q["hub.verify_token"], env.WA_VERIFY_TOKEN)) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sigHeader = req.headers["x-hub-signature-256"] as string | undefined;
    const signatureOk = env.WA_APP_SECRET
      ? verifyMetaSignature(raw, sigHeader, env.WA_APP_SECRET)
      : env.NODE_ENV !== "production"; // dev without an app secret: accept
    if (!signatureOk) {
      // Reject silently on mismatch (§5.7) — but keep a record for investigation.
      logger.warn({ ip: req.ip }, "whatsapp signature mismatch");
      return reply.code(200).send();
    }
    const payload = req.body as WhatsAppPayload;
    const { id, duplicate } = await storeWebhookEvent(db, {
      provider: "whatsapp",
      externalId: whatsappExternalId(payload, sha256(raw.toString("utf8"))),
      payload,
      headers: { "user-agent": req.headers["user-agent"] },
      signatureOk,
    });
    if (!duplicate) await enqueueSafe(id);
    return reply.code(200).send();
  });

  // ---- Email: Postmark Inbound (Path A) ----
  app.post("/webhooks/email/postmark", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const expected = "Basic " + Buffer.from(`${env.POSTMARK_INBOUND_USER}:${env.POSTMARK_INBOUND_PASSWORD}`).toString("base64");
    if (!safeEqual(auth, expected)) return reply.code(401).send();
    const body = req.body as { MessageID?: string };
    if (!body?.MessageID) return reply.code(400).send({ error: "missing MessageID" });
    const { id, duplicate } = await storeWebhookEvent(db, { provider: "postmark", externalId: body.MessageID, payload: body, signatureOk: true });
    if (!duplicate) await enqueueSafe(id);
    return reply.code(200).send();
  });

  // ---- Gmail push via Cloud Pub/Sub (Path B) ----
  app.post("/webhooks/gmail", async (req, reply) => {
    const token = (req.query as Record<string, string>).token ?? "";
    if (!safeEqual(token, env.GOOGLE_PUBSUB_VERIFICATION_TOKEN)) return reply.code(403).send();
    const body = req.body as { message?: { data?: string; messageId?: string } };
    if (!body?.message?.data) return reply.code(204).send();
    let data: { emailAddress?: string; historyId?: string | number };
    try {
      data = JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"));
    } catch {
      return reply.code(204).send();
    }
    if (!data.emailAddress) return reply.code(204).send();
    const { id, duplicate } = await storeWebhookEvent(db, {
      provider: "gmail",
      externalId: body.message.messageId ?? `${data.emailAddress}:${data.historyId}`,
      payload: { emailAddress: data.emailAddress.toLowerCase(), historyId: String(data.historyId ?? "") },
      signatureOk: true,
    });
    if (!duplicate) await enqueueSafe(id);
    return reply.code(204).send();
  });

  // ---- Website form intake ----
  const corsHeaders = (reply: { header: (k: string, v: string) => unknown }) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "content-type, x-form-secret");
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  };
  app.options("/intake/form", async (_req, reply) => {
    corsHeaders(reply);
    return reply.code(204).send();
  });
  app.post(
    "/intake/form",
    { config: { rateLimit: { max: Number(process.env.FORM_RATE_LIMIT_PER_MIN ?? 120), timeWindow: "1 minute" } } },
    async (req, reply) => {
      corsHeaders(reply);
      const secret = (req.headers["x-form-secret"] as string) ?? (req.query as Record<string, string>).key ?? "";
      if (!safeEqual(secret, env.FORM_INTAKE_SECRET)) return reply.code(401).send({ error: "unauthorised" });
      const form = (req.body ?? {}) as Record<string, unknown>;
      if (form.website) return reply.code(200).send({ ok: true }); // honeypot hit: pretend success
      if (!form.email && !form.phone) return reply.code(422).send({ error: "email or phone is required" });
      const externalId = String(form.submission_id ?? sha256(JSON.stringify(form) + req.ip + new Date().toISOString().slice(0, 16)));
      const { id, duplicate } = await storeWebhookEvent(db, { provider: "form", externalId, payload: { form, ip: req.ip }, signatureOk: true });
      if (!duplicate) await enqueueSafe(id);
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- One-click unsubscribe (RFC 8058) ----
  const unsubscribe = async (token: string, via: string) => {
    const contactId = parseUnsubscribeToken(token, env.APP_SECRET);
    if (!contactId) return false;
    await withTx(async (tx) => {
      await withdrawConsent(tx, contactId, "email", "unsubscribe_link", { via, at: new Date().toISOString() });
      const r = await tx.execute(sql`select id from los_leads where contact_id = ${contactId} order by opened_at desc limit 1`);
      const leadId = (r.rows[0] as { id?: string } | undefined)?.id;
      if (leadId) await logActivity(tx, leadId, "opted_out", { type: "contact", id: contactId }, { channel: "email", via });
    });
    return true;
  };
  app.post("/unsubscribe/:token", async (req, reply) => {
    const ok = await unsubscribe((req.params as { token: string }).token, "one_click");
    return reply.code(ok ? 200 : 400).send(ok ? "Unsubscribed" : "Invalid link");
  });
  app.get("/unsubscribe/:token", async (req, reply) => {
    const ok = await unsubscribe((req.params as { token: string }).token, "link");
    return reply
      .type("text/html")
      .send(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${
          ok ? "You're unsubscribed" : "This link is invalid"
        }</h1><p>${ok ? "You won't receive marketing or follow-up emails from Doott. Replies to your own enquiries still reach us." : "Please contact privacy@doott.com."}</p></body>`,
      );
  });

  return app;
}
