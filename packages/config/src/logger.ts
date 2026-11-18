import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.access_token", "*.refresh_token", "*.password"],
    censor: "[redacted]",
  },
  transport:
    env.NODE_ENV === "development" && !process.env.VERCEL && !process.env.LOG_JSON
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});

export type Logger = typeof logger;
