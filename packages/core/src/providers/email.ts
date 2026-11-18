/**
 * Outbound email (§6.4):
 *  - Rep-to-client mail goes through the rep's own Gmail when mailbox sync is connected.
 *  - System mail (acks, notifications, digests, bulk) goes through SES on a separate subdomain.
 */
import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env, logger } from "@lead/config";
import { ProviderError } from "../errors";

export type OutboundEmail = {
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  messageId?: string; // "<id@domain>"
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
};

export type EmailSendResult = { providerMessageId: string; messageId: string; threadId?: string };

export function newMessageId(domain = env.INBOUND_DOMAIN): string {
  return `<${randomUUID()}@${domain}>`;
}

export async function buildMime(m: OutboundEmail): Promise<Buffer> {
  const composer = new MailComposer({
    from: m.from,
    to: m.to,
    cc: m.cc,
    replyTo: m.replyTo,
    subject: m.subject,
    text: m.text,
    html: m.html,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references?.length ? m.references.join(" ") : undefined,
    headers: m.headers,
    attachments: m.attachments,
  });
  return new Promise((resolve, reject) => composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
}

export interface SystemMailer {
  send(m: OutboundEmail): Promise<EmailSendResult>;
}

class SesMailer implements SystemMailer {
  private client = new SESv2Client({ region: env.AWS_REGION });
  async send(m: OutboundEmail) {
    const messageId = m.messageId ?? newMessageId();
    const raw = await buildMime({ ...m, messageId });
    try {
      const r = await this.client.send(new SendEmailCommand({ Content: { Raw: { Data: raw } } }));
      return { providerMessageId: r.MessageId ?? messageId, messageId };
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      throw new ProviderError(e.name ?? "ses_error", e.message ?? "SES send failed", (e.$metadata?.httpStatusCode ?? 500) >= 500);
    }
  }
}

export class LogMailer implements SystemMailer {
  sent: OutboundEmail[] = [];
  async send(m: OutboundEmail) {
    const messageId = m.messageId ?? newMessageId();
    this.sent.push({ ...m, messageId });
    logger.info({ to: m.to, subject: m.subject, messageId }, "[log mailer] email");
    return { providerMessageId: `log-${randomUUID()}`, messageId };
  }
}

let mailer: SystemMailer | undefined;
export function getSystemMailer(): SystemMailer {
  if (!mailer) mailer = env.SYSTEM_MAIL_PROVIDER === "ses" ? new SesMailer() : new LogMailer();
  return mailer;
}
export function setSystemMailer(m: SystemMailer) {
  mailer = m;
}
