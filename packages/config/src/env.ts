import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";

/** Walk up from cwd to find the repo-root .env (apps run with cwd = apps/<name>). */
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envFile = findEnvFile();
if (envFile) loadDotenv({ path: envFile });

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().default("http://localhost:3000"),
  API_URL: z.string().default("http://localhost:4000"),
  INGEST_PUBLIC_URL: z.string().default("http://localhost:4100"),
  DATABASE_URL: z.string().default("postgres://lead@localhost:5434/lead_os"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  APP_SECRET: z.string().min(32).default("dev-secret-dev-secret-dev-secret-dev-secret"),
  DEFAULT_ORG_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000001"),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGINS: csv,
  API_PORT: z.coerce.number().default(4000),
  INGEST_PORT: z.coerce.number().default(4100),

  MESSAGING_PROVIDER: z.enum(["cloud", "fake"]).default("fake"),
  WA_GRAPH_VERSION: z.string().default("v21.0"),
  WA_APP_SECRET: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default("dev-verify-token"),
  WA_ACCESS_TOKEN: z.string().default(""),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_WABA_ID: z.string().default(""),
  WA_FREE_SERVICE_ALLOWANCE: z.coerce.number().default(1000),

  INBOUND_DOMAIN: z.string().default("inbox.doott.com"),
  POSTMARK_INBOUND_USER: z.string().default("postmark"),
  POSTMARK_INBOUND_PASSWORD: z.string().default("dev-inbound-password"),
  INTERNAL_DOMAINS: csv,
  SHARED_MAILBOXES: csv,
  SYSTEM_MAIL_PROVIDER: z.enum(["ses", "log"]).default("log"),
  SYSTEM_MAIL_FROM: z.string().default("Doott Sales <sales@mail.doott.com>"),
  AWS_REGION: z.string().default("ap-south-1"),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_PUBSUB_TOPIC: z.string().default(""),
  GOOGLE_PUBSUB_VERIFICATION_TOKEN: z.string().default("dev-pubsub-token"),
  GOOGLE_WORKSPACE_DOMAIN: z.string().default(""),

  FORM_INTAKE_SECRET: z.string().default("dev-form-secret"),

  S3_ENDPOINT: z.string().default(""),
  S3_BUCKET: z.string().default("lead-os"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_REGION: z.string().default("auto"),
  LOCAL_STORAGE_DIR: z.string().default(".devdata/storage"),

  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  DOOTT_ENRICH_URL: z.string().default(""),
  DOOTT_ENRICH_API_KEY: z.string().default(""),

  SENTRY_DSN: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env: Env = parsed.data;

/** Repo root (directory holding the .env file, or cwd). */
export const repoRoot = envFile ? dirname(envFile) : process.cwd();

if (env.NODE_ENV === "production") {
  const required: (keyof Env)[] = ["APP_SECRET", "DATABASE_URL", "REDIS_URL"];
  if (env.MESSAGING_PROVIDER === "cloud") required.push("WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID");
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env ${key} in production`);
  }
  if (env.APP_SECRET.startsWith("dev-secret")) throw new Error("APP_SECRET must be set in production");
}
