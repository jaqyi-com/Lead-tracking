/**
 * Pipeline stages, transitions and the qualification block (§3.2, §3.3, §8.4).
 */

export const STAGES = [
  "new",
  "attempting",
  "engaged",
  "qualified",
  "quoted",
  "negotiation",
  "won",
  "lost",
  "disqualified",
  "nurture",
] as const;
export type Stage = (typeof STAGES)[number];

export const OPEN_STAGES: Stage[] = ["new", "attempting", "engaged", "qualified", "quoted", "negotiation"];
export const CLOSED_STAGES: Stage[] = ["won", "lost", "disqualified", "nurture"];
export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  attempting: "Attempting",
  engaged: "Engaged",
  qualified: "Qualified",
  quoted: "Quoted",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
  nurture: "Nurture",
};

/** Funnel order used by reports (§10). */
export const FUNNEL: Stage[] = ["new", "attempting", "engaged", "qualified", "quoted", "won"];

export function isClosed(stage: Stage): boolean {
  return CLOSED_STAGES.includes(stage);
}

const rank: Record<Stage, number> = {
  new: 0,
  attempting: 1,
  engaged: 2,
  qualified: 3,
  quoted: 4,
  negotiation: 5,
  won: 6,
  lost: 9,
  disqualified: 9,
  nurture: 9,
};

/** Stages strictly past Engaged require the qualification block. */
export function requiresQualification(stage: Stage): boolean {
  return stage === "qualified" || stage === "quoted" || stage === "negotiation" || stage === "won";
}

export type QualificationField = {
  key: string;
  label: string;
  type: "text" | "select" | "boolean" | "date" | "number" | "textarea";
  options?: string[];
  required: boolean;
};

/** §3.3 — ten fields, free to type at any time, required before advancing past Engaged. */
export const QUALIFICATION_FIELDS: QualificationField[] = [
  { key: "company_website", label: "Company & website", type: "text", required: true },
  { key: "industry", label: "Industry", type: "text", required: true },
  {
    key: "employee_band",
    label: "Employee band",
    type: "select",
    options: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"],
    required: true,
  },
  { key: "contact_role", label: "Contact's role", type: "text", required: true },
  { key: "can_sign", label: "Can sign?", type: "boolean", required: true },
  {
    key: "use_case",
    label: "Use case",
    type: "select",
    options: ["sales_prospecting", "recruiting", "marketing", "data_enrichment", "research"],
    required: true,
  },
  { key: "target_segment", label: "Target segment (geo, industry, titles, size)", type: "textarea", required: true },
  { key: "volume", label: "Volume needed (records/credits per month)", type: "number", required: true },
  { key: "current_tool", label: "Current tool & what's wrong with it", type: "textarea", required: false },
  {
    key: "budget_band",
    label: "Budget band",
    type: "select",
    options: ["<25k", "25k-1L", "1L-5L", "5L+", "unknown"],
    required: true,
  },
  {
    key: "timeline",
    label: "Buying timeline",
    type: "select",
    options: ["this_week", "this_month", "this_quarter", "later", "unknown"],
    required: true,
  },
  { key: "trial_requested", label: "Trial / sample requested", type: "boolean", required: false },
  { key: "trial_date", label: "Trial / sample date", type: "date", required: false },
  { key: "source_described", label: "Source of enquiry (client's words)", type: "text", required: false },
];

export function missingQualification(q: Record<string, unknown> | null | undefined): string[] {
  const v = q ?? {};
  return QUALIFICATION_FIELDS.filter((f) => f.required)
    .filter((f) => {
      const x = v[f.key];
      if (f.type === "boolean") return typeof x !== "boolean";
      return x === undefined || x === null || String(x).trim() === "";
    })
    .map((f) => f.key);
}

export type TransitionInput = {
  from: Stage;
  to: Stage;
  qualification: Record<string, unknown>;
  lostReason?: string | null;
  revisitAt?: Date | string | null;
  validLostReasons?: string[];
  actor: "user" | "system";
};

export type TransitionResult = { ok: true } | { ok: false; errors: { code: string; message: string }[] };

/** §8.4 rules 1–2 plus Nurture revisit date. System transitions (cadence, inbound reply) skip human-only rules. */
export function validateTransition(input: TransitionInput): TransitionResult {
  const errors: { code: string; message: string }[] = [];
  const { from, to } = input;
  if (from === to) return { ok: true };

  if (isClosed(from) && to !== from) {
    errors.push({ code: "closed", message: "Closed leads cannot be reopened. A new enquiry creates a new lead." });
  }
  if (requiresQualification(to)) {
    const missing = missingQualification(input.qualification);
    if (missing.length) {
      errors.push({
        code: "qualification_incomplete",
        message: `Complete the qualification block first (missing: ${missing.join(", ")}).`,
      });
    }
  }
  if (to === "lost") {
    if (!input.lostReason) errors.push({ code: "lost_reason_required", message: "Choose a lost reason." });
    else if (input.validLostReasons && !input.validLostReasons.includes(input.lostReason)) {
      errors.push({ code: "lost_reason_invalid", message: "Lost reason must come from the fixed list." });
    }
  }
  if (to === "nurture" && !input.revisitAt) {
    errors.push({ code: "revisit_required", message: "Set a revisit date (30/60/90 days)." });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function isForwardMove(from: Stage, to: Stage): boolean {
  return rank[to] > rank[from];
}

/** §8.4 rule 3 — human saves of open leads must carry a next step with a date. */
export function validateNextStep(stage: Stage, nextStepAt: Date | string | null | undefined): string | null {
  if (isClosed(stage)) return null;
  return nextStepAt ? null : "Set the next step with a date before saving.";
}
