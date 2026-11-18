/**
 * §5.5 template library: mirrors Meta's registry; values pre-filled from lead data.
 */
import { and, eq } from "drizzle-orm";
import { companies, contacts, leads, templates, users, type Db } from "@lead/db";
import { contextVars, describeHours, resolveTemplateVariable, renderTemplateBody, type VarContext } from "@lead/domain";
import { getMessagingProvider } from "./providers/messaging";
import { ORG_ID, calendarForTeam } from "./support";

export type Template = typeof templates.$inferSelect;

export async function templateByInternalName(db: Db, internalName: string, language = "en"): Promise<Template | undefined> {
  const rows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.internalName, internalName), eq(templates.channel, "whatsapp")));
  return rows.find((t) => t.language === language) ?? rows.find((t) => t.language.startsWith("en")) ?? rows[0];
}

export async function varContextForLead(db: Db, leadId: string): Promise<VarContext> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return {};
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
  const [company] = lead.companyId ? await db.select().from(companies).where(eq(companies.id, lead.companyId)) : [];
  const [owner] = lead.ownerId ? await db.select().from(users).where(eq(users.id, lead.ownerId)) : [];
  const cal = await calendarForTeam(db, lead.teamId);
  return {
    contact: contact ?? undefined,
    company: company ?? null,
    owner: owner ?? null,
    lead: { number: lead.number, source: lead.source },
    org: { workingHours: describeHours(cal) },
  };
}

/** Ordered positional values for a template ({{1}}, {{2}} …), auto-filled where the source is known. */
export function fillTemplateValues(t: Template, ctx: VarContext, overrides: Record<string, string> = {}): Record<string, string> {
  const vars = contextVars(ctx);
  const out: Record<string, string> = {};
  for (const v of t.variables) {
    out[v.key] = overrides[v.key] ?? resolveTemplateVariable(v.source, vars) ?? "";
  }
  for (const [k, v] of Object.entries(overrides)) out[k] = v;
  return out;
}

export function orderedParams(t: Template, values: Record<string, string>): string[] {
  const keys = t.variables.length ? t.variables.map((v) => v.key) : Object.keys(values).sort((a, b) => Number(a) - Number(b));
  return keys.map((k) => values[k] ?? "");
}

export function renderTemplate(t: Template, values: Record<string, string>): string {
  return renderTemplateBody(t.body, values);
}

/** Pull Meta's template list and upsert approval status, category and body. */
export async function syncTemplatesFromProvider(db: Db): Promise<{ updated: number; created: number }> {
  const remote = await getMessagingProvider().listTemplates();
  let updated = 0;
  let created = 0;
  for (const r of remote) {
    const status = r.status === "approved" ? "approved" : r.status;
    const existing = await db
      .select()
      .from(templates)
      .where(and(eq(templates.providerName, r.name), eq(templates.language, r.language), eq(templates.channel, "whatsapp")));
    if (existing[0]) {
      await db
        .update(templates)
        .set({
          providerTemplateId: r.id,
          approvalStatus: status,
          category: r.category as Template["category"],
          body: r.body || existing[0].body,
          footer: r.footer ?? existing[0].footer,
          buttons: r.buttons,
          rejectionReason: r.rejectedReason ?? null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(templates.id, existing[0].id));
      updated++;
    } else {
      const placeholders = [...r.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]!);
      await db.insert(templates).values({
        orgId: ORG_ID,
        channel: "whatsapp",
        internalName: r.name,
        providerName: r.name,
        providerTemplateId: r.id,
        category: r.category as Template["category"],
        language: r.language,
        body: r.body,
        footer: r.footer ?? null,
        buttons: r.buttons,
        variables: [...new Set(placeholders)].map((key) => ({ key, source: "manual" })),
        approvalStatus: status,
        rejectionReason: r.rejectedReason ?? null,
        lastSyncedAt: new Date(),
      });
      created++;
    }
  }
  return { updated, created };
}

/** Template status webhook (message_template_status_update). */
export async function applyTemplateStatus(
  db: Db,
  v: { message_template_id?: string | number; message_template_name?: string; message_template_language?: string; event?: string; reason?: string },
): Promise<void> {
  const status = String(v.event ?? "").toLowerCase();
  if (!status) return;
  const where = v.message_template_id
    ? eq(templates.providerTemplateId, String(v.message_template_id))
    : and(eq(templates.providerName, v.message_template_name ?? ""), eq(templates.language, v.message_template_language ?? "en"));
  await db
    .update(templates)
    .set({ approvalStatus: status, rejectionReason: v.reason && v.reason !== "NONE" ? v.reason : null, lastSyncedAt: new Date() })
    .where(where);
}

export async function submitTemplate(db: Db, templateId: string): Promise<Template> {
  const [t] = await db.select().from(templates).where(eq(templates.id, templateId));
  if (!t) throw new Error("template not found");
  const examples = t.variables.map((v) => v.example ?? "example");
  const r = await getMessagingProvider().submitTemplate({
    name: t.providerName,
    language: t.language,
    category: t.category,
    body: t.body,
    examples,
  });
  const [u] = await db
    .update(templates)
    .set({ providerTemplateId: r.id, approvalStatus: r.status, updatedAt: new Date() })
    .where(eq(templates.id, t.id))
    .returning();
  return u!;
}
