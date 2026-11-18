import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  normalisePhone,
  waIdToE164,
  extractPhones,
  normaliseEmail,
  companyDomainFromEmail,
  companyNameFromDomain,
  parseAddressList,
  stripQuotedReply,
  isAutoReply,
  normaliseSubject,
  verifyMetaSignature,
  hmacHex,
  makeReplyAddress,
  parseReplyAddress,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  addBusinessMinutes,
  businessMinutesBetween,
  isOpen,
  nextOpen,
  describeHours,
  quietHoursCalendar,
  windowState,
  isOptOutMessage,
  explainProviderError,
  validateTransition,
  missingQualification,
  scoreLead,
  matchesConditions,
  pickRoundRobin,
  detectLanguage,
  slaDeadlines,
  percentile,
  decideStep,
  renderSnippet,
  contextVars,
  classifySpam,
  type Calendar,
  type CadenceContext,
} from "./index";

const IST: Calendar = {
  timezone: "Asia/Kolkata",
  weekly: {
    "1": [["09:30", "18:30"]],
    "2": [["09:30", "18:30"]],
    "3": [["09:30", "18:30"]],
    "4": [["09:30", "18:30"]],
    "5": [["09:30", "18:30"]],
    "6": [["10:00", "14:00"]],
  },
  holidays: ["2026-12-25"],
};
// 2026-11-18 is a Wednesday. 10:00 IST = 04:30Z.
const istDate = (iso: string) => new Date(iso + "+05:30");

describe("phone normalisation (§7.2)", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["0091 98765 43210", "+919876543210"],
    ["(+91) 98765 43210", "+919876543210"],
    ["+1 415 555 2671", "+14155552671"],
  ])("%s → %s", (raw, e164) => {
    expect(normalisePhone(raw)?.e164).toBe(e164);
  });
  it("rejects fewer than 10 digits", () => {
    expect(normalisePhone("98765")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });
  it("converts wa_id to E.164", () => {
    expect(waIdToE164("919876543210")).toBe("+919876543210");
  });
  it("extracts phones from text", () => {
    expect(extractPhones("Call me on +91-98765 43210 or 022 2345 6789")).toContain("+919876543210");
  });
});

describe("email normalisation", () => {
  it("lower-cases and trims, keeps dots and +tags", () => {
    expect(normaliseEmail("  Rahul.K+test@Acme.CO.IN ")).toBe("rahul.k+test@acme.co.in");
    expect(normaliseEmail("Rahul <rahul@acme.com>")).toBe("rahul@acme.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
  });
  it("gmail dot variants only behind the flag", () => {
    expect(normaliseEmail("r.a.hul@gmail.com", { gmailDotInsensitive: true })).toBe("rahul@gmail.com");
  });
  it("free providers never become companies", () => {
    const free = new Set(["gmail.com", "rediffmail.com"]);
    expect(companyDomainFromEmail("x@gmail.com", free)).toBeNull();
    expect(companyDomainFromEmail("x@acme.co.in", free)).toBe("acme.co.in");
    expect(companyNameFromDomain("acme-tech.co.in")).toBe("Acme Tech");
    expect(companyNameFromDomain("mail.bigcorp.com")).toBe("Bigcorp");
  });
  it("parses address lists", () => {
    expect(parseAddressList('"Kumar, Rahul" <rahul@acme.com>, sales@doott.com')).toEqual([
      { name: "Kumar, Rahul", email: "rahul@acme.com" },
      { name: null, email: "sales@doott.com" },
    ]);
  });
});

describe("email text", () => {
  it("strips Gmail quoted history and signatures", () => {
    const body = "Yes, please send the quote.\n\nThanks\n-- \nRahul Kumar\nAcme\n\nOn Tue, 18 Nov 2026 at 10:00, Priya <priya@doott.com> wrote:\n> Hi Rahul\n> what volume?";
    expect(stripQuotedReply(body)).toBe("Yes, please send the quote.\n\nThanks");
  });
  it("strips Outlook original message blocks", () => {
    const body = "Sounds good.\n\n-----Original Message-----\nFrom: Priya\nSent: Monday\nquote attached";
    expect(stripQuotedReply(body)).toBe("Sounds good.");
  });
  it("detects auto-replies", () => {
    expect(isAutoReply({ headers: { "Auto-Submitted": "auto-replied" } })).toBe(true);
    expect(isAutoReply({ subject: "Out of Office: back Monday" })).toBe(true);
    expect(isAutoReply({ subject: "Automatic reply: Enquiry" })).toBe(true);
    expect(isAutoReply({ from: "MAILER-DAEMON@mx.google.com" })).toBe(true);
    expect(isAutoReply({ headers: { "Auto-Submitted": "no" }, subject: "Re: quote" })).toBe(false);
  });
  it("normalises subjects", () => {
    expect(normaliseSubject("RE: Fwd: [EXT] Re: Data enquiry")).toBe("data enquiry");
  });
});

describe("crypto", () => {
  it("verifies Meta signatures over the raw body", () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = "sha256=" + hmacHex("app-secret", body);
    expect(verifyMetaSignature(body, sig, "app-secret")).toBe(true);
    expect(verifyMetaSignature(body + " ", sig, "app-secret")).toBe(false);
    expect(verifyMetaSignature(body, undefined, "app-secret")).toBe(false);
  });
  it("round-trips reply addresses and rejects forged ones", () => {
    const id = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    const addr = makeReplyAddress(id, "s3cret", "inbox.doott.com");
    expect(parseReplyAddress(addr, "s3cret")).toBe(id);
    expect(parseReplyAddress(addr.replace(/-[0-9a-f]{10}@/, "-0000000000@"), "s3cret")).toBeNull();
    expect(parseReplyAddress(`Rahul <${addr}>`, "s3cret")).toBe(id);
  });
  it("encrypts secrets", () => {
    const blob = encryptSecret("ya29.token", "k".repeat(40));
    expect(decryptSecret(blob, "k".repeat(40))).toBe("ya29.token");
  });
  it("hashes passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
});

describe("business hours (§3.5)", () => {
  it("knows when the office is open", () => {
    expect(isOpen(IST, istDate("2026-11-18T10:00:00"))).toBe(true);
    expect(isOpen(IST, istDate("2026-11-18T19:00:00"))).toBe(false);
    expect(isOpen(IST, istDate("2026-11-22T11:00:00"))).toBe(false); // Sunday
    expect(isOpen(IST, istDate("2026-12-25T11:00:00"))).toBe(false); // holiday
  });
  it("adds business minutes within a day", () => {
    expect(addBusinessMinutes(IST, istDate("2026-11-18T10:00:00"), 5).toISOString()).toBe(
      istDate("2026-11-18T10:05:00").toISOString(),
    );
  });
  it("pauses overnight", () => {
    expect(addBusinessMinutes(IST, istDate("2026-11-18T18:28:00"), 5).toISOString()).toBe(
      istDate("2026-11-19T09:33:00").toISOString(),
    );
  });
  it("starts the clock at opening when the lead arrives after hours", () => {
    expect(addBusinessMinutes(IST, istDate("2026-11-18T23:00:00"), 2).toISOString()).toBe(
      istDate("2026-11-19T09:32:00").toISOString(),
    );
  });
  it("skips Sunday and the Saturday half day", () => {
    // Sat 13:58 + 5 min → Sat closes 14:00 (2 min), Sunday closed, Monday 09:30 + 3 = 09:33
    expect(addBusinessMinutes(IST, istDate("2026-11-21T13:58:00"), 5).toISOString()).toBe(
      istDate("2026-11-23T09:33:00").toISOString(),
    );
  });
  it("skips holidays", () => {
    expect(addBusinessMinutes(IST, istDate("2026-12-24T18:29:00"), 2).toISOString()).toBe(
      istDate("2026-12-26T10:01:00").toISOString(),
    );
  });
  it("counts business minutes between instants", () => {
    expect(businessMinutesBetween(IST, istDate("2026-11-18T18:00:00"), istDate("2026-11-19T10:00:00"))).toBe(60);
    expect(businessMinutesBetween(IST, istDate("2026-11-18T20:00:00"), istDate("2026-11-18T22:00:00"))).toBe(0);
  });
  it("add and between are inverse (property)", () => {
    const start = istDate("2026-11-16T00:00:00").getTime();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 14 * 24 * 60 }), fc.integer({ min: 1, max: 3000 }), (offsetMin, minutes) => {
        const s = new Date(start + offsetMin * 60_000);
        const e = addBusinessMinutes(IST, s, minutes);
        return Math.abs(businessMinutesBetween(IST, s, e) - minutes) < 1e-6;
      }),
      { numRuns: 200 },
    );
  });
  it("works across DST for a non-IST team", () => {
    const ny: Calendar = { timezone: "America/New_York", weekly: { "0": [["09:00", "17:00"]], "1": [["09:00", "17:00"]] }, holidays: [] };
    // DST ends Sun 1 Nov 2026. Sunday 09:00 EST = 14:00Z.
    expect(nextOpen(ny, new Date("2026-11-01T05:00:00Z"))!.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    // Monday before DST end week (Oct 26): 09:00 EDT = 13:00Z
    expect(nextOpen(ny, new Date("2026-10-26T05:00:00Z"))!.toISOString()).toBe("2026-10-26T13:00:00.000Z");
  });
  it("describes hours", () => {
    expect(describeHours(IST)).toBe("Mon–Fri 09:30–18:30, Sat 10:00–14:00 (IST)");
  });
});

describe("WhatsApp rules (§5.3, §5.6)", () => {
  it("window is open for 24h after last inbound", () => {
    const last = new Date("2026-11-18T04:00:00Z");
    expect(windowState(last, new Date("2026-11-18T20:00:00Z")).open).toBe(true);
    expect(windowState(last, new Date("2026-11-19T04:00:01Z")).open).toBe(false);
    expect(windowState(null).open).toBe(false);
  });
  it("opt-out keywords only when the message is the keyword", () => {
    for (const t of ["STOP", "stop.", "Unsubscribe", "band karo", "बंद करो", "रोकें"]) expect(isOptOutMessage(t)).toBe(true);
    expect(isOptOutMessage("please don't stop sending the quote")).toBe(false);
    expect(isOptOutMessage("Stop by our office tomorrow")).toBe(false);
  });
  it("explains provider errors in plain language", () => {
    expect(explainProviderError(131047)).toMatch(/window is closed/);
    expect(explainProviderError("99999", "Weird")).toBe("Weird (code 99999)");
  });
});

describe("pipeline rules (§8.4)", () => {
  const full = {
    company_website: "acme.com",
    industry: "SaaS",
    employee_band: "51-200",
    contact_role: "Head of Sales",
    can_sign: true,
    use_case: "sales_prospecting",
    target_segment: "HR heads in Pune",
    volume: 5000,
    budget_band: "1L-5L",
    timeline: "this_month",
  };
  it("blocks advancing past Engaged without qualification", () => {
    const r = validateTransition({ from: "engaged", to: "qualified", qualification: {}, actor: "user" });
    expect(r.ok).toBe(false);
    expect(validateTransition({ from: "engaged", to: "qualified", qualification: full, actor: "user" }).ok).toBe(true);
    expect(missingQualification({ ...full, can_sign: undefined })).toEqual(["can_sign"]);
  });
  it("requires a lost reason from the list", () => {
    expect(validateTransition({ from: "quoted", to: "lost", qualification: full, actor: "user" }).ok).toBe(false);
    expect(
      validateTransition({ from: "quoted", to: "lost", qualification: full, lostReason: "made_up", validLostReasons: ["price"], actor: "user" }).ok,
    ).toBe(false);
    expect(
      validateTransition({ from: "quoted", to: "lost", qualification: full, lostReason: "price", validLostReasons: ["price"], actor: "user" }).ok,
    ).toBe(true);
  });
  it("closed leads do not reopen; nurture needs a revisit date", () => {
    expect(validateTransition({ from: "won", to: "engaged", qualification: full, actor: "user" }).ok).toBe(false);
    expect(validateTransition({ from: "attempting", to: "nurture", qualification: {}, actor: "user" }).ok).toBe(false);
  });
});

describe("scoring (§9.4)", () => {
  it("is transparent", () => {
    const r = scoreLead({
      companySizeBand: "51-200",
      jobTitle: "Founder & CEO",
      hasBusinessEmailDomain: true,
      hasCompany: true,
      emailVerified: true,
      repliedWithinHourOfFirstTouch: false,
      askedPricingOrTrial: true,
      requestedSample: false,
      isReferral: false,
      outsideServiceableGeo: false,
      noReplyAfterThreeTouches: false,
      competitorOrStudent: false,
    });
    expect(r.score).toBe(15 + 15 + 10 + 5 + 15);
    expect(r.band).toBe("hot");
    expect(r.breakdown.map((b) => b.rule)).toContain("Buyer role");
  });
  it("penalises free email with no company", () => {
    const r = scoreLead({
      hasBusinessEmailDomain: false,
      hasCompany: false,
      emailVerified: false,
      repliedWithinHourOfFirstTouch: false,
      askedPricingOrTrial: false,
      requestedSample: false,
      isReferral: false,
      outsideServiceableGeo: false,
      noReplyAfterThreeTouches: false,
      competitorOrStudent: true,
    });
    expect(r.score).toBe(-35);
    expect(r.band).toBe("low");
  });
});

describe("routing (§9.1)", () => {
  it("matches conditions", () => {
    expect(matchesConditions({ sources: ["indiamart"] }, { source: "IndiaMART" })).toBe(true);
    expect(matchesConditions({ sources: ["indiamart"], cities: ["pune"] }, { source: "indiamart", city: "Mumbai" })).toBe(false);
    expect(matchesConditions({}, { source: "x" })).toBe(true);
    expect(matchesConditions({ keywords: ["enterprise"] }, { source: "x", text: "Need ENTERPRISE plan" })).toBe(true);
  });
  it("round robin respects availability, capacity, hours and recency", () => {
    const base = { isAvailable: true, active: true, openLeads: 1, capacity: 10, inWorkingHours: true };
    const pick = pickRoundRobin([
      { ...base, id: "a", lastAssignedAt: new Date("2026-11-18T05:00:00Z") },
      { ...base, id: "b", lastAssignedAt: new Date("2026-11-18T04:00:00Z") },
      { ...base, id: "c", lastAssignedAt: null, openLeads: 10 },
      { ...base, id: "d", lastAssignedAt: null, isAvailable: false },
    ]);
    expect(pick?.id).toBe("b");
    expect(pickRoundRobin([{ ...base, id: "x", lastAssignedAt: null, inWorkingHours: false }])).toBeNull();
  });
  it("detects language", () => {
    expect(detectLanguage("मुझे डेटा चाहिए")).toBe("hi");
    expect(detectLanguage("mujhe data chahiye")).toBe("hi");
    expect(detectLanguage("I need data")).toBe("en");
  });
});

describe("SLA (§9.5)", () => {
  it("computes 50/100/200% deadlines on business time", () => {
    const d = slaDeadlines(IST, istDate("2026-11-18T10:00:00"), 120);
    expect(d.warnAt.toISOString()).toBe(istDate("2026-11-18T11:00:00").toISOString());
    expect(d.breachAt.toISOString()).toBe(istDate("2026-11-18T12:00:00").toISOString());
    expect(d.hardBreachAt.toISOString()).toBe(istDate("2026-11-18T14:00:00").toISOString());
  });
  it("percentiles", () => {
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("cadence decisions (§9.3)", () => {
  const ctx = (over: Partial<CadenceContext> = {}): CadenceContext => ({
    now: istDate("2026-11-19T11:00:00"),
    enquiryChannel: "whatsapp",
    quietHours: quietHoursCalendar("Asia/Kolkata", []),
    lastInboundWhatsAppAt: istDate("2026-11-18T10:00:00"), // > 24h ago → closed
    hasWhatsApp: true,
    hasEmail: true,
    emailInvalid: false,
    templateApproved: true,
    templateCategory: "utility",
    waConsent: { utility: true, marketing: false },
    emailConsent: true,
    optedOut: false,
    lastSendDay: null,
    ...over,
  });
  const waStep = {
    position: 2,
    action: "send" as const,
    channel: "whatsapp" as const,
    templateInternalName: "follow_up_1",
    emailSubject: "Following up",
    emailBody: "Hi {{first_name}}",
  };
  it("uses the approved template when the window is closed", () => {
    expect(decideStep(waStep, ctx()).kind).toBe("send_wa_template");
  });
  it("falls back to email when the template is not approved — never silently skips", () => {
    const d = decideStep(waStep, ctx({ templateApproved: false }));
    expect(d.kind).toBe("send_email");
    expect(d.kind === "send_email" && d.substituted).toBe(true);
  });
  it("defers in quiet hours", () => {
    const d = decideStep(waStep, ctx({ now: istDate("2026-11-19T21:30:00") }));
    expect(d.kind).toBe("defer");
    expect(d.kind === "defer" && d.until.toISOString()).toBe(istDate("2026-11-20T09:00:00").toISOString());
  });
  it("one channel per day", () => {
    const d = decideStep(waStep, ctx({ lastSendDay: "2026-11-19" }));
    expect(d.kind).toBe("defer");
    expect(d.kind === "defer" && d.until.toISOString()).toBe(istDate("2026-11-20T09:00:00").toISOString());
  });
  it("suppresses on opt-out and when no channel is usable", () => {
    expect(decideStep(waStep, ctx({ optedOut: true })).kind).toBe("suppress");
    expect(decideStep(waStep, ctx({ templateApproved: false, emailInvalid: true })).kind).toBe("suppress");
  });
  it("needs WhatsApp consent for business-initiated templates", () => {
    const d = decideStep(waStep, ctx({ waConsent: { utility: false, marketing: false } }));
    expect(d.kind).toBe("send_email");
  });
  it("task and nurture steps", () => {
    expect(decideStep({ position: 1, action: "task", channel: "whatsapp_or_email" }, ctx()).kind).toBe("create_task");
    expect(decideStep({ position: 6, action: "move_to_nurture", channel: "none" }, ctx()).kind).toBe("move_to_nurture");
  });
});

describe("templating and spam", () => {
  it("renders snippets and leaves unknown vars visible", () => {
    const vars = contextVars({ contact: { displayName: "Rahul Kumar" }, owner: { name: "Priya Sharma" } });
    expect(renderSnippet("Hi {{first_name}}, {{owner}} here. {{unknown}}", vars)).toBe("Hi Rahul, Priya here. {{unknown}}");
  });
  it("classifies vendor spam", () => {
    expect(classifySpam({ subject: "SEO services to rank your website", body: "" }).junk).toBe(true);
    expect(classifySpam({ subject: "Need HR contacts in Pune", body: "pricing?" }).junk).toBe(false);
  });
});
