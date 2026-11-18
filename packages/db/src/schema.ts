/**
 * Lead Operating System — database schema (spec §7.1).
 *
 * Conventions:
 *  - Every tenant-root table carries org_id (single org today; multi-tenant ready).
 *  - Enumerations are text columns typed in TypeScript (cheaper to migrate than PG enums).
 *  - History lives in append-only tables: activities, audit_log, consent_records, sla_breaches,
 *    enrollment_events. Reports derive from those, never from overwritten columns.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  customType,
  bigserial,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Shared column helpers and domain types
// ---------------------------------------------------------------------------

const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () => uuid("org_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export type Role = "admin" | "manager" | "rep" | "viewer" | "service";
export type IdentityKind = "phone" | "email" | "wa_id";
export type Channel = "whatsapp" | "email";
export type Stage =
  | "new"
  | "attempting"
  | "engaged"
  | "qualified"
  | "quoted"
  | "negotiation"
  | "won"
  | "lost"
  | "disqualified"
  | "nurture";
export type ConversationState = "open" | "snoozed" | "waiting_client" | "waiting_us" | "closed";
export type Direction = "inbound" | "outbound";
export type AuthorType = "contact" | "user" | "system" | "phone_app";
export type MessageStatus =
  | "received"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "cancelled";
export type TemplateCategory = "utility" | "marketing" | "authentication" | "service";
export type WeeklyHours = Record<string, [string, string][]>; // { "1": [["09:30","18:30"]], ... } 0=Sunday
export type MediaRef = { attachmentId: string; kind: string; filename?: string; mime?: string; caption?: string };
export type TemplateVariable = { key: string; example?: string; source?: string };

// ---------------------------------------------------------------------------
// Organisation, people, calendars
// ---------------------------------------------------------------------------

export const orgs = pgTable("los_orgs", {
  id: id(),
  name: text("name").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const businessHours = pgTable("los_business_hours", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  weekly: jsonb("weekly").$type<WeeklyHours>().notNull(),
  createdAt: createdAt(),
});

export const holidays = pgTable(
  "los_holidays",
  {
    id: id(),
    orgId: orgId(),
    businessHoursId: uuid("business_hours_id"),
    day: date("day").notNull(),
    name: text("name").notNull(),
  },
  (t) => [index("los_holidays_org_day_idx").on(t.orgId, t.day)],
);

export const teams = pgTable("los_teams", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  businessHoursId: uuid("business_hours_id"),
  createdAt: createdAt(),
});

export const users = pgTable(
  "los_users",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    role: text("role").$type<Role>().notNull().default("rep"),
    teamId: uuid("team_id"),
    isAvailable: boolean("is_available").notNull().default(true),
    capacity: integer("capacity").notNull().default(60),
    workingHoursId: uuid("working_hours_id"),
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    territories: text("territories").array().notNull().default(sql`'{}'::text[]`),
    tz: text("tz").notNull().default("Asia/Kolkata"),
    lastAssignedAt: ts("last_assigned_at"),
    pushSubscriptions: jsonb("push_subscriptions").$type<unknown[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    lastSeenAt: ts("last_seen_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("los_users_email_uq").on(t.email)],
);

export const sessions = pgTable(
  "los_sessions",
  {
    id: text("id").primaryKey(), // sha256 of the session token
    userId: uuid("user_id").notNull(),
    pendingTotp: boolean("pending_totp").notNull().default(false),
    expiresAt: ts("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("los_sessions_user_idx").on(t.userId)],
);

export const apiTokens = pgTable("los_api_tokens", {
  id: id(),
  orgId: orgId(),
  userId: uuid("user_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

export const notifications = pgTable(
  "los_notifications",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    leadId: uuid("lead_id"),
    conversationId: uuid("conversation_id"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("los_notifications_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Companies, contacts, identities
// ---------------------------------------------------------------------------

export const companies = pgTable(
  "los_companies",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    domain: text("domain"),
    website: text("website"),
    industry: text("industry"),
    sizeBand: text("size_band"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    ownerId: uuid("owner_id"),
    enrichedAt: ts("enriched_at"),
    source: text("source"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("los_companies_org_domain_uq").on(t.orgId, t.domain).where(sql`${t.domain} is not null`),
    index("los_companies_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

export const contacts = pgTable(
  "los_contacts",
  {
    id: id(),
    orgId: orgId(),
    companyId: uuid("company_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    jobTitle: text("job_title"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    lifecycleStage: text("lifecycle_stage").notNull().default("lead"),
    ownerId: uuid("owner_id"),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    mergedIntoId: uuid("merged_into_id"),
    anonymisedAt: ts("anonymised_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("los_contacts_company_idx").on(t.companyId),
    index("los_contacts_name_trgm").using(
      "gin",
      sql`(coalesce(${t.displayName}, '') || ' ' || coalesce(${t.firstName}, '') || ' ' || coalesce(${t.lastName}, '')) gin_trgm_ops`,
    ),
  ],
);

export const channelIdentities = pgTable(
  "los_channel_identities",
  {
    id: id(),
    orgId: orgId(),
    contactId: uuid("contact_id").notNull(),
    kind: text("kind").$type<IdentityKind>().notNull(),
    valueNormalised: text("value_normalised").notNull(),
    valueRaw: text("value_raw").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedState: text("verified_state").notNull().default("unknown"), // unknown|deliverable|risky|invalid
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("los_channel_identities_uq").on(t.orgId, t.kind, t.valueNormalised),
    index("los_channel_identities_contact_idx").on(t.contactId),
  ],
);

export const freeEmailDomains = pgTable("los_free_email_domains", {
  domain: text("domain").primaryKey(),
});

// ---------------------------------------------------------------------------
// Leads and their timeline
// ---------------------------------------------------------------------------

export const leadSources = pgTable(
  "los_lead_sources",
  {
    id: id(),
    orgId: orgId(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("los_lead_sources_key_uq").on(t.orgId, t.key)],
);

export const lostReasons = pgTable(
  "los_lost_reasons",
  {
    id: id(),
    orgId: orgId(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("los_lost_reasons_key_uq").on(t.orgId, t.key)],
);

export const leads = pgTable(
  "los_leads",
  {
    id: id(),
    orgId: orgId(),
    number: bigserial("number", { mode: "number" }).notNull(),
    contactId: uuid("contact_id").notNull(),
    companyId: uuid("company_id"),
    previousLeadId: uuid("previous_lead_id"),
    source: text("source").notNull(),
    sourceDetail: text("source_detail"),
    portalLeadId: text("portal_lead_id"),
    stage: text("stage").$type<Stage>().notNull().default("new"),
    ownerId: uuid("owner_id"),
    teamId: uuid("team_id"),
    score: integer("score").notNull().default(0),
    scoreBreakdown: jsonb("score_breakdown").$type<{ rule: string; points: number }[]>().notNull().default([]),
    valueEstimate: numeric("value_estimate", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("INR"),
    qualification: jsonb("qualification").$type<Record<string, unknown>>().notNull().default({}),
    lostReason: text("lost_reason"),
    lostNote: text("lost_note"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    enquiry: text("enquiry"),
    language: text("language"),
    openedAt: ts("opened_at").notNull().defaultNow(),
    assignedAt: ts("assigned_at"),
    firstInboundAt: ts("first_inbound_at"),
    firstResponseAt: ts("first_response_at"),
    firstResponseBusinessMinutes: integer("first_response_business_minutes"),
    firstResponseBy: uuid("first_response_by"),
    lastActivityAt: ts("last_activity_at").notNull().defaultNow(),
    lastClientReplyAt: ts("last_client_reply_at"),
    touchCount: integer("touch_count").notNull().default(0),
    closedAt: ts("closed_at"),
    wonAt: ts("won_at"),
    nextStep: text("next_step"),
    nextStepAt: ts("next_step_at"),
    revisitAt: ts("revisit_at"),
    parseFailed: boolean("parse_failed").notNull().default(false),
    isJunk: boolean("is_junk").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("los_leads_open_contact_idx").on(t.contactId).where(sql`${t.closedAt} is null`),
    index("los_leads_owner_stage_idx").on(t.ownerId, t.stage),
    index("los_leads_stage_idx").on(t.orgId, t.stage),
    index("los_leads_created_idx").on(t.orgId, t.createdAt),
    uniqueIndex("los_leads_portal_uq")
      .on(t.orgId, t.source, t.portalLeadId)
      .where(sql`${t.portalLeadId} is not null`),
  ],
);

export const activities = pgTable(
  "los_activities",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").notNull(),
    type: text("type").notNull(),
    actorType: text("actor_type").$type<AuthorType>().notNull().default("system"),
    actorId: uuid("actor_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("los_activities_lead_idx").on(t.leadId, t.occurredAt),
    index("los_activities_type_idx").on(t.orgId, t.type, t.occurredAt),
  ],
);

export const notes = pgTable(
  "los_notes",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").notNull(),
    conversationId: uuid("conversation_id"),
    authorId: uuid("author_id"),
    body: text("body").notNull(),
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('simple', coalesce(body, ''))`),
    createdAt: createdAt(),
  },
  (t) => [index("los_notes_lead_idx").on(t.leadId), index("los_notes_search_idx").using("gin", t.search)],
);

export const tasks = pgTable(
  "los_tasks",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id"),
    assigneeId: uuid("assignee_id"),
    title: text("title").notNull(),
    type: text("type").notNull().default("follow_up"),
    dueAt: ts("due_at"),
    completedAt: ts("completed_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("los_tasks_assignee_open_idx").on(t.assigneeId, t.dueAt).where(sql`${t.completedAt} is null`),
    index("los_tasks_lead_idx").on(t.leadId),
  ],
);

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

export const waNumbers = pgTable(
  "los_wa_numbers",
  {
    id: id(),
    orgId: orgId(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayNumber: text("display_number"),
    wabaId: text("waba_id"),
    qualityRating: text("quality_rating"),
    messagingLimit: text("messaging_limit"),
    isTest: boolean("is_test").notNull().default(false),
    lastSyncedAt: ts("last_synced_at"),
  },
  (t) => [uniqueIndex("los_wa_numbers_pnid_uq").on(t.phoneNumberId)],
);

export const mailboxConnections = pgTable(
  "los_mailbox_connections",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id"),
    provider: text("provider").notNull().default("gmail"),
    email: text("email").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: ts("token_expires_at"),
    historyId: text("history_id"),
    watchExpiresAt: ts("watch_expires_at"),
    status: text("status").notNull().default("active"), // active|error|disconnected
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("los_mailbox_connections_email_uq").on(t.email)],
);

export const conversations = pgTable(
  "los_conversations",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    providerThreadRef: text("provider_thread_ref"),
    subject: text("subject"),
    assignedTo: uuid("assigned_to"),
    state: text("state").$type<ConversationState>().notNull().default("open"),
    snoozedUntil: ts("snoozed_until"),
    lastInboundAt: ts("last_inbound_at"),
    lastOutboundAt: ts("last_outbound_at"),
    lastMessageAt: ts("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    lastDirection: text("last_direction").$type<Direction>(),
    windowExpiresAt: ts("window_expires_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    waNumberId: text("wa_number_id"), // Meta phone_number_id we talk from
    mailboxConnectionId: uuid("mailbox_connection_id"),
    toAddress: text("to_address"), // the shared/rep address the client wrote to
    isJunk: boolean("is_junk").notNull().default(false),
    lastAutoAckAt: ts("last_auto_ack_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("los_conversations_lead_idx").on(t.leadId),
    index("los_conversations_inbox_idx").on(t.orgId, t.state, t.lastMessageAt),
    index("los_conversations_assigned_idx").on(t.assignedTo, t.lastMessageAt),
    index("los_conversations_window_idx").on(t.windowExpiresAt).where(sql`${t.windowExpiresAt} is not null`),
  ],
);

export const messages = pgTable(
  "los_messages",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    direction: text("direction").$type<Direction>().notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    authorType: text("author_type").$type<AuthorType>().notNull(),
    authorUserId: uuid("author_user_id"),
    providerMessageId: text("provider_message_id"),
    kind: text("kind").notNull().default("text"), // text|image|document|audio|video|location|contacts|interactive|template|email|reaction|sticker|unsupported
    body: text("body"),
    bodyHtml: text("body_html"),
    bodyFull: text("body_full"),
    subject: text("subject"),
    templateId: uuid("template_id"),
    templateVars: jsonb("template_vars").$type<Record<string, string>>(),
    media: jsonb("media").$type<MediaRef[]>().notNull().default([]),
    status: text("status").$type<MessageStatus>().notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    pricingCategory: text("pricing_category"),
    billable: boolean("billable"),
    recipientCountry: text("recipient_country"),
    isAuto: boolean("is_auto").notNull().default(false), // system acknowledgement / cadence
    isAutoReply: boolean("is_auto_reply").notNull().default(false), // inbound OOO / auto-responder
    sequenceEnrollmentId: uuid("sequence_enrollment_id"),
    broadcastId: uuid("broadcast_id"),
    idempotencyKey: text("idempotency_key"),
    sendAt: ts("send_at"),
    queuedAt: ts("queued_at"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    readAt: ts("read_at"),
    failedAt: ts("failed_at"),
    receivedAt: ts("received_at"),
    emailMessageId: text("email_message_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references"),
    emailFrom: text("email_from"),
    emailTo: jsonb("email_to").$type<string[]>(),
    emailCc: jsonb("email_cc").$type<string[]>(),
    replyToContextId: text("reply_to_context_id"),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, ''))`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("los_messages_provider_uq")
      .on(t.channel, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    uniqueIndex("los_messages_idem_uq").on(t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    index("los_messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("los_messages_email_mid_idx").on(t.emailMessageId).where(sql`${t.emailMessageId} is not null`),
    index("los_messages_search_idx").using("gin", t.search),
    index("los_messages_status_idx").on(t.status).where(sql`${t.status} in ('queued','sending')`),
  ],
);

export const attachments = pgTable(
  "los_attachments",
  {
    id: id(),
    orgId: orgId(),
    ownerType: text("owner_type").notNull(), // message|note|lead|consent
    ownerId: uuid("owner_id"),
    storageKey: text("storage_key"),
    filename: text("filename"),
    mime: text("mime"),
    size: integer("size"),
    providerMediaId: text("provider_media_id"),
    status: text("status").notNull().default("pending"), // pending|stored|failed
    error: text("error"),
    scannedAt: ts("scanned_at"),
    createdAt: createdAt(),
  },
  (t) => [index("los_attachments_owner_idx").on(t.ownerType, t.ownerId)],
);

// ---------------------------------------------------------------------------
// Templates and snippets
// ---------------------------------------------------------------------------

export const templates = pgTable(
  "los_templates",
  {
    id: id(),
    orgId: orgId(),
    channel: text("channel").$type<Channel>().notNull().default("whatsapp"),
    internalName: text("internal_name").notNull(),
    providerName: text("provider_name").notNull(),
    providerTemplateId: text("provider_template_id"),
    category: text("category").$type<TemplateCategory>().notNull(),
    language: text("language").notNull().default("en"),
    header: text("header"),
    body: text("body").notNull(),
    footer: text("footer"),
    buttons: jsonb("buttons").$type<unknown[]>().notNull().default([]),
    variables: jsonb("variables").$type<TemplateVariable[]>().notNull().default([]),
    approvalStatus: text("approval_status").notNull().default("draft"), // draft|pending|approved|rejected|paused|disabled
    rejectionReason: text("rejection_reason"),
    emailSubject: text("email_subject"),
    lastSyncedAt: ts("last_synced_at"),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("los_templates_provider_uq").on(t.orgId, t.channel, t.providerName, t.language)],
);

export const snippets = pgTable("los_snippets", {
  id: id(),
  orgId: orgId(),
  folder: text("folder").notNull().default("General"),
  shortcut: text("shortcut").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  channel: text("channel").$type<Channel>(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export const webhookEvents = pgTable(
  "los_webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(), // whatsapp|postmark|gmail|form|ses
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    headers: jsonb("headers").$type<Record<string, unknown>>().notNull().default({}),
    signatureOk: boolean("signature_ok").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("los_webhook_events_uq").on(t.provider, t.externalId),
    index("los_webhook_events_unprocessed_idx").on(t.receivedAt).where(sql`${t.processedAt} is null`),
  ],
);

export const parseFailures = pgTable("los_parse_failures", {
  id: id(),
  orgId: orgId(),
  leadId: uuid("lead_id"),
  webhookEventId: uuid("webhook_event_id"),
  parser: text("parser").notNull(),
  reason: text("reason").notNull(),
  raw: jsonb("raw").$type<unknown>(),
  resolvedAt: ts("resolved_at"),
  resolvedBy: uuid("resolved_by"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Discipline: routing, SLA, cadence
// ---------------------------------------------------------------------------

export type RoutingConditions = {
  sources?: string[];
  sourceDetailContains?: string[];
  sizeBands?: string[];
  keywords?: string[];
  cities?: string[];
  states?: string[];
  languages?: string[];
  channels?: Channel[];
  minScore?: number;
};

export const routingRules = pgTable("los_routing_rules", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(100),
  conditions: jsonb("conditions").$type<RoutingConditions>().notNull().default({}),
  strategy: text("strategy").notNull().default("round_robin"), // round_robin|specific_user|unassigned
  targetTeamId: uuid("target_team_id"),
  targetUserId: uuid("target_user_id"),
  fallback: text("fallback").notNull().default("next_rule"), // next_rule|unassigned
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const slaPolicies = pgTable("los_sla_policies", {
  id: id(),
  orgId: orgId(),
  kind: text("kind").notNull(), // assignment|first_response|reply|stage_exit
  stage: text("stage").$type<Stage>(),
  targetMinutes: integer("target_minutes").notNull(),
  active: boolean("active").notNull().default(true),
});

export const slaTimers = pgTable(
  "los_sla_timers",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").notNull(),
    conversationId: uuid("conversation_id"),
    policyId: uuid("policy_id"),
    kind: text("kind").notNull(),
    stage: text("stage"),
    ownerId: uuid("owner_id"),
    startedAt: ts("started_at").notNull(),
    targetMinutes: integer("target_minutes").notNull(),
    warnAt: ts("warn_at").notNull(),
    breachAt: ts("breach_at").notNull(),
    hardBreachAt: ts("hard_breach_at").notNull(),
    state: text("state").notNull().default("running"), // running|met|cancelled
    warnedAt: ts("warned_at"),
    breachedAt: ts("breached_at"),
    hardBreachedAt: ts("hard_breached_at"),
    stoppedAt: ts("stopped_at"),
  },
  (t) => [
    index("los_sla_timers_running_idx").on(t.state, t.warnAt).where(sql`${t.state} = 'running'`),
    index("los_sla_timers_lead_idx").on(t.leadId),
  ],
);

export const slaBreaches = pgTable(
  "los_sla_breaches",
  {
    id: id(),
    orgId: orgId(),
    timerId: uuid("timer_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    kind: text("kind").notNull(),
    level: text("level").notNull(), // warning|breach|hard_breach
    ownerId: uuid("owner_id"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("los_sla_breaches_uq").on(t.timerId, t.level)],
);

export const sequences = pgTable("los_sequences", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  entryCondition: jsonb("entry_condition").$type<{ stage?: Stage; sources?: string[] }>().notNull().default({}),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export type StepChannel = "same_channel" | "whatsapp" | "email" | "whatsapp_or_email" | "none";
export type StepAction = "send" | "task" | "move_to_nurture";

export const sequenceSteps = pgTable(
  "los_sequence_steps",
  {
    id: id(),
    sequenceId: uuid("sequence_id").notNull(),
    position: integer("position").notNull(),
    offsetMinutes: integer("offset_minutes").notNull(), // from enrollment start
    offsetBusiness: boolean("offset_business").notNull().default(false),
    action: text("action").$type<StepAction>().notNull().default("send"),
    channel: text("channel").$type<StepChannel>().notNull(),
    templateInternalName: text("template_internal_name"),
    waBody: text("wa_body"),
    emailSubject: text("email_subject"),
    emailBody: text("email_body"),
    taskTitle: text("task_title"),
    revisitDays: integer("revisit_days"),
    requiresHuman: boolean("requires_human").notNull().default(false), // e.g. "rep's personal first touch" → task
  },
  (t) => [uniqueIndex("los_sequence_steps_pos_uq").on(t.sequenceId, t.position)],
);

export const enrollments = pgTable(
  "los_enrollments",
  {
    id: id(),
    orgId: orgId(),
    leadId: uuid("lead_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    currentStep: integer("current_step").notNull().default(0), // position of the next step to run
    state: text("state").notNull().default("active"), // active|completed|stopped
    stopReason: text("stop_reason"),
    startedAt: ts("started_at").notNull().defaultNow(),
    nextRunAt: ts("next_run_at"),
    lastSendDay: text("last_send_day"), // YYYY-MM-DD in contact TZ
    endedAt: ts("ended_at"),
  },
  (t) => [
    index("los_enrollments_due_idx").on(t.nextRunAt).where(sql`${t.state} = 'active'`),
    uniqueIndex("los_enrollments_active_uq").on(t.leadId, t.sequenceId).where(sql`${t.state} = 'active'`),
  ],
);

export const enrollmentEvents = pgTable(
  "los_enrollment_events",
  {
    id: id(),
    enrollmentId: uuid("enrollment_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    stepPosition: integer("step_position").notNull(),
    outcome: text("outcome").notNull(), // sent|substituted|suppressed|deferred|task_created|moved_to_nurture|stopped
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    messageId: uuid("message_id"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("los_enrollment_events_enr_idx").on(t.enrollmentId)],
);

// ---------------------------------------------------------------------------
// Consent and compliance
// ---------------------------------------------------------------------------

export const noticeVersions = pgTable(
  "los_notice_versions",
  {
    id: id(),
    orgId: orgId(),
    version: text("version").notNull(),
    body: text("body").notNull(),
    publishedAt: ts("published_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("los_notice_versions_uq").on(t.orgId, t.version)],
);

/** Append-only. The current state for (contact, channel, purpose) is the latest row. */
export const consentRecords = pgTable(
  "los_consent_records",
  {
    id: id(),
    orgId: orgId(),
    contactId: uuid("contact_id").notNull(),
    channel: text("channel").notNull(), // whatsapp|email|all
    purpose: text("purpose").notNull(), // marketing|utility|all
    state: text("state").notNull(), // granted|withdrawn
    basis: text("basis").notNull(), // form_opt_in|whatsapp_opt_in|verbal|import|keyword_stop|unsubscribe_link|manual
    sourceEvidence: jsonb("source_evidence").$type<Record<string, unknown>>().notNull().default({}),
    noticeVersion: text("notice_version"),
    ip: text("ip"),
    capturedBy: uuid("captured_by"),
    capturedAt: ts("captured_at").notNull().defaultNow(),
  },
  (t) => [index("los_consent_contact_idx").on(t.contactId, t.channel, t.capturedAt)],
);

export const auditLog = pgTable(
  "los_audit_log",
  {
    id: id(),
    orgId: orgId(),
    actorId: uuid("actor_id"),
    actorType: text("actor_type").notNull().default("user"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    ip: text("ip"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("los_audit_entity_idx").on(t.entity, t.entityId), index("los_audit_at_idx").on(t.at)],
);

export const dataRightsRequests = pgTable("los_data_rights_requests", {
  id: id(),
  orgId: orgId(),
  contactId: uuid("contact_id"),
  requesterEmail: text("requester_email"),
  requesterPhone: text("requester_phone"),
  kind: text("kind").notNull(), // access|correction|erasure|grievance
  status: text("status").notNull().default("open"), // open|in_progress|done|rejected
  details: text("details"),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  dueAt: ts("due_at"),
  completedAt: ts("completed_at"),
  handledBy: uuid("handled_by"),
  resolution: text("resolution"),
});

export const duplicateSuggestions = pgTable(
  "los_duplicate_suggestions",
  {
    id: id(),
    orgId: orgId(),
    contactA: uuid("contact_a").notNull(),
    contactB: uuid("contact_b").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"), // open|merged|dismissed
    resolvedBy: uuid("resolved_by"),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("los_duplicate_pair_uq").on(t.contactA, t.contactB)],
);

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export const enrichmentResults = pgTable("los_enrichment_results", {
  id: id(),
  orgId: orgId(),
  contactId: uuid("contact_id"),
  companyId: uuid("company_id"),
  provider: text("provider").notNull(),
  matched: boolean("matched").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
});

export const rateCard = pgTable(
  "los_rate_card",
  {
    id: id(),
    country: text("country").notNull(), // ISO-2, or '*' default
    category: text("category").notNull(),
    currency: text("currency").notNull(),
    rate: numeric("rate", { precision: 10, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
  },
  (t) => [uniqueIndex("los_rate_card_uq").on(t.country, t.category, t.effectiveFrom)],
);

export const broadcasts = pgTable("los_broadcasts", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  templateId: uuid("template_id").notNull(),
  segment: jsonb("segment").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("draft"), // draft|pending_approval|approved|sending|done|cancelled
  recipientCount: integer("recipient_count").notNull().default(0),
  excludedCount: integer("excluded_count").notNull().default(0),
  estimatedCost: numeric("estimated_cost", { precision: 12, scale: 2 }),
  createdBy: uuid("created_by"),
  approvedBy: uuid("approved_by"),
  confirmationText: text("confirmation_text"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  createdAt: createdAt(),
});

export const broadcastRecipients = pgTable(
  "los_broadcast_recipients",
  {
    id: id(),
    broadcastId: uuid("broadcast_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    leadId: uuid("lead_id"),
    messageId: uuid("message_id"),
    status: text("status").notNull().default("pending"), // pending|queued|skipped
    skipReason: text("skip_reason"),
  },
  (t) => [uniqueIndex("los_broadcast_recipient_uq").on(t.broadcastId, t.contactId)],
);
