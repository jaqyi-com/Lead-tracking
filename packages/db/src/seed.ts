/**
 * pnpm db:seed
 *   SEED_ADMIN_EMAIL=you@doott.com SEED_ADMIN_PASSWORD=... pnpm db:seed   → also creates/updates an admin
 *   SEED_DEMO=1 pnpm db:seed                                               → adds demo reps for local dev
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "@lead/domain";
import { getDb, closeDb } from "./client";
import { seedBase, DEFAULT_ORG_ID, DEFAULT_TEAM_ID } from "./seed-data";
import { templates, users } from "./schema";

const db = getDb();
await seedBase(db);
console.log("base seed applied");

async function upsertUser(email: string, name: string, role: "admin" | "manager" | "rep", password: string) {
  const passwordHash = await hashPassword(password);
  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (existing.length) {
    await db.update(users).set({ passwordHash, role, name }).where(eq(users.email, email.toLowerCase()));
  } else {
    await db.insert(users).values({
      orgId: DEFAULT_ORG_ID,
      email: email.toLowerCase(),
      name,
      role,
      passwordHash,
      teamId: DEFAULT_TEAM_ID,
    });
  }
  console.log(`user ${email} (${role}) ready`);
}

if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
  await upsertUser(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_NAME ?? "Admin", "admin", process.env.SEED_ADMIN_PASSWORD);
}

if (process.env.SEED_DEMO === "1") {
  await upsertUser("admin@doott.local", "Admin User", "admin", "admin12345");
  await upsertUser("manager@doott.local", "Meera Manager", "manager", "manager12345");
  await upsertUser("priya@doott.local", "Priya Sharma", "rep", "rep12345");
  await upsertUser("arjun@doott.local", "Arjun Patel", "rep", "rep12345");
  // Dev only: with MESSAGING_PROVIDER=fake nothing reaches Meta, so treat templates as approved
  // locally. In staging/production approval status comes from Meta's template webhook.
  if ((process.env.MESSAGING_PROVIDER ?? "fake") === "fake") {
    await db.update(templates).set({ approvalStatus: "approved" });
    console.log("templates marked approved (fake provider, dev only)");
  }
}

await closeDb();
