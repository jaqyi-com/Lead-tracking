import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getPool, closeDb } from "./client";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

await migrate(drizzle(getPool()), { migrationsFolder });
console.log("migrations applied");
await closeDb();
