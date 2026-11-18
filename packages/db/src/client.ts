import { drizzle as drizzlePg, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";
import { env } from "@lead/config";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Works for the root db and for transactions (PgTransaction extends PgDatabase). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<NodePgQueryResultHKT, Schema, any>;

let pool: pg.Pool | undefined;
let dbInstance: Db | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10) });
  }
  return pool;
}

export function getDb(): Db {
  if (!dbInstance) dbInstance = drizzlePg(getPool(), { schema }) as unknown as Db;
  return dbInstance;
}

/** Tests inject a PGlite-backed db here. */
export function setDb(db: Db): void {
  dbInstance = db;
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  dbInstance = undefined;
}
