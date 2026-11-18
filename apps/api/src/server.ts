import { env, logger } from "@lead/config";
import { BullSink, setEffectSink } from "@lead/core";
import { buildApi } from "./app";
import { attachRealtime } from "./realtime";

const sink = new BullSink();
setEffectSink(sink);

const app = await buildApi();
await app.ready();
const io = attachRealtime(app.server);
await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
logger.info(`api listening on :${env.API_PORT}`);

const shutdown = async () => {
  io.close();
  await app.close();
  await sink.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
