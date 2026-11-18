/**
 * §5.7 WhatsApp webhook handling — every event type:
 * messages, statuses, coexistence echoes (smb_message_echoes), history sync, template status,
 * phone-number quality and account alerts.
 */
import { eq } from "drizzle-orm";
import { logger } from "@lead/config";
import { getDb, waNumbers } from "@lead/db";
import { waIdToE164 } from "@lead/domain";
import { withTx } from "../effects";
import { applyWhatsAppStatus, type WaStatus } from "../outbound";
import { applyTemplateStatus } from "../templates";
import { managerIds, notify, ORG_ID } from "../support";
import { processInbound, recordExternalOutbound, type PendingMedia } from "./inbound";
import type { IdentityInput } from "../identity";

type WaMessage = {
  from: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string; description?: string } };
  button?: { text: string; payload?: string };
  reaction?: { message_id: string; emoji?: string };
  context?: { from?: string; id?: string };
  referral?: { source_type?: string; headline?: string; body?: string; source_url?: string; ctwa_clid?: string };
  errors?: { code: number; title: string }[];
};

type ChangeValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
  message_echoes?: WaMessage[];
  history?: { threads?: { id?: string; messages?: (WaMessage & { history_context?: { status?: string } })[] }[] }[];
  // template / quality / alerts
  event?: string;
  message_template_id?: number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
  display_phone_number?: string;
  current_limit?: string;
  alert_info?: Record<string, unknown>;
};

export type WhatsAppPayload = { object?: string; entry?: { id: string; changes?: { field: string; value: ChangeValue }[] }[] };

export function extractContent(m: WaMessage): { kind: string; body: string | null; media: PendingMedia[] } {
  const media: PendingMedia[] = [];
  const add = (kind: string, x?: { id: string; mime_type?: string; caption?: string; filename?: string }) => {
    if (x?.id) media.push({ kind, providerMediaId: x.id, mime: x.mime_type, caption: x.caption, filename: x.filename });
  };
  switch (m.type) {
    case "text":
      return { kind: "text", body: m.text?.body ?? "", media };
    case "image":
      add("image", m.image);
      return { kind: "image", body: m.image?.caption ?? null, media };
    case "video":
      add("video", m.video);
      return { kind: "video", body: m.video?.caption ?? null, media };
    case "audio":
      add("audio", m.audio);
      return { kind: "audio", body: null, media };
    case "sticker":
      add("image", m.sticker);
      return { kind: "sticker", body: null, media };
    case "document":
      add("document", m.document);
      return { kind: "document", body: m.document?.caption ?? m.document?.filename ?? null, media };
    case "location": {
      const l = m.location!;
      return {
        kind: "location",
        body: `📍 ${[l.name, l.address].filter(Boolean).join(", ")} (${l.latitude}, ${l.longitude})`.replace("📍  (", "📍 ("),
        media,
      };
    }
    case "contacts":
      return {
        kind: "contacts",
        body: (m.contacts ?? []).map((c) => `Shared contact: ${c.name?.formatted_name ?? ""} ${(c.phones ?? []).map((p) => p.phone).join(", ")}`.trim()).join("\n"),
        media,
      };
    case "interactive":
      return { kind: "interactive", body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null, media };
    case "button":
      return { kind: "interactive", body: m.button?.text ?? null, media };
    case "reaction":
      return { kind: "reaction", body: m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : "Removed reaction", media };
    default:
      return { kind: "unsupported", body: `[Unsupported message type: ${m.type}]`, media };
  }
}

function identitiesFor(waId: string): IdentityInput[] {
  const ids: IdentityInput[] = [{ kind: "wa_id", value: waId.replace(/\D/g, ""), raw: waId }];
  const e164 = waIdToE164(waId);
  if (e164) ids.push({ kind: "phone", value: e164, raw: waId });
  return ids;
}

export async function processWhatsAppPayload(payload: WhatsAppPayload, webhookEventId?: string): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const phoneNumberId = v.metadata?.phone_number_id ?? null;
      switch (change.field) {
        case "messages": {
          const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
          for (const m of v.messages ?? []) {
            const { kind, body, media } = extractContent(m);
            await processInbound({
              channel: "whatsapp",
              providerMessageId: m.id,
              receivedAt: new Date(Number(m.timestamp) * 1000),
              identities: identitiesFor(m.from),
              name: names.get(m.from) ?? null,
              kind,
              body,
              media,
              source: "whatsapp_inbound",
              sourceDetail: m.referral ? `Click-to-WhatsApp: ${m.referral.headline ?? m.referral.source_type ?? "ad"}` : null,
              waNumberId: phoneNumberId,
              replyToContextId: m.context?.id ?? null,
            });
          }
          for (const s of v.statuses ?? []) {
            await withTx((tx, fx) => applyWhatsAppStatus(tx, fx, s));
          }
          break;
        }
        case "smb_message_echoes": {
          for (const m of v.message_echoes ?? []) {
            const { kind, body, media } = extractContent(m);
            await recordExternalOutbound({
              channel: "whatsapp",
              providerMessageId: m.id,
              sentAt: new Date(Number(m.timestamp) * 1000),
              identities: identitiesFor(m.to ?? ""),
              authorType: "phone_app",
              kind,
              body,
              media,
              waNumberId: phoneNumberId,
            });
          }
          break;
        }
        case "history": {
          // Coexistence onboarding: up to ~6 months of 1:1 chat history.
          const business = (v.metadata?.display_phone_number ?? "").replace(/\D/g, "");
          for (const h of v.history ?? []) {
            for (const thread of h.threads ?? []) {
              for (const m of thread.messages ?? []) {
                const { kind, body, media } = extractContent(m);
                const fromBusiness = m.from.replace(/\D/g, "") === business;
                const counterpart = fromBusiness ? (thread.id ?? m.to ?? "") : m.from;
                if (!counterpart) continue;
                if (fromBusiness) {
                  await recordExternalOutbound({
                    channel: "whatsapp",
                    providerMessageId: m.id,
                    sentAt: new Date(Number(m.timestamp) * 1000),
                    identities: identitiesFor(counterpart),
                    authorType: "phone_app",
                    kind,
                    body,
                    media,
                    waNumberId: phoneNumberId,
                  });
                } else {
                  await processInbound({
                    channel: "whatsapp",
                    providerMessageId: m.id,
                    receivedAt: new Date(Number(m.timestamp) * 1000),
                    identities: identitiesFor(counterpart),
                    kind,
                    body,
                    media,
                    source: "whatsapp_inbound",
                    sourceDetail: "History sync",
                    waNumberId: phoneNumberId,
                    historical: true,
                    opensWindow: Date.now() - Number(m.timestamp) * 1000 < 24 * 3600_000,
                  });
                }
              }
            }
          }
          break;
        }
        case "message_template_status_update":
          await applyTemplateStatus(getDb(), v);
          break;
        case "phone_number_quality_update": {
          const db = getDb();
          await db
            .update(waNumbers)
            .set({ qualityRating: v.event ?? null, messagingLimit: v.current_limit ?? null, lastSyncedAt: new Date() })
            .where(eq(waNumbers.displayNumber, v.display_phone_number ?? ""));
          await withTx(async (tx, fx) =>
            notify(tx, fx, {
              userIds: await managerIds(tx),
              type: "wa_quality",
              title: `WhatsApp number quality update: ${v.event ?? "changed"}`,
              body: `Messaging limit: ${v.current_limit ?? "unknown"}. Check WhatsApp Manager.`,
              email: true,
            }),
          );
          break;
        }
        case "account_alerts":
        case "account_update":
        case "business_capability_update":
          await withTx(async (tx, fx) =>
            notify(tx, fx, {
              userIds: await managerIds(tx),
              type: "wa_account_alert",
              title: `WhatsApp account alert: ${change.field}`,
              body: JSON.stringify(v).slice(0, 300),
              email: true,
            }),
          );
          break;
        default:
          logger.warn({ field: change.field, webhookEventId, org: ORG_ID }, "unhandled whatsapp webhook field");
      }
    }
  }
}

/** Stable idempotency key for a webhook delivery (message/status ids, else hash of the body). */
export function whatsappExternalId(payload: WhatsAppPayload, rawHash: string): string {
  const ids: string[] = [];
  for (const e of payload.entry ?? []) {
    for (const c of e.changes ?? []) {
      for (const m of c.value?.messages ?? []) ids.push(`m:${m.id}`);
      for (const m of c.value?.message_echoes ?? []) ids.push(`e:${m.id}`);
      for (const s of c.value?.statuses ?? []) ids.push(`s:${s.id}:${s.status}`);
    }
  }
  return ids.length ? ids.sort().join("|").slice(0, 900) : `h:${rawHash}`;
}
