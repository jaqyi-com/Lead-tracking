/**
 * §11.2 auth: email + password with TOTP (required for admins in production), or Google
 * Workspace SSO. Sessions are opaque random tokens; only their SHA-256 is stored.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticator } from "otplib";
import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { env } from "@lead/config";
import { getDb, sessions, users, mailboxConnections } from "@lead/db";
import { randomToken, sha256, verifyPassword, encryptSecret, decryptSecret, hmacHex, safeEqual } from "@lead/domain";
import { DomainError, audit, gmailAuthUrl, exchangeCode, decodeIdToken, GmailClient, withTx } from "@lead/core";
import { parse, requireUser, type SessionUser } from "./http";

const COOKIE = "lead_sid";
const SESSION_DAYS = 14;
const db = () => getDb();

function cookieOpts() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400,
  };
}

async function createSession(userId: string, req: FastifyRequest, pendingTotp: boolean): Promise<string> {
  const token = randomToken();
  await db()
    .insert(sessions)
    .values({
      id: sha256(token),
      userId,
      pendingTotp,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    });
  return token;
}

export async function userFromToken(token: string | undefined): Promise<{ user: SessionUser; sessionId: string; pendingTotp: boolean } | null> {
  if (!token) return null;
  const sid = sha256(token);
  const [row] = await db()
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())));
  if (!row || !row.u.active) return null;
  return {
    sessionId: sid,
    pendingTotp: row.s.pendingTotp,
    user: { id: row.u.id, name: row.u.name, email: row.u.email, role: row.u.role, teamId: row.u.teamId, totpEnabled: row.u.totpEnabled },
  };
}

const TOTP_SETUP_ALLOWED = ["/api/me", "/api/me/totp/setup", "/api/me/totp/enable", "/api/auth/logout"];

export async function registerAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[COOKIE] ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
    const s = await userFromToken(token);
    if (!s) return;
    if (s.pendingTotp) {
      if (req.url.startsWith("/api/auth/totp")) req.sessionId = s.sessionId;
      return;
    }
    req.user = s.user;
    req.sessionId = s.sessionId;
    // §11.2: TOTP required for admins (production). Until enabled, only setup routes work.
    if (env.NODE_ENV === "production" && s.user.role === "admin" && !s.user.totpEnabled && !TOTP_SETUP_ALLOWED.some((p) => req.url.startsWith(p))) {
      throw new DomainError("totp_setup_required", "Admins must enable two-factor authentication first", 403);
    }
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const [u] = await db().select().from(users).where(eq(users.email, body.email.toLowerCase()));
    const ok = u && u.active && (await verifyPassword(body.password, u.passwordHash));
    if (!ok) throw new DomainError("invalid_credentials", "Email or password is incorrect", 401);
    const token = await createSession(u.id, req, u.totpEnabled);
    reply.setCookie(COOKIE, token, cookieOpts());
    await withTx((tx) => audit(tx, { type: "user", id: u.id, ip: req.ip }, "auth.login", "user", u.id, null, { method: "password" }));
    return { ok: true, totpRequired: u.totpEnabled };
  });

  app.post("/api/auth/totp", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!req.sessionId) throw new DomainError("unauthenticated", "Sign in first", 401);
    const [s] = await db().select().from(sessions).where(eq(sessions.id, req.sessionId));
    const [u] = await db().select().from(users).where(eq(users.id, s!.userId));
    if (!u?.totpSecret || !authenticator.check(code, decryptSecret(u.totpSecret, env.APP_SECRET))) {
      throw new DomainError("invalid_code", "That code is not valid", 401);
    }
    await db().update(sessions).set({ pendingTotp: false }).where(eq(sessions.id, req.sessionId));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) await db().delete(sessions).where(eq(sessions.id, req.sessionId));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const u = requireUser(req);
    const [row] = await db().select().from(users).where(eq(users.id, u.id));
    const mailbox = await db().select({ email: mailboxConnections.email, status: mailboxConnections.status }).from(mailboxConnections).where(eq(mailboxConnections.userId, u.id));
    return {
      ...u,
      isAvailable: row!.isAvailable,
      capacity: row!.capacity,
      mailbox: mailbox[0] ?? null,
      vapidPublicKey: env.VAPID_PUBLIC_KEY || null,
      googleSso: !!env.GOOGLE_CLIENT_ID,
    };
  });

  app.patch("/api/me", async (req) => {
    const u = requireUser(req);
    const body = parse(z.object({ isAvailable: z.boolean().optional(), name: z.string().min(1).max(120).optional() }), req.body);
    await db().update(users).set(body).where(eq(users.id, u.id));
    return { ok: true };
  });

  app.post("/api/me/push-subscription", async (req) => {
    const u = requireUser(req);
    const sub = parse(z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }), req.body);
    const [row] = await db().select({ subs: users.pushSubscriptions }).from(users).where(eq(users.id, u.id));
    const subs = (row?.subs ?? []).filter((s) => (s as { endpoint?: string }).endpoint !== sub.endpoint);
    await db().update(users).set({ pushSubscriptions: [...subs, sub].slice(-5) }).where(eq(users.id, u.id));
    return { ok: true };
  });

  app.post("/api/me/totp/setup", async (req) => {
    const u = requireUser(req);
    const secret = authenticator.generateSecret();
    await db().update(users).set({ totpSecret: encryptSecret(secret, env.APP_SECRET), totpEnabled: false }).where(eq(users.id, u.id));
    return { secret, otpauth: authenticator.keyuri(u.email, "Doott Lead OS", secret) };
  });

  app.post("/api/me/totp/enable", async (req) => {
    const u = requireUser(req);
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const [row] = await db().select().from(users).where(eq(users.id, u.id));
    if (!row?.totpSecret || !authenticator.check(code, decryptSecret(row.totpSecret, env.APP_SECRET))) {
      throw new DomainError("invalid_code", "That code is not valid", 400);
    }
    await db().update(users).set({ totpEnabled: true }).where(eq(users.id, u.id));
    await withTx((tx) => audit(tx, { type: "user", id: u.id, ip: req.ip }, "auth.totp_enabled", "user", u.id, null, null));
    return { ok: true };
  });

  // ---- Google Workspace SSO and Gmail mailbox connect (one OAuth client, Internal consent screen) ----
  const redirect = `${env.API_URL}/api/auth/google/callback`;
  const signState = (payload: string) => `${payload}.${hmacHex(env.APP_SECRET, "oauth:" + payload).slice(0, 24)}`;
  const checkState = (state: string) => {
    const i = state.lastIndexOf(".");
    const payload = state.slice(0, i);
    return safeEqual(signState(payload), state) ? payload : null;
  };

  app.get("/api/auth/google", async (_req, reply) => {
    if (!env.GOOGLE_CLIENT_ID) throw new DomainError("sso_disabled", "Google SSO is not configured");
    const state = signState(`login:${Date.now()}`);
    return reply.redirect(gmailAuthUrl(state, redirect, ["openid", "email", "profile"]));
  });

  app.get("/api/integrations/gmail/connect", async (req, reply) => {
    const u = requireUser(req);
    if (!env.GOOGLE_CLIENT_ID) throw new DomainError("gmail_disabled", "Gmail sync is not configured");
    return reply.redirect(gmailAuthUrl(signState(`gmail:${u.id}:${Date.now()}`), redirect));
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error || !q.code || !q.state) return reply.redirect(`${env.APP_URL}/login?error=${encodeURIComponent(q.error ?? "oauth")}`);
    const payload = checkState(q.state);
    if (!payload) return reply.redirect(`${env.APP_URL}/login?error=state`);
    const [kind, userId, ts] = payload.split(":");
    if (Date.now() - Number(ts ?? userId) > 10 * 60_000) return reply.redirect(`${env.APP_URL}/login?error=expired`);
    const tokens = await exchangeCode(q.code, redirect);
    const id = tokens.id_token ? decodeIdToken(tokens.id_token) : {};
    const email = (id.email ?? "").toLowerCase();
    if (env.GOOGLE_WORKSPACE_DOMAIN && id.hd !== env.GOOGLE_WORKSPACE_DOMAIN) {
      return reply.redirect(`${env.APP_URL}/login?error=domain`);
    }

    if (kind === "login") {
      const [u] = await db().select().from(users).where(eq(users.email, email));
      if (!u || !u.active) return reply.redirect(`${env.APP_URL}/login?error=no_account`);
      const token = await createSession(u.id, req, false);
      reply.setCookie(COOKIE, token, cookieOpts());
      return reply.redirect(`${env.APP_URL}/inbox`);
    }

    // Gmail connect for the signed-in user.
    const [u] = await db().select().from(users).where(eq(users.id, userId!));
    if (!u) return reply.redirect(`${env.APP_URL}/settings?gmail=error`);
    const values = {
      orgId: u.orgId,
      userId: u.id,
      provider: "gmail",
      email,
      accessTokenEnc: encryptSecret(tokens.access_token, env.APP_SECRET),
      refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token, env.APP_SECRET) : null,
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      status: "active",
      lastError: null,
    };
    const [conn] = await db()
      .insert(mailboxConnections)
      .values(values)
      .onConflictDoUpdate({ target: mailboxConnections.email, set: { ...values, refreshTokenEnc: values.refreshTokenEnc ?? undefined } })
      .returning();
    try {
      const w = await new GmailClient(db(), conn!).watch();
      await db().update(mailboxConnections).set({ historyId: w.historyId, watchExpiresAt: w.expiration }).where(eq(mailboxConnections.id, conn!.id));
    } catch (err) {
      await db().update(mailboxConnections).set({ lastError: (err as Error).message }).where(eq(mailboxConnections.id, conn!.id));
    }
    return reply.redirect(`${env.APP_URL}/settings?gmail=connected`);
  });

  app.post("/api/integrations/gmail/disconnect", async (req) => {
    const u = requireUser(req);
    const [conn] = await db().select().from(mailboxConnections).where(eq(mailboxConnections.userId, u.id));
    if (conn) {
      await new GmailClient(db(), conn).stop().catch(() => undefined);
      await db().update(mailboxConnections).set({ status: "disconnected", accessTokenEnc: null, refreshTokenEnc: null }).where(eq(mailboxConnections.id, conn.id));
    }
    return { ok: true };
  });
}
