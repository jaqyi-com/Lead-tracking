import { and, eq, inArray, sql } from "drizzle-orm";
import { env } from "@lead/config";
import {
  activities,
  auditLog,
  businessHours,
  holidays,
  notifications,
  teams,
  users,
  type AuthorType,
  type Db,
} from "@lead/db";
import type { Calendar } from "@lead/domain";
import type { Fx } from "./effects";

export const ORG_ID = env.DEFAULT_ORG_ID;

export type Actor = { type: AuthorType; id?: string | null; ip?: string | null };
export const SYSTEM: Actor = { type: "system", id: null };

/** Append-only timeline entry (§2 principle 4). Always written in the same tx as the change. */
export async function logActivity(
  tx: Db,
  leadId: string,
  type: string,
  actor: Actor,
  payload: Record<string, unknown> = {},
  occurredAt: Date = new Date(),
): Promise<void> {
  await tx.insert(activities).values({
    orgId: ORG_ID,
    leadId,
    type,
    actorType: actor.type,
    actorId: actor.id ?? null,
    payload,
    occurredAt,
  });
}

export async function audit(
  tx: Db,
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: ORG_ID,
    actorId: actor.id ?? null,
    actorType: actor.type,
    action,
    entity,
    entityId,
    before: before ?? null,
    after: after ?? null,
    ip: actor.ip ?? null,
  });
}

export async function notify(
  tx: Db,
  fx: Fx,
  n: {
    userIds: (string | null | undefined)[];
    type: string;
    title: string;
    body?: string;
    leadId?: string;
    conversationId?: string;
    push?: boolean;
    email?: boolean;
  },
): Promise<void> {
  const ids = [...new Set(n.userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await tx.insert(notifications).values(
    ids.map((userId) => ({
      orgId: ORG_ID,
      userId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      leadId: n.leadId ?? null,
      conversationId: n.conversationId ?? null,
    })),
  );
  fx.publish({ type: "notification", orgId: ORG_ID, userIds: ids, leadId: n.leadId, data: { title: n.title, kind: n.type } });
  if (n.push !== false) {
    fx.enqueue("notify.push", { userIds: ids, title: n.title, body: n.body ?? "", leadId: n.leadId, conversationId: n.conversationId });
  }
  if (n.email) fx.enqueue("notify.email", { userIds: ids, title: n.title, body: n.body ?? "", leadId: n.leadId });
}

export async function managerIds(tx: Db): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["manager", "admin"])));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Calendars (cached briefly — business hours change rarely)
// ---------------------------------------------------------------------------

const calCache = new Map<string, { at: number; cal: Calendar }>();
let holidayCache: { at: number; days: string[] } | undefined;

export function clearCalendarCache(): void {
  calCache.clear();
  holidayCache = undefined;
}

export async function orgHolidays(db: Db): Promise<string[]> {
  if (holidayCache && Date.now() - holidayCache.at < 60_000) return holidayCache.days;
  const rows = await db.select({ day: holidays.day }).from(holidays);
  holidayCache = { at: Date.now(), days: rows.map((r) => String(r.day)) };
  return holidayCache.days;
}

export async function calendarById(db: Db, businessHoursId: string | null | undefined): Promise<Calendar> {
  const key = businessHoursId ?? "default";
  const hit = calCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.cal;
  const rows = businessHoursId
    ? await db.select().from(businessHours).where(eq(businessHours.id, businessHoursId))
    : await db.select().from(businessHours).orderBy(businessHours.createdAt).limit(1);
  const bh = rows[0];
  const cal: Calendar = bh
    ? { timezone: bh.timezone, weekly: bh.weekly, holidays: await orgHolidays(db) }
    : { timezone: "Asia/Kolkata", weekly: {}, holidays: [] };
  calCache.set(key, { at: Date.now(), cal });
  return cal;
}

/** Calendar governing a lead's SLA: owner's team, else the default. */
export async function calendarForTeam(db: Db, teamId: string | null | undefined): Promise<Calendar> {
  if (teamId) {
    const [t] = await db.select({ bh: teams.businessHoursId }).from(teams).where(eq(teams.id, teamId));
    if (t?.bh) return calendarById(db, t.bh);
  }
  return calendarById(db, null);
}

export async function calendarForUser(db: Db, userId: string): Promise<Calendar> {
  const [u] = await db.select({ wh: users.workingHoursId, teamId: users.teamId }).from(users).where(eq(users.id, userId));
  if (u?.wh) return calendarById(db, u.wh);
  return calendarForTeam(db, u?.teamId);
}

/** Postgres advisory lock for the rest of the transaction (per-identity serialisation, plan §3.2). */
export async function lockKey(tx: Db, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

export function preview(text: string | null | undefined, max = 140): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
