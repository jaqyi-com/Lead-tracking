/**
 * §9.4 rule-based, transparent lead scoring. A rep can always see why a lead scored 70.
 */

export type ScoreInput = {
  companySizeBand?: string | null;
  icpSizeBands?: string[];
  jobTitle?: string | null;
  qualification?: Record<string, unknown>;
  hasBusinessEmailDomain: boolean;
  hasCompany: boolean;
  emailVerified: boolean;
  repliedWithinHourOfFirstTouch: boolean;
  askedPricingOrTrial: boolean;
  requestedSample: boolean;
  isReferral: boolean;
  outsideServiceableGeo: boolean;
  noReplyAfterThreeTouches: boolean;
  competitorOrStudent: boolean;
};

export type ScoreLine = { rule: string; points: number };
export type ScoreResult = { score: number; band: "hot" | "warm" | "low"; breakdown: ScoreLine[] };

export const DEFAULT_ICP_SIZE_BANDS = ["11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"];

const BUYER_TITLE = /\b(founder|co-?founder|ceo|cxo|owner|director|managing director|md|vp|vice president|head of|head|chief|cmo|cro|chro|hr head|marketing head|sales head|partner|proprietor)\b/i;

export function isBuyerTitle(title: string | null | undefined): boolean {
  return !!title && BUYER_TITLE.test(title);
}

export function scoreLead(input: ScoreInput): ScoreResult {
  const lines: ScoreLine[] = [];
  const add = (rule: string, points: number, when: boolean) => {
    if (when) lines.push({ rule, points });
  };
  const icp = input.icpSizeBands ?? DEFAULT_ICP_SIZE_BANDS;
  const q = input.qualification ?? {};
  const size = (q.employee_band as string | undefined) ?? input.companySizeBand ?? null;
  const title = (q.contact_role as string | undefined) ?? input.jobTitle ?? null;
  const segmentWithVolume = !!q.target_segment && Number(q.volume) > 0;

  add("Company size matches ICP band", 15, !!size && icp.includes(size));
  add("Buyer role", 15, isBuyerTitle(title));
  add("Target segment stated with volume", 15, segmentWithVolume);
  add("Business email domain", 10, input.hasBusinessEmailDomain);
  add("Verified deliverable email", 5, input.emailVerified);
  add("Replied within 1 hour of first touch", 10, input.repliedWithinHourOfFirstTouch);
  add("Asked about pricing or a trial", 15, input.askedPricingOrTrial);
  add("Requested sample data", 10, input.requestedSample || q.trial_requested === true);
  add("Referral or existing customer", 10, input.isReferral);
  add("Free email provider only, no company", -10, !input.hasBusinessEmailDomain && !input.hasCompany);
  add("Outside serviceable geography", -15, input.outsideServiceableGeo);
  add("No reply after three touches", -10, input.noReplyAfterThreeTouches);
  add("Competitor or student/research enquiry", -25, input.competitorOrStudent);

  const score = lines.reduce((s, l) => s + l.points, 0);
  return { score, band: scoreBand(score), breakdown: lines };
}

export function scoreBand(score: number): "hot" | "warm" | "low" {
  return score >= 60 ? "hot" : score >= 30 ? "warm" : "low";
}

const PRICING = /\b(price|pricing|cost|quote|quotation|rate|rates|charges|plan|plans|kitna|trial|demo|free credits)\b/i;
const SAMPLE = /\b(sample|samples|test data|trial data|demo data|sample list)\b/i;
const STUDENT = /\b(student|college project|thesis|research project|assignment|internship|phd|dissertation)\b/i;

export function textSignals(text: string): { askedPricingOrTrial: boolean; requestedSample: boolean; studentOrResearch: boolean } {
  return {
    askedPricingOrTrial: PRICING.test(text),
    requestedSample: SAMPLE.test(text),
    studentOrResearch: STUDENT.test(text),
  };
}
