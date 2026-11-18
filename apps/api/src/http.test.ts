import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@lead/db/src/testing";
import * as s from "@lead/db";
import { hashPassword, hmacHex } from "@lead/domain";
import { env } from "@lead/config";
import { InlineSink, setEffectSink, clearCalendarCache } from "@lead/core";
import { buildApi } from "./app";
import { buildIngest } from "../../ingest/src/app";
import type { FastifyInstance } from "fastify";

let api: FastifyInstance;
let ingest: FastifyInstance;
let db: s.Db;
const enqueued: string[] = [];

async function login(email: string, password: string): Promise<string> {
  const r = await api.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((x) => x.name === "lead_sid")!;
  return `lead_sid=${c.value}`;
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  const allDay: Record<string, [string, string][]> = {};
  for (let d = 0; d < 7; d++) allDay[String(d)] = [["00:00", "24:00"]];
  await db.update(s.businessHours).set({ weekly: allDay });
  clearCalendarCache();
  const pw = await hashPassword("secret-password");
  await db.insert(s.users).values([
    { orgId: env.DEFAULT_ORG_ID, name: "Priya", email: "priya@x.local", role: "rep", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw },
    { orgId: env.DEFAULT_ORG_ID, name: "Arjun", email: "arjun@x.local", role: "rep", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw, isAvailable: false },
    { orgId: env.DEFAULT_ORG_ID, name: "Meera", email: "meera@x.local", role: "manager", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw },
    { orgId: env.DEFAULT_ORG_ID, name: "View", email: "view@x.local", role: "viewer", passwordHash: pw },
  ]);
  setEffectSink(new InlineSink());
  api = await buildApi();
  ingest = await buildIngest({ enqueue: async (id) => void enqueued.push(id) });
});

describe("ingest endpoints", () => {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, contacts: [{ wa_id: "919800000001", profile: { name: "Kavya" } }], messages: [{ from: "919800000001", id: "wamid.H1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Need pricing" } }] } }] }],
  });

  it("verifies the Meta webhook challenge", async () => {
    const ok = await ingest.inject({ url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WA_VERIFY_TOKEN}&hub.challenge=42` });
    expect(ok.body).toBe("42");
    const bad = await ingest.inject({ url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("stores once and enqueues once, even when Meta retries", async () => {
    const send = () => ingest.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json" }, payload: body });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const rows = await db.select().from(s.webhookEvents).where(eq(s.webhookEvents.provider, "whatsapp"));
    expect(rows.length).toBe(1);
    expect(enqueued.length).toBe(1);
  });

  it("checks the X-Hub-Signature-256 when an app secret is configured", async () => {
    const original = env.WA_APP_SECRET;
    (env as { WA_APP_SECRET: string }).WA_APP_SECRET = "app-secret";
    const payload = body.replace("wamid.H1", "wamid.H2");
    const bad = await ingest.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" }, payload });
    expect(bad.statusCode).toBe(200); // silent reject
    const good = await ingest.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + hmacHex("app-secret", payload) }, payload });
    expect(good.statusCode).toBe(200);
    expect(enqueued.length).toBe(2);
    (env as { WA_APP_SECRET: string }).WA_APP_SECRET = original;
  });

  it("form intake requires the shared secret and a contact route", async () => {
    expect((await ingest.inject({ method: "POST", url: "/intake/form", payload: { email: "a@b.com" } })).statusCode).toBe(401);
    expect((await ingest.inject({ method: "POST", url: "/intake/form", headers: { "x-form-secret": env.FORM_INTAKE_SECRET }, payload: { name: "x" } })).statusCode).toBe(422);
    expect((await ingest.inject({ method: "POST", url: "/intake/form", headers: { "x-form-secret": env.FORM_INTAKE_SECRET }, payload: { email: "a@b.com", message: "hi" } })).statusCode).toBe(200);
  });

  it("postmark endpoint requires basic auth", async () => {
    expect((await ingest.inject({ method: "POST", url: "/webhooks/email/postmark", payload: { MessageID: "x" } })).statusCode).toBe(401);
    const auth = "Basic " + Buffer.from(`${env.POSTMARK_INBOUND_USER}:${env.POSTMARK_INBOUND_PASSWORD}`).toString("base64");
    expect((await ingest.inject({ method: "POST", url: "/webhooks/email/postmark", headers: { authorization: auth }, payload: { MessageID: "pm-1", From: "x@y.com" } })).statusCode).toBe(200);
  });
});

describe("api", () => {
  it("rejects bad credentials and unauthenticated calls", async () => {
    expect((await api.inject({ method: "POST", url: "/api/auth/login", payload: { email: "priya@x.local", password: "wrong" } })).statusCode).toBe(401);
    expect((await api.inject({ url: "/api/conversations" })).statusCode).toBe(401);
  });

  it("a rep sees the new lead, replies, and the lead records first response", async () => {
    const { processWebhookEvent } = await import("@lead/core");
    for (const id of enqueued) await processWebhookEvent(id);
    const cookie = await login("priya@x.local", "secret-password");
    const list = await api.inject({ url: "/api/conversations?filter=mine&channel=whatsapp", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { id: string; lead_id: string; contact_name: string }[];
    expect(items.length).toBe(1);
    expect(items[0]!.contact_name).toBe("Kavya");

    const thread = await api.inject({ url: `/api/conversations/${items[0]!.id}`, headers: { cookie } });
    expect(thread.json().window.open).toBe(true);

    const send = await api.inject({ method: "POST", url: `/api/conversations/${items[0]!.id}/messages`, headers: { cookie }, payload: { type: "text", body: "Hi Kavya!" } });
    expect(send.statusCode).toBe(200);
    const lead = await api.inject({ url: `/api/leads/${items[0]!.lead_id}`, headers: { cookie } });
    expect(lead.json().lead.firstResponseAt).not.toBeNull();
    expect(lead.json().timeline.some((a: { type: string }) => a.type === "first_response")).toBe(true);
  });

  it("enforces stage rules with plain-language errors", async () => {
    const cookie = await login("priya@x.local", "secret-password");
    const [l] = await db.select().from(s.leads).limit(1);
    const r = await api.inject({ method: "POST", url: `/api/leads/${l!.id}/stage`, headers: { cookie }, payload: { stage: "quoted" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("qualification_incomplete");
  });

  it("viewers cannot read message content; reps cannot reassign", async () => {
    const viewer = await login("view@x.local", "secret-password");
    expect((await api.inject({ url: "/api/conversations", headers: { cookie: viewer } })).statusCode).toBe(403);
    expect((await api.inject({ url: "/api/reports/today", headers: { cookie: viewer } })).statusCode).toBe(200);
    const rep = await login("priya@x.local", "secret-password");
    const [l] = await db.select().from(s.leads).limit(1);
    const [arjun] = await db.select().from(s.users).where(eq(s.users.email, "arjun@x.local"));
    expect((await api.inject({ method: "POST", url: `/api/leads/${l!.id}/assign`, headers: { cookie: rep }, payload: { userId: arjun!.id, reason: "x" } })).statusCode).toBe(403);
  });

  it("manager dashboards, pipeline and search respond", async () => {
    const cookie = await login("meera@x.local", "secret-password");
    for (const url of ["/api/reports/today", "/api/reports/speed", "/api/pipeline", "/api/my-day", "/api/search?q=Kavya", "/api/admin/queue-health", "/api/meta", "/api/templates"]) {
      const r = await api.inject({ url, headers: { cookie } });
      expect(r.statusCode, url).toBe(200);
    }
    const search = await api.inject({ url: "/api/search?q=Kavya", headers: { cookie } });
    expect(search.json().items.length).toBeGreaterThan(0);
  });
});
