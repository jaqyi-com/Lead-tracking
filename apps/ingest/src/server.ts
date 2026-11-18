import { Queue } from "bullmq";
import { env, logger } from "@lead/config";
import { DEFAULT_JOB_OPTS, redisConnection } from "@lead/core";
import { buildIngest } from "./app";

const connection = redisConnection();
const queue = new Queue("ingest", { connection, defaultJobOptions: DEFAULT_JOB_OPTS });

const app = await buildIngest({
  enqueue: async (id) => {
    await queue.add("ingest.process", { webhookEventId: id }, { jobId: `evt-${id}` });
  },
  healthCheck: async () => (await connection.ping()) === "PONG",
});

await app.listen({ port: env.INGEST_PORT, host: "0.0.0.0" });
logger.info(`ingest listening on :${env.INGEST_PORT}`);

const shutdown = async () => {
  await app.close();
  await queue.close();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
