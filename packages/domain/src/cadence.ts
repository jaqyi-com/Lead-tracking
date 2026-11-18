import { isOpen, nextOpen, localDayKey, localParts, zonedToUtc, type Calendar } from "./business-hours";
import { windowState } from "./whatsapp-rules";

/**
 * §9.3 cadence engine decision for one due step. Pure: the worker supplies the context and executes
 * the decision. Every outcome other than "send" is logged on the lead so a rep can see exactly what
 * the system did on their behalf.
 */

export type StepSpec = {
  position: number;
  action: "send" | "task" | "move_to_nurture";
  channel: "same_channel" | "whatsapp" | "email" | "whatsapp_or_email" | "none";
  templateInternalName?: string | null;
  waBody?: string | null;
  emailSubject?: string | null;
  emailBody?: string | null;
  requiresHuman?: boolean;
};

export type CadenceContext = {
  now: Date;
  enquiryChannel: "whatsapp" | "email";
  quietHours: Calendar; // contact TZ, 09–20, holidays
  lastInboundWhatsAppAt: Date | null;
  hasWhatsApp: boolean;
  hasEmail: boolean;
  emailInvalid: boolean;
  /** Template approved and usable for this step's internal name. */
  templateApproved: boolean;
  templateCategory?: "utility" | "marketing" | "authentication" | null;
  waConsent: { utility: boolean; marketing: boolean };
  emailConsent: boolean; // false only when the contact unsubscribed
  optedOut: boolean;
  lastSendDay: string | null; // YYYY-MM-DD in contact tz
};

export type CadenceDecision =
  | { kind: "send_wa_text"; body: string; substituted: boolean; reason?: string }
  | { kind: "send_wa_template"; templateInternalName: string; substituted: boolean; reason?: string }
  | { kind: "send_email"; subject: string; body: string; substituted: boolean; reason?: string }
  | { kind: "create_task"; reason?: string }
  | { kind: "move_to_nurture" }
  | { kind: "defer"; until: Date; reason: string }
  | { kind: "suppress"; reason: string };

export function decideStep(step: StepSpec, ctx: CadenceContext): CadenceDecision {
  if (step.action === "move_to_nurture") return { kind: "move_to_nurture" };
  if (step.action === "task" || step.requiresHuman) return { kind: "create_task" };

  if (ctx.optedOut) return { kind: "suppress", reason: "Contact opted out" };

  // Quiet hours: a step due in quiet hours waits.
  if (!isOpen(ctx.quietHours, ctx.now)) {
    const until = nextOpen(ctx.quietHours, ctx.now);
    if (until) return { kind: "defer", until, reason: "Quiet hours (09:00–20:00 contact time) or holiday" };
  }

  // One channel per day maximum per contact.
  const today = localDayKey(ctx.now, ctx.quietHours.timezone);
  if (ctx.lastSendDay === today) {
    return { kind: "defer", until: startOfNextOpenDay(ctx), reason: "Already contacted today (one channel per day)" };
  }

  const wantedChannel =
    step.channel === "same_channel"
      ? ctx.enquiryChannel
      : step.channel === "whatsapp_or_email"
        ? "whatsapp"
        : step.channel === "none"
          ? null
          : step.channel;

  const canEmail = ctx.hasEmail && !ctx.emailInvalid && ctx.emailConsent;
  const emailVariant = (substitutedReason?: string): CadenceDecision => {
    if (!canEmail) {
      return {
        kind: "suppress",
        reason: substitutedReason
          ? `${substitutedReason}; no usable email either`
          : !ctx.hasEmail
            ? "No email address on file"
            : ctx.emailInvalid
              ? "Email bounced (invalid)"
              : "Contact unsubscribed from email",
      };
    }
    if (!step.emailSubject || !step.emailBody) {
      return { kind: "suppress", reason: `${substitutedReason ?? "Email step"}; no email variant configured` };
    }
    return {
      kind: "send_email",
      subject: step.emailSubject,
      body: step.emailBody,
      substituted: !!substitutedReason,
      reason: substitutedReason,
    };
  };

  if (wantedChannel === "email") return emailVariant();

  if (wantedChannel === "whatsapp") {
    if (!ctx.hasWhatsApp) return emailVariant("No WhatsApp number");
    const win = windowState(ctx.lastInboundWhatsAppAt, ctx.now);
    if (win.open && step.waBody) {
      return { kind: "send_wa_text", body: step.waBody, substituted: false };
    }
    if (win.open && step.channel === "whatsapp_or_email" && !step.templateInternalName) {
      return emailVariant("No WhatsApp text configured");
    }
    // Window closed (or no free-form body): use the approved template, else fall back to email.
    if (step.templateInternalName && ctx.templateApproved) {
      const consentOk =
        ctx.templateCategory === "marketing" ? ctx.waConsent.marketing : ctx.waConsent.utility || ctx.waConsent.marketing;
      if (!consentOk) return emailVariant("No WhatsApp consent for business-initiated messages");
      return {
        kind: "send_wa_template",
        templateInternalName: step.templateInternalName,
        substituted: win.open ? false : !!step.waBody,
        reason: win.open ? undefined : step.waBody ? "Window closed — used approved template" : undefined,
      };
    }
    return emailVariant(
      step.templateInternalName ? `Template ${step.templateInternalName} not approved` : "WhatsApp window closed and no template",
    );
  }

  return { kind: "suppress", reason: "Step has no channel" };
}

function startOfNextOpenDay(ctx: CadenceContext): Date {
  const tz = ctx.quietHours.timezone;
  const p = localParts(ctx.now, tz);
  const midnight = new Date(zonedToUtc(p.y, p.m, p.d + 1, 0, 0, tz));
  return nextOpen(ctx.quietHours, midnight) ?? midnight;
}
