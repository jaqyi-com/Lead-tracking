/**
 * Templates & snippets for the composer, attachments, search, notifications, reports.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { attachments, getDb, leads, notifications, snippets, templates } from "@lead/db";
import { DEFAULT_RATES_INR, contextVars, renderSnippet, type CostClass } from "@lead/domain";
import {
  ForbiddenError,
  NotFoundError,
  channelCostReport,
  fillTemplateValues,
  funnelReport,
  getStorage,
  renderTemplate,
  search,
  speedToLead,
  teamReport,
  todayDashboard,
  varContextForLead,
  verifyLocalFileSignature,
  ORG_ID,
} from "@lead/core";
import { canSeeLead, idParam, parse, requireRole, requireUser } from "../http";

const MAX_UPLOAD = 16 * 1024 * 1024;

export async function miscRoutes(app: FastifyInstance) {
  const db = getDb();

  // ---- Templates (composer view) ----
  app.get("/api/templates", async (req) => {
    requireUser(req);
    const rows = await db.select().from(templates).orderBy(asc(templates.internalName));
    return {
      items: rows.map((t) => ({
        ...t,
        costClass: t.category,
        costPerMessage: DEFAULT_RATES_INR[(t.category === "service" ? "utility" : t.category) as CostClass],
      })),
    };
  });

  /** Pre-filled values and live preview for a lead (§8.2 composer closed-window state). */
  app.get("/api/templates/:id/preview", async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { leadId } = parse(z.object({ leadId: z.string().uuid() }), req.query);
    const [l] = await db.select().from(leads).where(eq(leads.id, leadId));
    if (!l || !canSeeLead(u, l)) throw new ForbiddenError();
    const [t] = await db.select().from(templates).where(eq(templates.id, id));
    if (!t) throw new NotFoundError("Template");
    const values = fillTemplateValues(t, await varContextForLead(db, leadId));
    return { values, preview: renderTemplate(t, values), variables: t.variables };
  });

  app.get("/api/snippets", async (req) => {
    requireUser(req);
    return { items: await db.select().from(snippets).orderBy(asc(snippets.folder), asc(snippets.shortcut)) };
  });

  app.get("/api/snippets/render", async (req) => {
    const u = requireUser(req);
    const { id, leadId } = parse(z.object({ id: z.string().uuid(), leadId: z.string().uuid() }), req.query);
    const [l] = await db.select().from(leads).where(eq(leads.id, leadId));
    if (!l || !canSeeLead(u, l)) throw new ForbiddenError();
    const [snip] = await db.select().from(snippets).where(eq(snippets.id, id));
    if (!snip) throw new NotFoundError("Snippet");
    const ctx = await varContextForLead(db, leadId);
    return { body: renderSnippet(snip.body, contextVars(ctx)) };
  });

  app.post("/api/snippets", async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ shortcut: z.string().min(1).max(40), title: z.string().min(1).max(120), body: z.string().min(1).max(5000), folder: z.string().max(60).default("General") }), req.body);
    const [s] = await db.insert(snippets).values({ ...b, orgId: ORG_ID, createdBy: u.id }).returning();
    return { snippet: s };
  });

  app.patch("/api/snippets/:id", async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ shortcut: z.string().max(40).optional(), title: z.string().max(120).optional(), body: z.string().max(5000).optional(), folder: z.string().max(60).optional() }), req.body);
    await db.update(snippets).set(b).where(eq(snippets.id, id));
    return { ok: true };
  });

  app.delete("/api/snippets/:id", async (req) => {
    requireRole(req, "admin", "manager");
    const { id } = parse(idParam, req.params);
    await db.delete(snippets).where(eq(snippets.id, id));
    return { ok: true };
  });

  // ---- Attachments ----
  app.post("/api/attachments", async (req) => {
    const u = requireUser(req);
    if (u.role === "viewer") throw new ForbiddenError();
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!file) throw new NotFoundError("File");
    const data = await file.toBuffer();
    if (file.file.truncated) throw new ForbiddenError("File too large (max 16 MB)");
    const id = randomUUID();
    const ext = (file.filename.split(".").pop() ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const now = new Date();
    const key = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
    await getStorage().put(key, data, file.mimetype);
    const [a] = await db
      .insert(attachments)
      .values({ id, orgId: ORG_ID, ownerType: "upload", storageKey: key, filename: file.filename, mime: file.mimetype, size: data.length, status: "stored" })
      .returning();
    return { attachment: { id: a!.id, filename: a!.filename, mime: a!.mime, size: a!.size } };
  });

  /** Local-disk storage (dev): short-lived signed URLs, never public. */
  app.get("/files/*", async (req, reply) => {
    const key = decodeURIComponent((req.params as { "*": string })["*"]);
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || !verifyLocalFileSignature(key, exp, sig)) return reply.code(403).send("Link expired");
    const [a] = await db.select().from(attachments).where(eq(attachments.storageKey, key));
    const data = await getStorage().get(key);
    reply.header("Content-Type", a?.mime ?? "application/octet-stream");
    reply.header("Cache-Control", "private, max-age=300");
    if (a?.filename) reply.header("Content-Disposition", `inline; filename="${a.filename.replace(/"/g, "")}"`);
    return reply.send(data);
  });

  // ---- Search ----
  app.get("/api/search", async (req) => {
    const u = requireUser(req);
    const { q } = parse(z.object({ q: z.string().min(1).max(200) }), req.query);
    return { items: await search(db, q, { userId: u.id, role: u.role }) };
  });

  // ---- Notifications ----
  app.get("/api/notifications", async (req) => {
    const u = requireUser(req);
    const items = await db.select().from(notifications).where(eq(notifications.userId, u.id)).orderBy(desc(notifications.createdAt)).limit(50);
    const [{ unread }] = (await db.execute(sql`select count(*)::int as unread from notifications where user_id = ${u.id}::uuid and read_at is null`)).rows as { unread: number }[];
    return { items, unread };
  });

  app.post("/api/notifications/read", async (req) => {
    const u = requireUser(req);
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).optional() }), req.body);
    const where = ids?.length
      ? and(eq(notifications.userId, u.id), sql`${notifications.id} in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`)
      : and(eq(notifications.userId, u.id), isNull(notifications.readAt));
    await db.update(notifications).set({ readAt: new Date() }).where(where);
    return { ok: true };
  });

  // ---- Reports (§10) ----
  const range = (q: unknown) => {
    const r = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), q);
    const to = r.to ? new Date(r.to) : new Date();
    const from = r.from ? new Date(r.from) : new Date(to.getTime() - 30 * 86_400_000);
    return { from, to };
  };
  const reportRole = (req: Parameters<typeof requireUser>[0]) => requireRole(req, "admin", "manager", "viewer", "rep");

  app.get("/api/reports/today", async (req) => {
    reportRole(req);
    return todayDashboard(db);
  });
  app.get("/api/reports/funnel", async (req) => {
    reportRole(req);
    return { rows: await funnelReport(db, range(req.query)) };
  });
  app.get("/api/reports/team", async (req) => {
    const u = reportRole(req);
    const rows = await teamReport(db, range(req.query));
    return { rows: u.role === "rep" ? rows.filter((r) => r.user_id === u.id) : rows };
  });
  app.get("/api/reports/cost", async (req) => {
    requireRole(req, "admin", "manager", "viewer");
    return channelCostReport(db, range(req.query));
  });
  app.get("/api/reports/speed", async (req) => {
    reportRole(req);
    return speedToLead(db, range(req.query));
  });
}
