/**
 * Snippet variables ({{first_name}}, {{owner}}, {{plan}}) and WhatsApp template positional
 * variables ({{1}}, {{2}}) — §5.5, §8.2.
 */

export type VarContext = {
  contact?: { firstName?: string | null; lastName?: string | null; displayName?: string | null; jobTitle?: string | null };
  company?: { name?: string | null } | null;
  owner?: { name?: string | null } | null;
  lead?: { number?: number | string | null; source?: string | null; plan?: string | null };
  org?: { workingHours?: string | null };
  extra?: Record<string, string>;
};

const first = (name?: string | null) => (name ? name.split(" ")[0]! : "");

export function contextVars(ctx: VarContext): Record<string, string> {
  const firstName = ctx.contact?.firstName || first(ctx.contact?.displayName) || "there";
  return {
    first_name: firstName,
    last_name: ctx.contact?.lastName ?? "",
    name: ctx.contact?.displayName || [ctx.contact?.firstName, ctx.contact?.lastName].filter(Boolean).join(" ") || firstName,
    job_title: ctx.contact?.jobTitle ?? "",
    company: ctx.company?.name ?? "",
    owner: first(ctx.owner?.name) || "our team",
    owner_full: ctx.owner?.name ?? "our team",
    lead_number: ctx.lead?.number != null ? `L-${ctx.lead.number}` : "",
    plan: ctx.lead?.plan ?? "your",
    working_hours: ctx.org?.workingHours ?? "",
    ...(ctx.extra ?? {}),
  };
}

/** Render {{named}} variables; unknown variables are left as-is so the rep sees what's missing. */
export function renderSnippet(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (m, key: string) => (key in vars ? vars[key]! : m));
}

/** Template variable sources (templates.variables[].source) → value. */
export function resolveTemplateVariable(source: string | undefined, vars: Record<string, string>): string | undefined {
  switch (source) {
    case "contact.first_name":
      return vars.first_name;
    case "contact.name":
      return vars.name;
    case "owner.first_name":
      return vars.owner;
    case "owner.name":
      return vars.owner_full;
    case "company.name":
      return vars.company;
    case "lead.number":
      return vars.lead_number;
    case "org.working_hours":
      return vars.working_hours;
    default:
      return undefined;
  }
}

export function renderTemplateBody(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => values[key] ?? m);
}

export function templatePlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!))];
}

/** Find unfilled variables before send. */
export function missingTemplateValues(body: string, values: Record<string, string>): string[] {
  return templatePlaceholders(body).filter((k) => !values[k] || !values[k]!.trim());
}
