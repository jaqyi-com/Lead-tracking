/**
 * Website form intake (§4.1 form-intake). Consent is captured with the notice version and IP so it
 * can be proven later (§11.4).
 */
import { z } from "zod";
import { normaliseEmail, normalisePhone, cleanName } from "@lead/domain";
import type { IdentityInput } from "../identity";
import { processInbound, type InboundResult } from "./inbound";

export const formSchema = z.object({
  submission_id: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  job_title: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  message: z.string().max(10_000).optional(),
  page_url: z.string().max(2000).optional(),
  utm_source: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  consent_marketing: z.union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("false")]).optional(),
  notice_version: z.string().max(50).optional(),
  website: z.string().max(0).optional(), // honeypot: must be empty
});

export type FormSubmission = z.infer<typeof formSchema>;

export async function processForm(f: FormSubmission, meta: { eventId: string; ip?: string; receivedAt: Date }): Promise<InboundResult> {
  const identities: IdentityInput[] = [];
  const email = normaliseEmail(f.email);
  const phone = normalisePhone(f.phone);
  if (email) identities.push({ kind: "email", value: email, raw: f.email });
  if (phone) identities.push({ kind: "phone", value: phone.e164, raw: f.phone });
  if (!identities.length) throw new Error("Form submission has no valid email or phone");

  const optIn = f.consent_marketing === true || f.consent_marketing === "on" || f.consent_marketing === "true";
  const body = [f.message, f.company && `Company: ${f.company}`, f.page_url && `Page: ${f.page_url}`].filter(Boolean).join("\n");

  return processInbound({
    // Reply by email when we have one, otherwise WhatsApp (template only — a form doesn't open the window).
    channel: email ? "email" : "whatsapp",
    providerMessageId: `form:${f.submission_id ?? meta.eventId}`,
    receivedAt: meta.receivedAt,
    identities,
    name: cleanName(f.name),
    jobTitle: f.job_title ?? null,
    companyName: f.company ?? null,
    city: f.city ?? null,
    kind: "form",
    body: body || "(website form, no message)",
    subject: "Website enquiry",
    source: "website_form",
    sourceDetail: [f.utm_source, f.utm_campaign, f.page_url].filter(Boolean).join(" · ") || null,
    opensWindow: false,
    isPortal: true,
    marketingOptIn: optIn
      ? {
          channel: "all",
          noticeVersion: f.notice_version,
          ip: meta.ip,
          evidence: { form: f.page_url ?? "website", submissionId: f.submission_id ?? meta.eventId, checkbox: "consent_marketing" },
        }
      : null,
  });
}
