import { sql } from "drizzle-orm";
import type { Db } from "./client";
import * as s from "./schema";

export const DEFAULT_ORG_ID = process.env.DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000001";
export const DEFAULT_HOURS_ID = "00000000-0000-0000-0000-0000000000b1";
export const DEFAULT_TEAM_ID = "00000000-0000-0000-0000-0000000000a1";
const DEFAULT_SEQUENCE_ID = "00000000-0000-0000-0000-0000000000c1";

const FREE_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rediffmail.com",
  "rediff.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me", "zoho.com", "zohomail.in", "gmx.com", "mail.com", "yandex.com",
  "inbox.com", "hotmail.co.in", "outlook.in", "live.in", "sify.com", "indiatimes.com", "tutanota.com",
];

const LEAD_SOURCES: [string, string][] = [
  ["whatsapp_inbound", "WhatsApp inbound"],
  ["email_shared", "Email — shared mailbox"],
  ["email_rep", "Email — rep mailbox"],
  ["website_form", "Website form"],
  ["indiamart", "IndiaMART"],
  ["tradeindia", "TradeIndia"],
  ["justdial", "Justdial"],
  ["linkedin", "LinkedIn"],
  ["referral", "Referral / existing customer"],
  ["cold_reply", "Reply to outbound"],
  ["manual", "Manual entry"],
  ["import", "CSV import"],
];

const LOST_REASONS: [string, string][] = [
  ["price", "Price too high"],
  ["competitor", "Chose a competitor"],
  ["no_budget", "No budget"],
  ["timing", "Bad timing"],
  ["coverage", "Data coverage didn't fit"],
  ["went_silent", "Went silent after full cadence"],
  ["no_decision", "No decision made"],
  ["requirements", "Requirements we can't meet"],
  ["other", "Other"],
];

type TemplateSeed = {
  internalName: string;
  category: s.TemplateCategory;
  body: string;
  header?: string;
  variables: s.TemplateVariable[];
  emailSubject?: string;
};

const WA_TEMPLATES: TemplateSeed[] = [
  {
    internalName: "lead_ack",
    category: "utility",
    body: "Hi {{1}}, thanks for contacting Doott. We've received your enquiry and {{2}} will reply shortly.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "owner.first_name", example: "Priya" },
    ],
  },
  {
    internalName: "after_hours_ack",
    category: "utility",
    body: "Hi {{1}}, thanks for contacting Doott. Our team is available {{2}}. We'll reply as soon as we're back.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "org.working_hours", example: "Mon–Sat, 9:30am–6:30pm IST" },
    ],
  },
  {
    internalName: "follow_up_1",
    category: "utility",
    body: "Hi {{1}}, following up on your enquiry with Doott. Shall I share a sample list for your requirement?",
    variables: [{ key: "1", source: "contact.first_name", example: "Rahul" }],
  },
  {
    internalName: "follow_up_2",
    category: "utility",
    body: "Hi {{1}}, checking in one last time on your Doott enquiry. Would you like to go ahead? A quick yes or no helps us plan.",
    variables: [{ key: "1", source: "contact.first_name", example: "Rahul" }],
  },
  {
    internalName: "quote_sent",
    category: "utility",
    header: "DOCUMENT",
    body: "Hi {{1}}, your quote from Doott is attached. Reference: {{2}}. Reply here with any questions.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "lead.number", example: "L-1042" },
    ],
  },
  {
    internalName: "meeting_confirm",
    category: "utility",
    body: "Hi {{1}}, your Doott demo with {{2}} is confirmed for {{3}}.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "owner.first_name", example: "Priya" },
      { key: "3", source: "manual", example: "Tue 3 Dec, 3:00pm IST" },
    ],
  },
  {
    internalName: "meeting_reminder",
    category: "utility",
    body: "Hi {{1}}, a reminder that your Doott demo starts at {{2}}.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "manual", example: "3:00pm IST" },
    ],
  },
  {
    internalName: "sample_data_ready",
    category: "utility",
    body: "Hi {{1}}, your sample list from Doott is ready. You can download it here: {{2}}",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "manual", example: "https://doott.com/s/abc" },
    ],
  },
  {
    internalName: "reengagement_offer",
    category: "marketing",
    body: "Hi {{1}}, Doott now covers {{2}}. Want a fresh sample for your team? Reply STOP to opt out.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "manual", example: "2M more verified contacts in Gujarat" },
    ],
  },
  {
    internalName: "feature_announcement",
    category: "marketing",
    body: "Hi {{1}}, new on Doott: {{2}}. Reply to this message to learn more, or STOP to opt out.",
    variables: [
      { key: "1", source: "contact.first_name", example: "Rahul" },
      { key: "2", source: "manual", example: "verified mobile numbers for HR heads" },
    ],
  },
];

const SNIPPETS: { shortcut: string; title: string; body: string; folder: string }[] = [
  {
    shortcut: "intro",
    folder: "Openers",
    title: "First reply",
    body: "Hi {{first_name}}, this is {{owner}} from Doott. Thanks for reaching out! To share the right data, could you tell me: which industry / job titles you're targeting, which cities or states, and roughly how many contacts per month you need?",
  },
  {
    shortcut: "sample",
    folder: "Openers",
    title: "Offer sample",
    body: "Happy to share a free sample of 25 verified records matching your segment so you can check quality before deciding. Shall I prepare it?",
  },
  {
    shortcut: "pricing",
    folder: "Pricing",
    title: "Pricing overview",
    body: "Our pricing depends on volume and the fields you need (email, mobile, verified status). For {{plan}} volumes, I'll send a quote today — could you confirm the monthly volume you expect?",
  },
  {
    shortcut: "call",
    folder: "Scheduling",
    title: "Propose a call",
    body: "Would a 15-minute call be easier? I'm free today and tomorrow — share a time that works and I'll send an invite.",
  },
];

/** Base reference data. Idempotent: safe to run repeatedly. */
export async function seedBase(db: Db): Promise<void> {
  const orgId = DEFAULT_ORG_ID;
  await db.insert(s.orgs).values({ id: orgId, name: "Doott" }).onConflictDoNothing();

  await db
    .insert(s.businessHours)
    .values({
      id: DEFAULT_HOURS_ID,
      orgId,
      name: "India office",
      timezone: "Asia/Kolkata",
      weekly: {
        "1": [["09:30", "18:30"]],
        "2": [["09:30", "18:30"]],
        "3": [["09:30", "18:30"]],
        "4": [["09:30", "18:30"]],
        "5": [["09:30", "18:30"]],
        "6": [["10:00", "14:00"]],
      },
    })
    .onConflictDoNothing();

  await db
    .insert(s.teams)
    .values({ id: DEFAULT_TEAM_ID, orgId, name: "Sales", businessHoursId: DEFAULT_HOURS_ID })
    .onConflictDoNothing();

  // Fixed-date national holidays; admins add festival dates per year in Admin → Business hours.
  const holidayRows = [
    ["2026-01-26", "Republic Day"],
    ["2026-08-15", "Independence Day"],
    ["2026-10-02", "Gandhi Jayanti"],
    ["2026-12-25", "Christmas"],
    ["2027-01-26", "Republic Day"],
    ["2027-08-15", "Independence Day"],
    ["2027-10-02", "Gandhi Jayanti"],
    ["2027-12-25", "Christmas"],
  ];
  const existingHolidays = await db.select({ day: s.holidays.day }).from(s.holidays);
  const have = new Set(existingHolidays.map((h) => String(h.day)));
  const newHolidays = holidayRows.filter(([d]) => !have.has(d!));
  if (newHolidays.length) {
    await db.insert(s.holidays).values(
      newHolidays.map(([day, name]) => ({ orgId, businessHoursId: DEFAULT_HOURS_ID, day: day!, name: name! })),
    );
  }

  await db
    .insert(s.freeEmailDomains)
    .values(FREE_EMAIL_DOMAINS.map((domain) => ({ domain })))
    .onConflictDoNothing();

  await db
    .insert(s.leadSources)
    .values(LEAD_SOURCES.map(([key, label]) => ({ orgId, key, label })))
    .onConflictDoNothing();

  await db
    .insert(s.lostReasons)
    .values(LOST_REASONS.map(([key, label]) => ({ orgId, key, label })))
    .onConflictDoNothing();

  const [{ n: slaCount }] = (await db.execute(sql`select count(*)::int as n from sla_policies`)).rows as { n: number }[];
  if (!slaCount) {
    // §3.2 SLA column. Minutes are business minutes (1 working day = 540).
    await db.insert(s.slaPolicies).values([
      { orgId, kind: "assignment", stage: "new", targetMinutes: 2 },
      { orgId, kind: "first_response", stage: "attempting", targetMinutes: 5 },
      { orgId, kind: "reply", stage: "engaged", targetMinutes: 120 },
      { orgId, kind: "stage_exit", stage: "qualified", targetMinutes: 540 },
      { orgId, kind: "stage_exit", stage: "quoted", targetMinutes: 1080 },
      { orgId, kind: "stage_exit", stage: "negotiation", targetMinutes: 540 },
    ]);
  }

  const [{ n: ruleCount }] = (await db.execute(sql`select count(*)::int as n from routing_rules`)).rows as { n: number }[];
  if (!ruleCount) {
    await db.insert(s.routingRules).values({
      orgId,
      name: "Default — round robin across Sales",
      priority: 1000,
      conditions: {},
      strategy: "round_robin",
      targetTeamId: DEFAULT_TEAM_ID,
      fallback: "unassigned",
    });
  }

  await db
    .insert(s.templates)
    .values(
      WA_TEMPLATES.map((t) => ({
        orgId,
        channel: "whatsapp" as const,
        internalName: t.internalName,
        providerName: t.internalName,
        category: t.category,
        language: "en",
        header: t.header ?? null,
        body: t.body,
        variables: t.variables,
        approvalStatus: "draft",
      })),
    )
    .onConflictDoNothing();

  const [{ n: snippetCount }] = (await db.execute(sql`select count(*)::int as n from snippets`)).rows as { n: number }[];
  if (!snippetCount) await db.insert(s.snippets).values(SNIPPETS.map((x) => ({ ...x, orgId })));

  await db
    .insert(s.sequences)
    .values({
      id: DEFAULT_SEQUENCE_ID,
      orgId,
      name: "Default inbound lead",
      isDefault: true,
      entryCondition: { stage: "attempting" },
    })
    .onConflictDoNothing();

  // §9.3 default sequence. Spec step 1 (acknowledgement) is sent by the auto-acknowledgement at
  // capture time (§9.2), so the enrolled sequence starts at spec step 2.
  const H = 60;
  const D = 24 * 60;
  await db
    .insert(s.sequenceSteps)
    .values([
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 1,
        offsetMinutes: 3 * H,
        offsetBusiness: true,
        action: "task",
        channel: "whatsapp_or_email",
        requiresHuman: true,
        taskTitle: "Personal first touch (WhatsApp if window open, else email)",
      },
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 2,
        offsetMinutes: 1 * D,
        action: "send",
        channel: "whatsapp",
        templateInternalName: "follow_up_1",
        emailSubject: "Your data enquiry with Doott",
        emailBody:
          "Hi {{first_name}},\n\nStill happy to help with your enquiry — shall I share a sample list for your segment?\n\n{{owner}}\nDoott",
      },
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 3,
        offsetMinutes: 3 * D,
        action: "send",
        channel: "email",
        emailSubject: "A sample from Doott for your segment",
        emailBody:
          "Hi {{first_name}},\n\nTeams like yours usually start by checking a small sample against their own CRM. I can prepare 25 verified records for your target segment — just reply with the industry, city and job titles.\n\n{{owner}}\nDoott",
      },
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 4,
        offsetMinutes: 7 * D,
        action: "send",
        channel: "whatsapp",
        templateInternalName: "follow_up_2",
        emailSubject: "Shall we go ahead?",
        emailBody:
          "Hi {{first_name}},\n\nChecking in one last time — would you like to go ahead? A quick yes or no helps us plan.\n\n{{owner}}\nDoott",
      },
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 5,
        offsetMinutes: 14 * D,
        action: "send",
        channel: "email",
        emailSubject: "Closing your enquiry for now",
        emailBody:
          "Hi {{first_name}},\n\nI haven't heard back, so I'll close this enquiry for now. If your plans change, just reply to this email any time and I'll pick it up.\n\n{{owner}}\nDoott",
      },
      {
        sequenceId: DEFAULT_SEQUENCE_ID,
        position: 6,
        offsetMinutes: 15 * D,
        action: "move_to_nurture",
        channel: "none",
        revisitDays: 60,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(s.rateCard)
    .values([
      { country: "IN", category: "marketing", currency: "INR", rate: "0.8631", effectiveFrom: "2026-10-01" },
      { country: "IN", category: "utility", currency: "INR", rate: "0.1150", effectiveFrom: "2026-10-01" },
      { country: "IN", category: "authentication", currency: "INR", rate: "0.1150", effectiveFrom: "2026-10-01" },
      { country: "IN", category: "service", currency: "INR", rate: "0.1150", effectiveFrom: "2026-10-01" },
      { country: "US", category: "marketing", currency: "USD", rate: "0.0250", effectiveFrom: "2026-10-01" },
      { country: "US", category: "utility", currency: "USD", rate: "0.0034", effectiveFrom: "2026-10-01" },
      { country: "US", category: "authentication", currency: "USD", rate: "0.0034", effectiveFrom: "2026-10-01" },
      { country: "US", category: "service", currency: "USD", rate: "0.0034", effectiveFrom: "2026-10-01" },
    ])
    .onConflictDoNothing();

  await db
    .insert(s.noticeVersions)
    .values({
      orgId,
      version: "2026-11-v1",
      body:
        "Doott (Doott Technologies) collects your name, phone number, email address, company and enquiry details to respond to your enquiry and, if you agree, to send you updates about our products on WhatsApp and email. You can withdraw consent at any time by replying STOP on WhatsApp or using the unsubscribe link in our emails. Contact our grievance officer at privacy@doott.com.",
    })
    .onConflictDoNothing();
}
