import { describe, it, expect } from "vitest";
import { createTestDb } from "./testing";
import { sql } from "drizzle-orm";

describe("migrations + seed", () => {
  it("apply cleanly on a fresh database and seed is idempotent", async () => {
    const { db, client } = await createTestDb();
    const { seedBase } = await import("./seed-data");
    await seedBase(db);
    const r = await db.execute(sql`select count(*)::int as n from los_lead_sources`);
    expect((r.rows[0] as { n: number }).n).toBeGreaterThan(5);
    const t = await db.execute(sql`select count(*)::int as n from los_templates`);
    expect((t.rows[0] as { n: number }).n).toBe(10);
    await client.close();
  });
});
