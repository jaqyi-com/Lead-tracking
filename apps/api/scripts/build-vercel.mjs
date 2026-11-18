// Bundles the API + ingest into one Node function using Vercel's Build Output API v3.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, ".vercel/output");
const fn = resolve(out, "functions/index.func");
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/vercel.ts")],
  outfile: resolve(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  // pg's optional native binding and dev-only log prettifier are never used at runtime.
  external: ["pg-native", "pino-pretty"],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

writeFileSync(resolve(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 60 }, null, 2));
writeFileSync(
  resolve(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "/(.*)", dest: "/index" }],
      // Hobby plans allow daily crons only; the app also self-schedules on traffic (maybeTick).
      crons: [{ path: "/api/cron/tick", schedule: "0 3 * * *" }],
    },
    null,
    2,
  ),
);
console.log("vercel output written to", out);
