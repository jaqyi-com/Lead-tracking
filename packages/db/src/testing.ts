import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
import { setDb, type Db } from "./client";
import { seedBase } from "./seed-data";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Fresh in-memory Postgres (PGlite) with all migrations + base seed. Used by integration tests. */
export async function createTestDb(opts: { seed?: boolean } = {}): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder, migrationsSchema: process.env.DB_SCHEMA || "public", migrationsTable: "los_drizzle_migrations" });
  if (opts.seed !== false) await seedBase(db);
  setDb(db);
  return { db, client };
}
