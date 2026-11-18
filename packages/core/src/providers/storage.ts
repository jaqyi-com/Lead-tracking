/**
 * Object storage (R2/S3) with short-lived signed URLs; local-disk fallback for development.
 * No public buckets (§11.2).
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve, normalize } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, repoRoot } from "@lead/config";
import { hmacHex, safeEqual } from "@lead/domain";

export interface Storage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSeconds?: number, filename?: string): Promise<string>;
}

class S3Storage implements Storage {
  private client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: !!env.S3_ENDPOINT,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });

  async put(key: string, data: Buffer, mime: string) {
    await this.client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: data, ContentType: mime }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
  async signedUrl(key: string, ttlSeconds = 300, filename?: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ResponseContentDisposition: filename ? `inline; filename="${filename.replace(/"/g, "")}"` : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }
}

/** Dev storage: files under LOCAL_STORAGE_DIR, served by the API at /files/<key>?exp&sig. */
class LocalStorage implements Storage {
  private root = resolve(repoRoot, env.LOCAL_STORAGE_DIR);
  private path(key: string) {
    const p = normalize(resolve(this.root, key));
    if (!p.startsWith(this.root)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    const { rm } = await import("node:fs/promises");
    await rm(this.path(key), { force: true });
  }
  async signedUrl(key: string, ttlSeconds = 300) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = hmacHex(env.APP_SECRET, `file:${key}:${exp}`).slice(0, 32);
    return `${env.API_URL}/files/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
  }
}

export function verifyLocalFileSignature(key: string, exp: string, sig: string): boolean {
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(hmacHex(env.APP_SECRET, `file:${key}:${exp}`).slice(0, 32), sig);
}

let storage: Storage | undefined;
export function getStorage(): Storage {
  if (!storage) storage = env.S3_ENDPOINT || env.S3_ACCESS_KEY_ID ? new S3Storage() : new LocalStorage();
  return storage;
}
export function setStorage(s: Storage) {
  storage = s;
}
