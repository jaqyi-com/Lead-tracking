/**
 * §3.1.3 / §6.4: strip quoted history and signatures before showing a message in the timeline.
 * The full raw body is always kept separately (messages.body_full).
 */

const QUOTE_HEADER_PATTERNS: RegExp[] = [
  /^On .{0,200}(wrote|écrit|schrieb):\s*$/im, // Gmail / Apple Mail
  /^On .{0,120}\n.{0,120}wrote:\s*$/im, // Gmail wrapped onto two lines
  /^-{2,}\s*Original Message\s*-{2,}/im, // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^_{5,}\s*$/m, // Outlook web separator line
  /^From:\s.+\n(?:Sent|Date):\s.+/im, // Outlook header block
  /^\*?From:\*?\s.+\n\*?(?:Sent|Date):\*?\s.+/im,
];

const SIGNATURE_PATTERNS: RegExp[] = [
  /^--\s*$/m, // RFC 3676 signature separator
  /^Sent from my (iPhone|iPad|Android|Samsung|mobile|phone)/im,
  /^Sent from (Outlook|Mail|Yahoo Mail|Gmail)/im,
  /^Get Outlook for (iOS|Android)/im,
];

export function stripQuotedReply(text: string | null | undefined): string {
  if (!text) return "";
  let body = text.replace(/\r\n/g, "\n");

  let cut = body.length;
  for (const re of QUOTE_HEADER_PATTERNS) {
    const m = re.exec(body);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  body = body.slice(0, cut);

  const lines = body.split("\n").filter((l) => !/^\s*>/.test(l));
  body = lines.join("\n");

  let sigCut = body.length;
  for (const re of SIGNATURE_PATTERNS) {
    const m = re.exec(body);
    if (m && m.index < sigCut && m.index > 0) sigCut = m.index;
  }
  body = body.slice(0, sigCut);

  return body.replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip Re:/Fwd:/AW:/[EXT] prefixes for subject matching (§6.3 fallback heuristics). */
export function normaliseSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  let s = subject.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*/i, "").replace(/^\s*\[(ext|external)\]\s*/i, "");
  } while (s !== prev);
  return s.trim().toLowerCase();
}

/** §6.5: detect auto-replies and out-of-office; they are logged but never count as a client reply. */
export function isAutoReply(input: {
  headers?: Record<string, string | string[] | undefined>;
  subject?: string | null;
  from?: string | null;
}): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    h[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
  }

  const autoSubmitted = h["auto-submitted"];
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  if (/(^|,)\s*(all|oof|autoreply)\s*(,|$)/i.test(h["x-auto-response-suppress"] ?? "")) return true;
  if (/^(bulk|junk|auto_reply|list)$/i.test((h["precedence"] ?? "").trim())) return true;
  if (h["x-failed-recipients"]) return true;

  const from = (input.from ?? "").toLowerCase();
  if (/(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(from)) return true;

  const subject = (input.subject ?? "").toLowerCase();
  return /(automatic reply|auto-?reply|auto(matic)? response|out of (the )?office|\booo\b|away from (the )?office|undeliverable|delivery status notification|mail delivery failed)/.test(
    subject,
  );
}
