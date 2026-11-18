import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

function scrypt(pw: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(key, expected);
}

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Meta X-Hub-Signature-256: "sha256=<hex HMAC-SHA256 of the raw body with the app secret>". */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = "sha256=" + hmacHex(appSecret, rawBody);
  return safeEqual(expected, header.trim());
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function encKey(appSecret: string): Buffer {
  return createHash("sha256").update("enc:" + appSecret).digest();
}

/** AES-256-GCM for OAuth tokens at rest; key derived from APP_SECRET. */
export function encryptSecret(plain: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(appSecret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(blob: string, appSecret: string): string {
  const [ivS, tagS, encS] = blob.split(".");
  const decipher = createDecipheriv("aes-256-gcm", encKey(appSecret), Buffer.from(ivS!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagS!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encS!, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * §6.3 address tagging: lead+<leadId hex>-<hmac10>@inbox.doott.com.
 * The HMAC stops anyone guessing addresses that would attach mail to another lead.
 */
export function makeReplyAddress(leadId: string, secret: string, domain: string): string {
  const compact = leadId.replace(/-/g, "").toLowerCase();
  const sig = hmacHex(secret, "reply:" + compact).slice(0, 10);
  return `lead+${compact}-${sig}@${domain}`;
}

export function parseReplyAddress(address: string, secret: string): string | null {
  const m = address.toLowerCase().match(/lead\+([0-9a-f]{32})-([0-9a-f]{10})@/);
  if (!m) return null;
  const compact = m[1]!;
  const sig = m[2]!;
  const expected = hmacHex(secret, "reply:" + compact).slice(0, 10);
  if (!safeEqual(expected, sig)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** One-click unsubscribe token (§6.4 / RFC 8058). */
export function makeUnsubscribeToken(contactId: string, secret: string): string {
  return `${contactId}.${hmacHex(secret, "unsub:" + contactId).slice(0, 16)}`;
}

export function parseUnsubscribeToken(token: string, secret: string): string | null {
  const [contactId, sig] = token.split(".");
  if (!contactId || !sig) return null;
  return safeEqual(hmacHex(secret, "unsub:" + contactId).slice(0, 16), sig) ? contactId : null;
}
