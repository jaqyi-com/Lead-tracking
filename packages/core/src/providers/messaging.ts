/**
 * §5.1 MessagingProvider: a thin internal interface so a BSP implementation can be added in a day.
 * The first implementation is Meta's WhatsApp Cloud API, direct. "fake" is for local development.
 */
import { randomUUID } from "node:crypto";
import { env, logger } from "@lead/config";
import { isRetryableProviderError } from "@lead/domain";
import { ProviderError } from "../errors";

export type SendResult = { providerMessageId: string };

export type TemplateSend = {
  name: string;
  language: string;
  bodyParams: string[];
  headerDocument?: { link: string; filename?: string };
};

export type MediaSend = {
  kind: "image" | "document" | "audio" | "video";
  link?: string;
  mediaId?: string;
  caption?: string;
  filename?: string;
};

export type RemoteTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  body: string;
  header?: string | null;
  footer?: string | null;
  buttons: unknown[];
  rejectedReason?: string | null;
};

export interface MessagingProvider {
  readonly name: "cloud" | "fake";
  sendText(to: string, body: string, opts?: { replyToContextId?: string; previewUrl?: boolean }): Promise<SendResult>;
  sendTemplate(to: string, t: TemplateSend): Promise<SendResult>;
  sendMedia(to: string, m: MediaSend): Promise<SendResult>;
  uploadMedia(data: Buffer, mime: string, filename: string): Promise<string>;
  fetchMedia(mediaId: string): Promise<{ data: Buffer; mime: string; size: number }>;
  markRead(providerMessageId: string): Promise<void>;
  listTemplates(): Promise<RemoteTemplate[]>;
  submitTemplate(t: { name: string; language: string; category: string; body: string; examples: string[] }): Promise<{ id: string; status: string }>;
  phoneNumberInfo(): Promise<{ displayNumber?: string; qualityRating?: string; messagingLimit?: string }>;
}

/** Strip "+" — Cloud API takes the recipient as digits. */
const toWa = (to: string) => to.replace(/[^\d]/g, "");

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = "cloud" as const;
  private base = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}`;

  constructor(
    private phoneNumberId = env.WA_PHONE_NUMBER_ID,
    private token = env.WA_ACCESS_TOKEN,
    private wabaId = env.WA_WABA_ID,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderError("network", `WhatsApp API unreachable: ${(err as Error).message}`, true);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const e = (json.error ?? {}) as { code?: number; message?: string; error_data?: { details?: string } };
      const code = String(e.code ?? res.status);
      throw new ProviderError(
        code,
        e.error_data?.details ?? e.message ?? `HTTP ${res.status}`,
        isRetryableProviderError(code) || res.status >= 500 || res.status === 429,
        json,
      );
    }
    return json as T;
  }

  private async send(payload: Record<string, unknown>): Promise<SendResult> {
    const r = await this.call<{ messages: { id: string }[] }>(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new ProviderError("no_id", "WhatsApp did not return a message id", true, r);
    return { providerMessageId: id };
  }

  sendText(to: string, body: string, opts: { replyToContextId?: string; previewUrl?: boolean } = {}) {
    return this.send({
      to: toWa(to),
      type: "text",
      text: { body, preview_url: opts.previewUrl ?? true },
      ...(opts.replyToContextId ? { context: { message_id: opts.replyToContextId } } : {}),
    });
  }

  sendTemplate(to: string, t: TemplateSend) {
    const components: unknown[] = [];
    if (t.headerDocument) {
      components.push({
        type: "header",
        parameters: [{ type: "document", document: { link: t.headerDocument.link, filename: t.headerDocument.filename } }],
      });
    }
    if (t.bodyParams.length) {
      components.push({ type: "body", parameters: t.bodyParams.map((text) => ({ type: "text", text })) });
    }
    return this.send({ to: toWa(to), type: "template", template: { name: t.name, language: { code: t.language }, components } });
  }

  sendMedia(to: string, m: MediaSend) {
    const media: Record<string, unknown> = m.mediaId ? { id: m.mediaId } : { link: m.link };
    if (m.caption && m.kind !== "audio") media.caption = m.caption;
    if (m.filename && m.kind === "document") media.filename = m.filename;
    return this.send({ to: toWa(to), type: m.kind, [m.kind]: media });
  }

  async uploadMedia(data: Buffer, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);
    const r = await this.call<{ id: string }>(`${this.phoneNumberId}/media`, { method: "POST", body: form });
    return r.id;
  }

  /** §5.7: media arrives as an id. Fetch the URL, download with the bearer token. Never hotlink. */
  async fetchMedia(mediaId: string) {
    const meta = await this.call<{ url: string; mime_type: string; file_size: number }>(mediaId);
    const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ProviderError(String(res.status), `Media download failed (${res.status})`, res.status >= 500);
    const data = Buffer.from(await res.arrayBuffer());
    return { data, mime: meta.mime_type, size: meta.file_size ?? data.length };
  }

  async markRead(providerMessageId: string) {
    await this.call(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: providerMessageId }),
    });
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    const out: RemoteTemplate[] = [];
    let path: string | null = `${this.wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,rejected_reason`;
    while (path) {
      type Page = { data: Record<string, unknown>[]; paging?: { next?: string } };
      const page: Page = await this.call<Page>(path);
      for (const t of page.data) {
        const comps = (t.components as { type: string; text?: string; format?: string; buttons?: unknown[] }[]) ?? [];
        out.push({
          id: String(t.id),
          name: String(t.name),
          language: String(t.language),
          status: String(t.status).toLowerCase(),
          category: String(t.category).toLowerCase(),
          body: comps.find((c) => c.type === "BODY")?.text ?? "",
          header: comps.find((c) => c.type === "HEADER")?.text ?? comps.find((c) => c.type === "HEADER")?.format ?? null,
          footer: comps.find((c) => c.type === "FOOTER")?.text ?? null,
          buttons: comps.find((c) => c.type === "BUTTONS")?.buttons ?? [],
          rejectedReason: (t.rejected_reason as string) ?? null,
        });
      }
      path = page.paging?.next ? page.paging.next.replace(`${this.base}/`, "") : null;
    }
    return out;
  }

  async submitTemplate(t: { name: string; language: string; category: string; body: string; examples: string[] }) {
    const r = await this.call<{ id: string; status: string }>(`${this.wabaId}/message_templates`, {
      method: "POST",
      body: JSON.stringify({
        name: t.name,
        language: t.language,
        category: t.category.toUpperCase(),
        components: [
          { type: "BODY", text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) },
        ],
      }),
    });
    return { id: r.id, status: String(r.status ?? "pending").toLowerCase() };
  }

  async phoneNumberInfo() {
    const r = await this.call<{ display_phone_number?: string; quality_rating?: string; messaging_limit_tier?: string }>(
      `${this.phoneNumberId}?fields=display_phone_number,quality_rating,messaging_limit_tier`,
    );
    return { displayNumber: r.display_phone_number, qualityRating: r.quality_rating, messagingLimit: r.messaging_limit_tier };
  }
}

/**
 * Local development provider: no network. Messages "send" instantly; the worker then simulates
 * delivered/read status webhooks so the UI behaves like production.
 */
export class FakeMessagingProvider implements MessagingProvider {
  readonly name = "fake" as const;
  sent: { to: string; payload: unknown; id: string }[] = [];

  private record(to: string, payload: unknown): SendResult {
    const id = `wamid.fake.${randomUUID()}`;
    this.sent.push({ to, payload, id });
    logger.info({ to, payload }, "[fake whatsapp] send");
    if (/^\+?0{5,}/.test(to)) throw new ProviderError("131026", "Message undeliverable (fake provider test number)", false);
    return { providerMessageId: id };
  }
  async sendText(to: string, body: string) {
    return this.record(to, { type: "text", body });
  }
  async sendTemplate(to: string, t: TemplateSend) {
    return this.record(to, { type: "template", ...t });
  }
  async sendMedia(to: string, m: MediaSend) {
    return this.record(to, { type: "media", ...m });
  }
  async uploadMedia() {
    return `fake-media-${randomUUID()}`;
  }
  async fetchMedia(mediaId: string) {
    const data = Buffer.from(`fake media ${mediaId}`);
    return { data, mime: "text/plain", size: data.length };
  }
  async markRead() {}
  async listTemplates(): Promise<RemoteTemplate[]> {
    return [];
  }
  async submitTemplate(t: { name: string }) {
    return { id: `fake-tpl-${t.name}`, status: "approved" };
  }
  async phoneNumberInfo() {
    return { displayNumber: "+91 00000 00000 (fake)", qualityRating: "GREEN", messagingLimit: "TIER_250" };
  }
}

let provider: MessagingProvider | undefined;

export function getMessagingProvider(): MessagingProvider {
  if (!provider) provider = env.MESSAGING_PROVIDER === "cloud" ? new WhatsAppCloudProvider() : new FakeMessagingProvider();
  return provider;
}

export function setMessagingProvider(p: MessagingProvider): void {
  provider = p;
}
