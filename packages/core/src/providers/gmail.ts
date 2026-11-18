/**
 * §6.1 Path B — Gmail mailbox sync via an Internal OAuth app (no CASA review while internal).
 *  - users.watch → Cloud Pub/Sub push → our ingest endpoint
 *  - users.history.list for incremental fetch
 *  - watch renewal at least every 7 days (we renew daily for watches expiring within 2 days)
 *  - rep-to-client mail sent through users.messages.send so it lands in the rep's Sent folder
 */
import { eq } from "drizzle-orm";
import { env } from "@lead/config";
import { mailboxConnections, type Db } from "@lead/db";
import { encryptSecret, decryptSecret } from "@lead/domain";
import { ProviderError } from "../errors";
import { buildMime, type OutboundEmail, type EmailSendResult } from "./email";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
  "profile",
];

export function gmailAuthUrl(state: string, redirectUri: string, scopes = GMAIL_SCOPES): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: scopes.join(" "),
    state,
  });
  if (env.GOOGLE_WORKSPACE_DOMAIN) p.set("hd", env.GOOGLE_WORKSPACE_DOMAIN);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new ProviderError("oauth", json.error ?? "Google token exchange failed", false);
  return json as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
}

/** Decode (not verify) an id_token from a direct TLS exchange with Google's token endpoint. */
export function decodeIdToken(idToken: string): { email?: string; email_verified?: boolean; hd?: string; name?: string } {
  const payload = idToken.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

type Conn = typeof mailboxConnections.$inferSelect;

export class GmailClient {
  constructor(
    private db: Db,
    private conn: Conn,
  ) {}

  private async token(): Promise<string> {
    const c = this.conn;
    if (c.accessTokenEnc && c.tokenExpiresAt && c.tokenExpiresAt.getTime() > Date.now() + 60_000) {
      return decryptSecret(c.accessTokenEnc, env.APP_SECRET);
    }
    if (!c.refreshTokenEnc) throw new ProviderError("no_refresh_token", "Mailbox needs to be reconnected", false);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: decryptSecret(c.refreshTokenEnc, env.APP_SECRET),
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      await this.db
        .update(mailboxConnections)
        .set({ status: "error", lastError: json.error ?? "token refresh failed" })
        .where(eq(mailboxConnections.id, c.id));
      throw new ProviderError("token_refresh", json.error ?? "token refresh failed", json.error !== "invalid_grant");
    }
    const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
    const enc = encryptSecret(json.access_token, env.APP_SECRET);
    await this.db
      .update(mailboxConnections)
      .set({ accessTokenEnc: enc, tokenExpiresAt: expiresAt, status: "active", lastError: null })
      .where(eq(mailboxConnections.id, c.id));
    this.conn = { ...c, accessTokenEnc: enc, tokenExpiresAt: expiresAt };
    return json.access_token;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${GMAIL}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { code?: number; message?: string } };
    if (!res.ok) {
      throw new ProviderError(String(res.status), json.error?.message ?? `Gmail HTTP ${res.status}`, res.status >= 500 || res.status === 429, json);
    }
    return json;
  }

  async watch(): Promise<{ historyId: string; expiration: Date }> {
    const r = await this.call<{ historyId: string; expiration: string }>("watch", {
      method: "POST",
      body: JSON.stringify({ topicName: env.GOOGLE_PUBSUB_TOPIC, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "INCLUDE" }),
    });
    return { historyId: r.historyId, expiration: new Date(Number(r.expiration)) };
  }

  async stop(): Promise<void> {
    await this.call("stop", { method: "POST" });
  }

  /** Returns added message ids since historyId, plus the new historyId. Throws 404 if historyId is too old. */
  async historySince(historyId: string): Promise<{ messageIds: string[]; historyId: string }> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = historyId;
    do {
      const q = new URLSearchParams({ startHistoryId: historyId, historyTypes: "messageAdded" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await this.call<{
        history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
        historyId: string;
        nextPageToken?: string;
      }>(`history?${q}`);
      for (const h of r.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
      latest = r.historyId ?? latest;
      pageToken = r.nextPageToken;
    } while (pageToken);
    return { messageIds: [...ids], historyId: latest };
  }

  async recentMessageIds(query = "newer_than:2d"): Promise<string[]> {
    const r = await this.call<{ messages?: { id: string }[] }>(`messages?q=${encodeURIComponent(query)}&maxResults=200`);
    return (r.messages ?? []).map((m) => m.id);
  }

  async getRaw(id: string): Promise<{ raw: Buffer; labelIds: string[]; threadId: string }> {
    const r = await this.call<{ raw: string; labelIds?: string[]; threadId: string }>(`messages/${id}?format=raw`);
    return { raw: Buffer.from(r.raw, "base64url"), labelIds: r.labelIds ?? [], threadId: r.threadId };
  }

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.call("profile");
  }

  async send(m: OutboundEmail, threadId?: string): Promise<EmailSendResult> {
    const raw = await buildMime(m);
    const r = await this.call<{ id: string; threadId: string }>("messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) }),
    });
    // Gmail may rewrite Message-ID; read back the one recipients will see so threading works.
    let messageId = m.messageId ?? "";
    try {
      const meta = await this.call<{ payload?: { headers?: { name: string; value: string }[] } }>(
        `messages/${r.id}?format=metadata&metadataHeaders=Message-ID`,
      );
      messageId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value ?? messageId;
    } catch {
      /* keep ours */
    }
    return { providerMessageId: r.id, messageId, threadId: r.threadId };
  }
}
