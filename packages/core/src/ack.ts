/**
 * §9.2 auto-acknowledgement. The acknowledgement never stops the SLA clock — only a human does.
 */
import { and, eq, gt } from "drizzle-orm";
import { conversations, users, type Db } from "@lead/db";
import { contextVars, describeHours, isOpen, renderSnippet, windowState } from "@lead/domain";
import type { Fx } from "./effects";
import { DomainError } from "./errors";
import type { Lead } from "./leads";
import type { Conversation } from "./conversations";
import { getOrCreateConversation } from "./conversations";
import { queueMessage } from "./outbound";
import { templateByInternalName, varContextForLead } from "./templates";
import { SYSTEM, calendarForTeam, logActivity } from "./support";

const DAY = 86_400_000;

export async function autoAcknowledge(
  tx: Db,
  fx: Fx,
  input: { lead: Lead; conversation: Conversation; isPortal?: boolean; portalEmail?: string | null; now?: Date },
): Promise<void> {
  const { lead, conversation } = input;
  const now = input.now ?? new Date();
  if (lead.isJunk || conversation.isJunk) return;
  // At most one acknowledgement per conversation per 24h.
  if (conversation.lastAutoAckAt && now.getTime() - conversation.lastAutoAckAt.getTime() < DAY) return;

  const cal = await calendarForTeam(tx, lead.teamId);
  const open = isOpen(cal, now);
  const ctx = await varContextForLead(tx, lead.id);
  const vars = contextVars(ctx);
  const [owner] = lead.ownerId ? await tx.select().from(users).where(eq(users.id, lead.ownerId)) : [];
  const hours = describeHours(cal);

  const sent: string[] = [];
  const tryQueue = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn();
      sent.push(label);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      await logActivity(tx, lead.id, "auto_ack_skipped", SYSTEM, { channel: label, reason: err.message });
    }
  };

  if (conversation.channel === "whatsapp") {
    const win = windowState(conversation.lastInboundAt, now);
    if (win.open && open) {
      const body = owner
        ? renderSnippet("Hi {{first_name}}, thanks for reaching out to Doott! {{owner}} will reply here within a few minutes.", vars)
        : renderSnippet("Hi {{first_name}}, thanks for reaching out to Doott! Someone from our team will reply here within a few minutes.", vars);
      await tryQueue(
        () => queueMessage(tx, fx, { conversationId: conversation.id, actor: SYSTEM, type: "text", body, isAuto: true, idempotencyKey: `ack:${conversation.id}:${dayKey(now)}` }),
        "whatsapp_text",
      );
    } else {
      const tpl = await templateByInternalName(tx, open ? "lead_ack" : "after_hours_ack", lead.language ?? "en");
      if (tpl) {
        await tryQueue(
          () =>
            queueMessage(tx, fx, {
              conversationId: conversation.id,
              actor: SYSTEM,
              type: "template",
              templateId: tpl.id,
              templateValues: open ? {} : { "2": hours },
              isAuto: true,
              idempotencyKey: `ack:${conversation.id}:${dayKey(now)}`,
            }),
          `whatsapp_template_${tpl.internalName}`,
        );
      }
    }
  }

  // Portal/form leads (no direct message yet): WhatsApp utility template + email, both count as the
  // first touch attempt (§9.2).
  if (input.isPortal && conversation.channel !== "whatsapp") {
    const { contactRoutes } = await import("./identity");
    const routes = await contactRoutes(tx, lead.contactId);
    if (routes.phone || routes.waId) {
      const tpl = await templateByInternalName(tx, open ? "lead_ack" : "after_hours_ack", lead.language ?? "en");
      if (tpl) {
        const { conversation: waConv } = await getOrCreateConversation(tx, { leadId: lead.id, contactId: lead.contactId, channel: "whatsapp", assignedTo: lead.ownerId });
        await tryQueue(
          () =>
            queueMessage(tx, fx, {
              conversationId: waConv.id,
              actor: SYSTEM,
              type: "template",
              templateId: tpl.id,
              templateValues: open ? {} : { "2": hours },
              isAuto: true,
              idempotencyKey: `ack:${waConv.id}:${dayKey(now)}`,
            }),
          `whatsapp_template_${tpl.internalName}`,
        );
        await tx.update(conversations).set({ lastAutoAckAt: now }).where(eq(conversations.id, waConv.id));
      }
    }
  }

  if (conversation.channel === "email" || input.isPortal) {
    const emailConv =
      conversation.channel === "email"
        ? conversation
        : input.portalEmail
          ? (await getOrCreateConversation(tx, { leadId: lead.id, contactId: lead.contactId, channel: "email", assignedTo: lead.ownerId })).conversation
          : null;
    if (emailConv && !(await ackedEmailRecently(tx, lead.contactId, now, emailConv.id))) {
      const ownerLine = owner ? `${vars.owner} from our team will reply shortly.` : "Our team will reply shortly.";
      const body = open
        ? `Hi ${vars.first_name},\n\nThanks for contacting Doott — we've received your enquiry (reference L-${lead.number}). ${ownerLine}\n\nDoott Sales`
        : `Hi ${vars.first_name},\n\nThanks for contacting Doott — we've received your enquiry (reference L-${lead.number}). Our team is available ${hours}, and we'll reply as soon as we're back.\n\nDoott Sales`;
      await tryQueue(
        () =>
          queueMessage(tx, fx, {
            conversationId: emailConv.id,
            actor: SYSTEM,
            type: "email",
            subject: emailConv.subject ? `Re: ${emailConv.subject.replace(/^re:\s*/i, "")}` : `We've received your enquiry [L-${lead.number}]`,
            body,
            isAuto: true,
            idempotencyKey: `ack:${emailConv.id}:${dayKey(now)}`,
          }),
        "email",
      );
      await tx.update(conversations).set({ lastAutoAckAt: now }).where(eq(conversations.id, emailConv.id));
    }
  }

  await tx.update(conversations).set({ lastAutoAckAt: now }).where(eq(conversations.id, conversation.id));
  if (sent.length) await logActivity(tx, lead.id, "auto_ack_sent", SYSTEM, { channels: sent, businessHours: open });
}

/** Email auto-reply at most once per 24 hours per contact (§9.2). */
async function ackedEmailRecently(tx: Db, contactId: string, now: Date, exceptConversationId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.contactId, contactId), eq(conversations.channel, "email"), gt(conversations.lastAutoAckAt, new Date(now.getTime() - DAY))));
  return rows.some((r) => r.id !== exceptConversationId) || false;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
