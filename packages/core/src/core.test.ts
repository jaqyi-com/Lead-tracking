import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb } from "@lead/db/src/testing";
import * as s from "@lead/db";
import { hashPassword, makeReplyAddress } from "@lead/domain";
import { env } from "@lead/config";
import {
  InlineSink,
  setEffectSink,
  clearCalendarCache,
  processWhatsAppPayload,
  processEmail,
  fromPostmark,
  processForm,
  queueMessage,
  withTx,
  changeStage,
  updateLead,
  consentStatus,
  processTimer,
  runEnrollment,
  refreshReportViews,
  todayDashboard,
  funnelReport,
  speedToLead,
  teamReport,
  channelCostReport,
  search,
  previewBroadcast,
  mergeContacts,
  importLeads,
  parseCsv,
  anonymiseContact,
  storeWebhookEvent,
  processWebhookEvent,
  type DomainError,
  type WhatsAppPayload,
  type PostmarkInbound,
} from "./index";

type DB = s.Db;
let db: DB;
let sink: InlineSink;
let repA: string;
let repB: string;
let manager: string;

const waPayload = (from: string, id: string, body: string, name = "Rahul Kumar", ts = Math.floor(Date.now() / 1000)): WhatsAppPayload => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "919000000000", phone_number_id: "PNID" },
            contacts: [{ profile: { name }, wa_id: from }],
            messages: [{ from, id, timestamp: String(ts), type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

const postmark = (over: Partial<PostmarkInbound> & { headers?: Record<string, string> }): PostmarkInbound => ({
  MessageID: crypto.randomUUID(),
  From: over.From ?? "rahul@acme.co.in",
  FromFull: { Email: over.From ?? "rahul@acme.co.in", Name: "Rahul Kumar" },
  To: over.To ?? "sales@doott.com",
  ToFull: [{ Email: over.To ?? "sales@doott.com" }],
  Subject: over.Subject ?? "Need HR contacts in Pune",
  TextBody: over.TextBody ?? "Hi, we need 5000 HR head contacts in Pune. What is the pricing?",
  Headers: Object.entries({ "Message-ID": `<${crypto.randomUUID()}@acme.co.in>`, ...(over.headers ?? {}) }).map(([Name, Value]) => ({ Name, Value })),
  ...over,
});

async function q<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  // Open 24x7 so routing/ack behave deterministically regardless of when tests run.
  const allDay: Record<string, [string, string][]> = {};
  for (let d = 0; d < 7; d++) allDay[String(d)] = [["00:00", "24:00"]];
  await db.update(s.businessHours).set({ weekly: allDay });
  await db.delete(s.holidays);
  clearCalendarCache();
  const pw = await hashPassword("x");
  const [a, b, m] = await db
    .insert(s.users)
    .values([
      { orgId: env.DEFAULT_ORG_ID, name: "Priya Sharma", email: "priya@t.local", role: "rep", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw },
      { orgId: env.DEFAULT_ORG_ID, name: "Arjun Patel", email: "arjun@t.local", role: "rep", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw },
      { orgId: env.DEFAULT_ORG_ID, name: "Meera M", email: "meera@t.local", role: "manager", teamId: s.DEFAULT_TEAM_ID, passwordHash: pw },
    ])
    .returning();
  repA = a!.id;
  repB = b!.id;
  manager = m!.id;
  // Templates approved for most tests.
  await db.update(s.templates).set({ approvalStatus: "approved" });
});

beforeEach(() => {
  sink = new InlineSink();
  setEffectSink(sink);
});

describe("WhatsApp capture → lead with owner (Phase 1 done-criterion)", () => {
  it("creates contact, lead, conversation, routes, acknowledges", async () => {
    await processWhatsAppPayload(waPayload("919876543210", "wamid.A1", "Hi, need HR data for Pune. Price?"));
    const [lead] = await db.select().from(s.leads);
    expect(lead).toBeDefined();
    expect(lead!.source).toBe("whatsapp_inbound");
    expect(lead!.ownerId).toBeTruthy();
    expect(lead!.stage).toBe("attempting");
    const ids = await db.select().from(s.channelIdentities).where(eq(s.channelIdentities.contactId, lead!.contactId));
    expect(ids.map((i) => `${i.kind}:${i.valueNormalised}`).sort()).toEqual(["phone:+919876543210", "wa_id:919876543210"]);
    const msgs = await db.select().from(s.messages).where(eq(s.messages.leadId, lead!.id));
    const ack = msgs.find((m) => m.direction === "outbound");
    expect(ack?.isAuto).toBe(true);
    expect(ack?.status).toBe("sent");
    // Auto-ack must leave the conversation in "awaiting our reply".
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead!.id));
    expect(conv!.state).toBe("waiting_us");
    // Auto-ack must NOT count as first response.
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, lead!.id));
    expect(after!.firstResponseAt).toBeNull();
    // Enquiry gives utility consent, not marketing.
    const c = await consentStatus(db, lead!.contactId);
    expect(c.whatsapp.utility).toBe(true);
    expect(c.whatsapp.marketing).toBe(false);
    // Enrolled in the default cadence.
    const enr = await db.select().from(s.enrollments).where(eq(s.enrollments.leadId, lead!.id));
    expect(enr[0]?.state).toBe("active");
  });

  it("is idempotent on duplicate deliveries", async () => {
    await processWhatsAppPayload(waPayload("919876543210", "wamid.A1", "Hi, need HR data for Pune. Price?"));
    const n = await q<{ n: number }>(sql`select count(*)::int as n from messages where provider_message_id = 'wamid.A1'`);
    expect(n[0]!.n).toBe(1);
  });

  it("same-second messages from a new number produce one contact, one lead, one owner", async () => {
    await Promise.all([
      processWhatsAppPayload(waPayload("919811111111", "wamid.B1", "hello")),
      processWhatsAppPayload(waPayload("919811111111", "wamid.B2", "need data")),
    ]);
    const leads = await q<{ n: number; owners: number }>(sql`
      select count(*)::int as n, count(distinct owner_id)::int as owners from leads l
      join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919811111111'`);
    expect(leads[0]).toEqual({ n: 1, owners: 1 });
  });

  it("human reply stamps first response and stops SLA; window rules are enforced server-side", async () => {
    const [lead] = await q<{ id: string; conv: string }>(sql`
      select l.id, c.id as conv from leads l join conversations c on c.lead_id = l.id
      join channel_identities ci on ci.contact_id = l.contact_id and ci.value_normalised = '919876543210' limit 1`);
    await withTx((tx, fx) =>
      queueMessage(tx, fx, { conversationId: lead!.conv, actor: { type: "user", id: repA }, type: "text", body: "Hi Rahul, Priya here. What volume?" }),
    );
    const [l] = await db.select().from(s.leads).where(eq(s.leads.id, lead!.id));
    expect(l!.firstResponseAt).not.toBeNull();
    expect(l!.firstResponseBusinessMinutes).toBeGreaterThanOrEqual(0);
    const timers = await db.select().from(s.slaTimers).where(and(eq(s.slaTimers.leadId, lead!.id), eq(s.slaTimers.kind, "first_response")));
    expect(timers[0]!.state).toBe("met");

    // Close the window: free-form must be refused, template allowed.
    await db.update(s.conversations).set({ lastInboundAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(s.conversations.id, lead!.conv));
    await expect(
      withTx((tx, fx) => queueMessage(tx, fx, { conversationId: lead!.conv, actor: { type: "user", id: repA }, type: "text", body: "hello?" })),
    ).rejects.toMatchObject({ code: "window_closed" });
    const [tpl] = await db.select().from(s.templates).where(eq(s.templates.internalName, "follow_up_1"));
    const m = await withTx((tx, fx) =>
      queueMessage(tx, fx, { conversationId: lead!.conv, actor: { type: "user", id: repA }, type: "template", templateId: tpl!.id }),
    );
    expect(m.body).toContain("Rahul");
    const [sent] = await db.select().from(s.messages).where(eq(s.messages.id, m.id));
    expect(sent!.status).toBe("sent");
  });

  it("refuses unapproved templates and marketing without opt-in", async () => {
    const [conv] = await q<{ id: string }>(sql`select c.id from conversations c join channel_identities ci on ci.contact_id = c.contact_id and ci.value_normalised = '919876543210' where c.channel = 'whatsapp' limit 1`);
    const [mkt] = await db.select().from(s.templates).where(eq(s.templates.internalName, "reengagement_offer"));
    await expect(
      withTx((tx, fx) => queueMessage(tx, fx, { conversationId: conv!.id, actor: { type: "user", id: repA }, type: "template", templateId: mkt!.id, templateValues: { "2": "Gujarat" } })),
    ).rejects.toMatchObject({ code: "no_consent" });
    await db.update(s.templates).set({ approvalStatus: "pending" }).where(eq(s.templates.internalName, "follow_up_2"));
    const [t2] = await db.select().from(s.templates).where(eq(s.templates.internalName, "follow_up_2"));
    await expect(
      withTx((tx, fx) => queueMessage(tx, fx, { conversationId: conv!.id, actor: { type: "user", id: repA }, type: "template", templateId: t2!.id })),
    ).rejects.toMatchObject({ code: "template_not_approved" });
    await db.update(s.templates).set({ approvalStatus: "approved" }).where(eq(s.templates.internalName, "follow_up_2"));
  });

  it("applies delivered/read status webhooks and pricing", async () => {
    const [m] = await q<{ provider_message_id: string; id: string }>(sql`select id, provider_message_id from messages where direction = 'outbound' and provider_message_id is not null limit 1`);
    await processWhatsAppPayload({
      entry: [{ id: "W", changes: [{ field: "messages", value: { statuses: [{ id: m!.provider_message_id, status: "read", timestamp: String(Math.floor(Date.now() / 1000)), pricing: { billable: true, category: "service" } }] } }] }],
    });
    const [after] = await db.select().from(s.messages).where(eq(s.messages.id, m!.id));
    expect(after!.status).toBe("read");
    expect(after!.pricingCategory).toBe("service");
    expect(after!.deliveredAt).not.toBeNull();
  });

  it("client reply moves Attempting → Engaged and stops the cadence", async () => {
    await processWhatsAppPayload(waPayload("919876543210", "wamid.A2", "About 5000 records per month"));
    const [l] = await q<{ stage: string; id: string }>(sql`select l.stage, l.id from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919876543210'`);
    expect(l!.stage).toBe("engaged");
    const enr = await db.select().from(s.enrollments).where(eq(s.enrollments.leadId, l!.id));
    expect(enr[0]!.state).toBe("stopped");
    expect(enr[0]!.stopReason).toBe("client_replied");
  });

  it("STOP withdraws consent immediately and confirms", async () => {
    await processWhatsAppPayload(waPayload("919822222222", "wamid.C1", "need data"));
    await processWhatsAppPayload(waPayload("919822222222", "wamid.C2", "STOP"));
    const [c] = await q<{ contact_id: string }>(sql`select contact_id from channel_identities where value_normalised = '919822222222'`);
    const st = await consentStatus(db, c!.contact_id);
    expect(st.whatsapp.optedOut).toBe(true);
    const conf = await q<{ body: string }>(sql`select m.body from messages m join leads l on l.id = m.lead_id where l.contact_id = ${c!.contact_id} and m.direction = 'outbound' order by m.created_at desc limit 1`);
    expect(conf[0]!.body).toMatch(/unsubscribed/i);
  });

  it("coexistence echoes count as human first response (author phone_app)", async () => {
    await processWhatsAppPayload(waPayload("919833333333", "wamid.D1", "hi"));
    await processWhatsAppPayload({
      entry: [
        {
          id: "W",
          changes: [
            {
              field: "smb_message_echoes",
              value: { metadata: { phone_number_id: "PNID" }, message_echoes: [{ from: "919000000000", to: "919833333333", id: "wamid.D2", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Replying from my phone" } }] },
            },
          ],
        },
      ],
    });
    const [l] = await q<{ first_response_at: string | null }>(sql`select l.first_response_at from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919833333333'`);
    expect(l!.first_response_at).not.toBeNull();
    const [m] = await db.select().from(s.messages).where(eq(s.messages.providerMessageId, "wamid.D2"));
    expect(m!.authorType).toBe("phone_app");
  });
});

describe("email capture and threading (§6)", () => {
  it("shared mailbox mail creates a lead with a company from the domain", async () => {
    const mid = "<first-1@acme.co.in>";
    await processEmail(fromPostmark(postmark({ headers: { "Message-ID": mid } })));
    const [lead] = await q<{ id: string; source: string; company: string; owner_id: string }>(sql`
      select l.id, l.source, co.name as company, l.owner_id from leads l join companies co on co.id = l.company_id where co.domain = 'acme.co.in'`);
    expect(lead!.source).toBe("email_shared");
    expect(lead!.company).toBe("Acme");
    expect(lead!.owner_id).toBeTruthy();
  });

  it("replies thread by In-Reply-To onto the same lead", async () => {
    const [ack] = await q<{ email_message_id: string; lead_id: string }>(sql`
      select m.email_message_id, m.lead_id from messages m join leads l on l.id = m.lead_id join companies co on co.id = l.company_id
      where co.domain = 'acme.co.in' and m.direction = 'outbound' and m.email_message_id is not null limit 1`);
    expect(ack).toBeDefined();
    await processEmail(fromPostmark(postmark({ Subject: "Re: Need HR contacts in Pune", TextBody: "Thanks!\n\nOn Tue, Priya wrote:\n> hi", headers: { "In-Reply-To": ack!.email_message_id } })));
    const n = await q<{ n: number }>(sql`select count(*)::int as n from leads l join companies co on co.id = l.company_id where co.domain = 'acme.co.in'`);
    expect(n[0]!.n).toBe(1);
    const [last] = await q<{ body: string }>(sql`select body from messages where lead_id = ${ack!.lead_id} and direction = 'inbound' order by created_at desc limit 1`);
    expect(last!.body).toBe("Thanks!");
  });

  it("reply-address tag threads even when headers are mangled", async () => {
    const [l] = await q<{ id: string }>(sql`select l.id from leads l join companies co on co.id = l.company_id where co.domain = 'acme.co.in'`);
    const addr = makeReplyAddress(l!.id, env.APP_SECRET, env.INBOUND_DOMAIN);
    await processEmail(fromPostmark(postmark({ From: "colleague@acme.co.in", To: addr, Subject: "something else", TextBody: "Looping in my colleague" })));
    const [m] = await q<{ lead_id: string }>(sql`select lead_id from messages where body = 'Looping in my colleague'`);
    expect(m!.lead_id).toBe(l!.id);
  });

  it("out-of-office never creates a lead and never counts as a reply", async () => {
    await processEmail(fromPostmark(postmark({ From: "ooo@newco.com", Subject: "Automatic reply: hello", headers: { "Auto-Submitted": "auto-replied" } })));
    const n = await q<{ n: number }>(sql`select count(*)::int as n from channel_identities where value_normalised = 'ooo@newco.com'`);
    expect(n[0]!.n).toBe(0);
  });

  it("IndiaMART notifications become fully populated leads and dedupe on portal id", async () => {
    const text = `Buyer's Enquiry\nEnquiry ID: IM-778899\nName: Suresh Mehta\nMobile: +91-98200 12345\nEmail: suresh@mehtatraders.in\nCompany: Mehta Traders\nCity: Ahmedabad, Gujarat\nProduct: B2B contact database\nQuantity: 10000 records\nMessage: Need distributor contacts in Gujarat`;
    const mail = { From: "buyleads@indiamart.com", Subject: "Enquiry for B2B contact database from Suresh Mehta", TextBody: text };
    await processEmail(fromPostmark(postmark(mail)));
    await processEmail(fromPostmark(postmark(mail))); // duplicate notification, different Message-ID
    const leads = await q<{ id: string; source: string; portal_lead_id: string; name: string; owner_id: string }>(sql`
      select l.id, l.source, l.portal_lead_id, c.display_name as name, l.owner_id from leads l join contacts c on c.id = l.contact_id where l.source = 'indiamart'`);
    expect(leads.length).toBe(1);
    expect(leads[0]!.portal_lead_id).toBe("IM-778899");
    expect(leads[0]!.name).toBe("Suresh Mehta");
    const ids = await q<{ value_normalised: string }>(sql`select ci.value_normalised from channel_identities ci join leads l on l.contact_id = ci.contact_id where l.id = ${leads[0]!.id} order by 1`);
    expect(ids.map((i) => i.value_normalised)).toEqual(["+919820012345", "suresh@mehtatraders.in"]);
    // §9.2: portal lead → WhatsApp utility template AND email, both automatic.
    const acks = await q<{ channel: string; kind: string }>(sql`select channel, kind from messages where lead_id = ${leads[0]!.id} and direction = 'outbound' and is_auto order by channel`);
    expect(acks).toEqual([{ channel: "email", kind: "email" }, { channel: "whatsapp", kind: "template" }]);
  });

  it("portal parse failure still creates a lead, flagged for the admin queue", async () => {
    await processEmail(fromPostmark(postmark({ From: "alerts@tradeindia.com", Subject: "New TradeIndia inquiry", TextBody: "A buyer is interested. Log in to view." })));
    const [pf] = await q<{ parser: string; lead_id: string }>(sql`select parser, lead_id from parse_failures`);
    expect(pf!.parser).toBe("tradeindia");
    const [l] = await db.select().from(s.leads).where(eq(s.leads.id, pf!.lead_id));
    expect(l!.parseFailed).toBe(true);
  });

  it("vendor spam goes to junk, not the pipeline", async () => {
    await processEmail(fromPostmark(postmark({ From: "sales@seo-guru.biz", Subject: "SEO services to rank your website #1", TextBody: "We offer link building." })));
    const [l] = await q<{ is_junk: boolean; owner_id: string | null }>(sql`select l.is_junk, l.owner_id from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = 'sales@seo-guru.biz'`);
    expect(l!.is_junk).toBe(true);
    expect(l!.owner_id).toBeNull();
  });
});

describe("website form, consent ledger", () => {
  it("records marketing opt-in with notice version and IP", async () => {
    await processForm(
      { name: "Anita Rao", email: "anita@bigco.com", phone: "9876500000", message: "Demo please", consent_marketing: true, notice_version: "2026-11-v1" },
      { eventId: "form-1", ip: "1.2.3.4", receivedAt: new Date() },
    );
    const [c] = await q<{ contact_id: string }>(sql`select contact_id from channel_identities where value_normalised = 'anita@bigco.com'`);
    const st = await consentStatus(db, c!.contact_id);
    expect(st.whatsapp.marketing).toBe(true);
    expect(st.records.find((r) => r.purpose === "marketing")!.noticeVersion).toBe("2026-11-v1");
    expect(st.records.find((r) => r.purpose === "marketing")!.ip).toBe("1.2.3.4");
  });

  it("webhook events are stored once and processed through the dispatcher", async () => {
    const payload = { form: { name: "Dev Shah", email: "dev@shahco.in", message: "hi" }, ip: "5.6.7.8" };
    const a = await storeWebhookEvent(db, { provider: "form", externalId: "sub-99", payload, signatureOk: true });
    const b = await storeWebhookEvent(db, { provider: "form", externalId: "sub-99", payload, signatureOk: true });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    await processWebhookEvent(a.id);
    const [ev] = await db.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, a.id));
    expect(ev!.processedAt).not.toBeNull();
  });
});

describe("pipeline discipline (§8.4)", () => {
  it("blocks advancing past Engaged without qualification, then allows it", async () => {
    const [l] = await q<{ id: string }>(sql`select l.id from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919876543210'`);
    const actor = { type: "user" as const, id: repA };
    await expect(withTx((tx, fx) => changeStage(tx, fx, l!.id, "qualified", actor))).rejects.toMatchObject({ code: "qualification_incomplete" });
    await withTx((tx, fx) =>
      updateLead(tx, fx, l!.id, {
        qualification: {
          company_website: "acme.co.in",
          industry: "Staffing",
          employee_band: "51-200",
          contact_role: "Head of Sales",
          can_sign: true,
          use_case: "recruiting",
          target_segment: "HR heads, Pune",
          volume: 5000,
          budget_band: "1L-5L",
          timeline: "this_month",
        },
        nextStep: "Send quote",
        nextStepAt: new Date(Date.now() + 86_400_000).toISOString(),
      }, actor),
    );
    const moved = await withTx((tx, fx) => changeStage(tx, fx, l!.id, "qualified", actor));
    expect(moved.stage).toBe("qualified");
    await expect(withTx((tx, fx) => changeStage(tx, fx, l!.id, "lost", actor))).rejects.toMatchObject({ code: "lost_reason_required" });
    await expect(withTx((tx, fx) => updateLead(tx, fx, l!.id, { nextStepAt: null }, actor))).rejects.toMatchObject({ code: "next_step_required" });
  });
});

describe("SLA and cadence engines", () => {
  it("records warning, breach and hard breach; hard breach reassigns", async () => {
    await processWhatsAppPayload(waPayload("919844444444", "wamid.E1", "need data asap"));
    const [l] = await q<{ id: string; owner_id: string }>(sql`select l.id, l.owner_id from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919844444444'`);
    const [t] = await db.select().from(s.slaTimers).where(and(eq(s.slaTimers.leadId, l!.id), eq(s.slaTimers.kind, "first_response")));
    const levels = await processTimer(t!.id, new Date(Date.now() + 60 * 60_000));
    expect(levels).toEqual(["warning", "breach", "hard_breach"]);
    const breaches = await db.select().from(s.slaBreaches).where(eq(s.slaBreaches.timerId, t!.id));
    expect(breaches.length).toBe(3);
    const [after] = await db.select().from(s.leads).where(eq(s.leads.id, l!.id));
    expect(after!.ownerId).not.toBe(l!.owner_id);
    // Re-processing is idempotent.
    expect(await processTimer(t!.id, new Date(Date.now() + 120 * 60_000))).toEqual([]);
  });

  it("runs cadence steps: personal-touch task, then template, and logs every outcome", async () => {
    await processWhatsAppPayload(waPayload("919855555555", "wamid.F1", "hello"));
    const [l] = await q<{ id: string }>(sql`select l.id from leads l join channel_identities ci on ci.contact_id = l.contact_id where ci.value_normalised = '919855555555'`);
    const [enr] = await db.select().from(s.enrollments).where(eq(s.enrollments.leadId, l!.id));
    const far = new Date(Date.now() + 2 * 86_400_000);
    const istHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(far));
    const when = istHour >= 9 && istHour < 20 ? far : new Date(far.getTime() + ((24 + 12 - istHour) % 24) * 3600_000);
    expect(await runEnrollment(enr!.id, when)).toBe("create_task");
    const ts = await db.select().from(s.tasks).where(and(eq(s.tasks.leadId, l!.id), eq(s.tasks.type, "cadence")));
    expect(ts.length).toBe(1);
    const second = await runEnrollment(enr!.id, new Date(when.getTime() + 2 * 86_400_000));
    expect(["send_wa_template", "deferred", "send_email", "suppress"]).toContain(second);
    const events = await db.select().from(s.enrollmentEvents).where(eq(s.enrollmentEvents.enrollmentId, enr!.id));
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reports, search, admin", () => {
  it("dashboards compute from materialised views", async () => {
    await refreshReportViews(db);
    const today = await todayDashboard(db);
    expect(today.leads_today).toBeGreaterThan(0);
    const range = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() + 86_400_000) };
    const funnel = await funnelReport(db, range);
    expect(funnel.some((r) => r.source === "whatsapp_inbound")).toBe(true);
    const stl = await speedToLead(db, range);
    expect(stl.n).toBeGreaterThan(0);
    expect((await teamReport(db, range)).length).toBeGreaterThan(0);
    const cost = await channelCostReport(db, range);
    expect(cost.byCategory.length).toBeGreaterThan(0);
  });

  it("search finds contacts by phone and messages by text, scoped for reps", async () => {
    const byPhone = await search(db, "+91 98765 43210", { userId: manager, role: "manager" });
    expect(byPhone.some((h) => h.type === "contact")).toBe(true);
    const byText = await search(db, "distributor", { userId: manager, role: "manager" });
    expect(byText.some((h) => h.type === "message")).toBe(true);
  });

  it("broadcast preview excludes contacts without marketing consent", async () => {
    const [t] = await db.select().from(s.templates).where(eq(s.templates.internalName, "reengagement_offer"));
    const p = await previewBroadcast(db, t!.id, {});
    expect(p.eligible).toBe(1); // only the form opt-in
    expect(p.excluded.no_marketing_consent).toBeGreaterThan(0);
    expect(p.confirmationPhrase).toBe("SEND 1");
  });

  it("merges duplicates and imports CSV", async () => {
    const rows = parseCsv("Name,Email,Phone,Company,Stage,Owner Email\nKiran Rao,kiran@rao.in,,Rao Exports,engaged,priya@t.local\nBad Row,,,,new,\n");
    const dry = await importLeads(db, rows, { type: "user", id: manager }, true);
    expect(dry).toMatchObject({ total: 2, valid: 1 });
    const real = await importLeads(db, rows, { type: "user", id: manager }, false);
    expect(real.created).toBe(1);
    const [k] = await q<{ contact_id: string }>(sql`select contact_id from channel_identities where value_normalised = 'kiran@rao.in'`);
    const [other] = await db.insert(s.contacts).values({ orgId: env.DEFAULT_ORG_ID, displayName: "Kiran Rao" }).returning();
    await withTx((tx) => mergeContacts(tx, k!.contact_id, other!.id, { type: "user", id: manager }));
    const [merged] = await db.select().from(s.contacts).where(eq(s.contacts.id, other!.id));
    expect(merged!.mergedIntoId).toBe(k!.contact_id);
  });

  it("erasure anonymises in place and keeps counts", async () => {
    const [c] = await q<{ contact_id: string }>(sql`select contact_id from channel_identities where value_normalised = '919822222222'`);
    const before = await q<{ n: number }>(sql`select count(*)::int as n from messages m join leads l on l.id = m.lead_id where l.contact_id = ${c!.contact_id}`);
    await anonymiseContact(db, c!.contact_id, { type: "user", id: manager });
    const after = await q<{ n: number; bodies: number }>(sql`select count(*)::int as n, count(body)::int as bodies from messages m join leads l on l.id = m.lead_id where l.contact_id = ${c!.contact_id}`);
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(after[0]!.bodies).toBe(0);
  });
});

describe("reconciliation harness (Phase 1 done-criterion: 50 enquiries, zero loss)", () => {
  it("50 mixed enquiries → 50 leads, all with a named owner", async () => {
    const before = await q<{ n: number }>(sql`select count(*)::int as n from leads`);
    const started = new Date().toISOString();
    for (let i = 0; i < 50; i++) {
      const n = String(9700000000 + i);
      if (i % 3 === 0) await processWhatsAppPayload(waPayload(`91${n}`, `wamid.R${i}`, `enquiry ${i}`, `Client ${i}`));
      else if (i % 3 === 1) await processEmail(fromPostmark(postmark({ From: `buyer${i}@company${i}.com`, Subject: `Enquiry ${i}`, TextBody: `Need data ${i}` })));
      else await processForm({ name: `Form ${i}`, email: `form${i}@corp${i}.in`, message: `form ${i}` }, { eventId: `rec-${i}`, receivedAt: new Date() });
    }
    const after = await q<{ n: number }>(sql`select count(*)::int as n from leads`);
    expect(after[0]!.n - before[0]!.n).toBe(50);
    const unowned = await q<{ n: number }>(sql`select count(*)::int as n from leads where created_at >= ${started}::timestamptz and owner_id is null and not is_junk`);
    expect(unowned[0]!.n).toBe(0);
    expect(sink.failures).toEqual([]);
  });
});

export type { DomainError };
