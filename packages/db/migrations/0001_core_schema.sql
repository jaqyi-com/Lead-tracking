CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"storage_key" text,
	"filename" text,
	"mime" text,
	"size" integer,
	"provider_media_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"message_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"segment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost" numeric(12, 2),
	"created_by" uuid,
	"approved_by" uuid,
	"confirmation_text" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"weekly" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_normalised" text NOT NULL,
	"value_raw" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"website" text,
	"industry" text,
	"size_band" text,
	"city" text,
	"state" text,
	"country" text,
	"owner_id" uuid,
	"enriched_at" timestamp with time zone,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text NOT NULL,
	"basis" text NOT NULL,
	"source_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notice_version" text,
	"ip" text,
	"captured_by" uuid,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"company_id" uuid,
	"first_name" text,
	"last_name" text,
	"display_name" text,
	"job_title" text,
	"city" text,
	"state" text,
	"country" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"lifecycle_stage" text DEFAULT 'lead' NOT NULL,
	"owner_id" uuid,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"merged_into_id" uuid,
	"anonymised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"provider_thread_ref" text,
	"subject" text,
	"assigned_to" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_direction" text,
	"window_expires_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"wa_number_id" text,
	"mailbox_connection_id" uuid,
	"to_address" text,
	"is_junk" boolean DEFAULT false NOT NULL,
	"last_auto_ack_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_rights_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid,
	"requester_email" text,
	"requester_phone" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"details" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"handled_by" uuid,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "duplicate_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_a" uuid NOT NULL,
	"contact_b" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid,
	"company_id" uuid,
	"provider" text NOT NULL,
	"matched" boolean NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"step_position" integer NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"stop_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_send_day" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "free_email_domains" (
	"domain" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"business_hours_id" uuid,
	"day" date NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" bigserial NOT NULL,
	"contact_id" uuid NOT NULL,
	"company_id" uuid,
	"previous_lead_id" uuid,
	"source" text NOT NULL,
	"source_detail" text,
	"portal_lead_id" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"owner_id" uuid,
	"team_id" uuid,
	"score" integer DEFAULT 0 NOT NULL,
	"score_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"value_estimate" numeric(14, 2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lost_reason" text,
	"lost_note" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"enquiry" text,
	"language" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	"first_inbound_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"first_response_business_minutes" integer,
	"first_response_by" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_client_reply_at" timestamp with time zone,
	"touch_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp with time zone,
	"won_at" timestamp with time zone,
	"next_step" text,
	"next_step_at" timestamp with time zone,
	"revisit_at" timestamp with time zone,
	"parse_failed" boolean DEFAULT false NOT NULL,
	"is_junk" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lost_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"email" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"history_id" text,
	"watch_expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"provider_message_id" text,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text,
	"body_html" text,
	"body_full" text,
	"subject" text,
	"template_id" uuid,
	"template_vars" jsonb,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"pricing_category" text,
	"billable" boolean,
	"recipient_country" text,
	"is_auto" boolean DEFAULT false NOT NULL,
	"is_auto_reply" boolean DEFAULT false NOT NULL,
	"sequence_enrollment_id" uuid,
	"broadcast_id" uuid,
	"idempotency_key" text,
	"send_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"email_message_id" text,
	"in_reply_to" text,
	"references" text,
	"email_from" text,
	"email_to" jsonb,
	"email_cc" jsonb,
	"reply_to_context_id" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"conversation_id" uuid,
	"author_id" uuid,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notice_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"lead_id" uuid,
	"conversation_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parse_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid,
	"webhook_event_id" uuid,
	"parser" text NOT NULL,
	"reason" text NOT NULL,
	"raw" jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text NOT NULL,
	"category" text NOT NULL,
	"currency" text NOT NULL,
	"rate" numeric(10, 4) NOT NULL,
	"effective_from" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strategy" text DEFAULT 'round_robin' NOT NULL,
	"target_team_id" uuid,
	"target_user_id" uuid,
	"fallback" text DEFAULT 'next_rule' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"offset_business" boolean DEFAULT false NOT NULL,
	"action" text DEFAULT 'send' NOT NULL,
	"channel" text NOT NULL,
	"template_internal_name" text,
	"wa_body" text,
	"email_subject" text,
	"email_body" text,
	"task_title" text,
	"revisit_days" integer,
	"requires_human" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entry_condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"pending_totp" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"timer_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"owner_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stage" text,
	"target_minutes" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"conversation_id" uuid,
	"policy_id" uuid,
	"kind" text NOT NULL,
	"stage" text,
	"owner_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"target_minutes" integer NOT NULL,
	"warn_at" timestamp with time zone NOT NULL,
	"breach_at" timestamp with time zone NOT NULL,
	"hard_breach_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"warned_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"hard_breached_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"folder" text DEFAULT 'General' NOT NULL,
	"shortcut" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"channel" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid,
	"assignee_id" uuid,
	"title" text NOT NULL,
	"type" text DEFAULT 'follow_up' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_hours_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"internal_name" text NOT NULL,
	"provider_name" text NOT NULL,
	"provider_template_id" text,
	"category" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"header" text,
	"body" text NOT NULL,
	"footer" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_status" text DEFAULT 'draft' NOT NULL,
	"rejection_reason" text,
	"email_subject" text,
	"last_synced_at" timestamp with time zone,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'rep' NOT NULL,
	"team_id" uuid,
	"is_available" boolean DEFAULT true NOT NULL,
	"capacity" integer DEFAULT 60 NOT NULL,
	"working_hours_id" uuid,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"territories" text[] DEFAULT '{}'::text[] NOT NULL,
	"tz" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"push_subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_number" text,
	"waba_id" text,
	"quality_rating" text,
	"messaging_limit" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_ok" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "activities_lead_idx" ON "activities" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activities_type_idx" ON "activities" USING btree ("org_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipient_uq" ON "broadcast_recipients" USING btree ("broadcast_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_uq" ON "channel_identities" USING btree ("org_id","kind","value_normalised");--> statement-breakpoint
CREATE INDEX "channel_identities_contact_idx" ON "channel_identities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_domain_uq" ON "companies" USING btree ("org_id","domain") WHERE "companies"."domain" is not null;--> statement-breakpoint
CREATE INDEX "companies_name_trgm" ON "companies" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "consent_contact_idx" ON "consent_records" USING btree ("contact_id","channel","captured_at");--> statement-breakpoint
CREATE INDEX "contacts_company_idx" ON "contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contacts_name_trgm" ON "contacts" USING gin ((coalesce("display_name", '') || ' ' || coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "conversations_lead_idx" ON "conversations" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "conversations" USING btree ("org_id","state","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_assigned_idx" ON "conversations" USING btree ("assigned_to","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_window_idx" ON "conversations" USING btree ("window_expires_at") WHERE "conversations"."window_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_pair_uq" ON "duplicate_suggestions" USING btree ("contact_a","contact_b");--> statement-breakpoint
CREATE INDEX "enrollment_events_enr_idx" ON "enrollment_events" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "enrollments" USING btree ("next_run_at") WHERE "enrollments"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_active_uq" ON "enrollments" USING btree ("lead_id","sequence_id") WHERE "enrollments"."state" = 'active';--> statement-breakpoint
CREATE INDEX "holidays_org_day_idx" ON "holidays" USING btree ("org_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_sources_key_uq" ON "lead_sources" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "leads_open_contact_idx" ON "leads" USING btree ("contact_id") WHERE "leads"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "leads_owner_stage_idx" ON "leads" USING btree ("owner_id","stage");--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("org_id","stage");--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_portal_uq" ON "leads" USING btree ("org_id","source","portal_lead_id") WHERE "leads"."portal_lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "lost_reasons_key_uq" ON "lost_reasons" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_email_uq" ON "mailbox_connections" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_uq" ON "messages" USING btree ("channel","provider_message_id") WHERE "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idem_uq" ON "messages" USING btree ("idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_email_mid_idx" ON "messages" USING btree ("email_message_id") WHERE "messages"."email_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status") WHERE "messages"."status" in ('queued','sending');--> statement-breakpoint
CREATE INDEX "notes_lead_idx" ON "notes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "notice_versions_uq" ON "notice_versions" USING btree ("org_id","version");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_card_uq" ON "rate_card" USING btree ("country","category","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_pos_uq" ON "sequence_steps" USING btree ("sequence_id","position");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_breaches_uq" ON "sla_breaches" USING btree ("timer_id","level");--> statement-breakpoint
CREATE INDEX "sla_timers_running_idx" ON "sla_timers" USING btree ("state","warn_at") WHERE "sla_timers"."state" = 'running';--> statement-breakpoint
CREATE INDEX "sla_timers_lead_idx" ON "sla_timers" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_open_idx" ON "tasks" USING btree ("assignee_id","due_at") WHERE "tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "tasks_lead_idx" ON "tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_provider_uq" ON "templates" USING btree ("org_id","channel","provider_name","language");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_numbers_pnid_uq" ON "wa_numbers" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_uq" ON "webhook_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;