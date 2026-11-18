# Doott Lead Operating System — Implementation Plan

**Source:** *Doott Lead Operating System — Build Spec & Workflow* (18 Nov 2026). Section numbers below (§x.y) point to that spec.
**Status:** v1 code written 18 Nov 2026 — see §11 for what is built and what remains
**Target:** v1 (Phases 0–4) in 11–12 weeks. Phase 5 hardening follows.

---

## 0. Assumptions (until the open decisions in §15.2 are answered)

The spec's eight open questions are still unanswered. The plan uses the defaults below. Each one is cheap to change now and more expensive later.

| # | Open decision | Default used in this plan | What changes if it's wrong |
|---|---|---|---|
| 1 | Volume & team | About 1,000 leads/month, 5–15 reps, 1–2 managers | Above 10k/month: split the worker pool earlier and partition `messages` by month |
| 2 | Who builds | Code written here (Claude, in this repo) with one Doott engineer who owns deploys and reviews | Agency/in-house: same plan, but put the runbook and ADRs in the first week |
| 3 | Internal vs product | **Internal, single tenant, but every tenant-root table carries `org_id`** (one row, fixed). This costs almost nothing now and avoids a rewrite if it becomes a product | Product: add row-level security per `org_id`, and budget for Gmail CASA (§6.1) |
| 4 | Numbers & mailboxes | 1 live WhatsApp number (Coexistence), 1 test number; `sales@` + `info@` via inbound parse; rep mailboxes via Gmail (Google Workspace) | Microsoft 365 reps: add a Graph adapter in Phase 2 (+3 days) |
| 5 | Lead sources | Website form, IndiaMART, TradeIndia, Justdial, LinkedIn lead notifications | Each extra parser is about 0.5 day with fixtures |
| 6 | Languages | English templates first; Hindi variants of `lead_ack` and `after_hours_ack` in Phase 3; STOP keywords in English and Hindi from day one | Gujarati: more templates to get approved, no code change |
| 7 | Existing data | A spreadsheet of current leads, imported by CSV in Phase 1 | A CRM export needs a mapping script |
| 8 | Interim tool | Yes. Shortlist one BSP inbox on a monthly plan (§14) and run it until cutover at the end of Phase 2 | — |

---

## 1. Technical decisions (ADR summary)

These follow the spec's recommended stack (§4.4). Where the spec offers a choice, one option is picked here.

| Concern | Decision | Reason |
|---|---|---|
| Language | TypeScript everywhere, Node 22 LTS | One language across front and back end (§4.4) |
| Repo | pnpm workspaces monorepo (no Turborepo needed yet) | Shared types between API, worker and web |
| API | **Fastify** (changed from NestJS during the build) | Less framework for one engineer to own; RBAC is plain guard functions in `apps/api/src/http.ts` |
| Webhook ingress | **A separate tiny Fastify service (`apps/ingest`)** | It is the only component whose downtime loses data (§4.5), so it deploys on its own and never restarts because of an API deploy |
| DB | PostgreSQL 16, **Drizzle ORM + plain SQL migrations** | Drizzle lets us write raw SQL for tsvector, partial indexes, materialised views and advisory locks |
| Queue | BullMQ on Redis 7 | Delayed jobs for SLA and cadence, retries, dead-letter queue (§4.4) |
| Realtime | Socket.IO + Redis adapter, run inside the API process | Simple. Can be moved out later |
| Web | Next.js 15 (App Router) + TanStack Query + Tailwind + shadcn/ui | Matches §4.4. The inbox is client-rendered; reports and admin can render on the server |
| Auth | Google Workspace SSO (OIDC) as primary, email+password+TOTP as fallback | Internal tool. TOTP is mandatory for admins (§11.2) |
| Files | Cloudflare R2 (S3 API), signed URLs, MinIO locally | §4.4 |
| Inbound email | **Postmark Inbound** on `inbox.doott.com` | Cleanest parsed JSON, and it keeps `Message-ID`, `In-Reply-To` and `References` |
| System email | Amazon SES on `mail.doott.com` | Cheapest. Kept separate from rep mail (§6.4) |
| Phone parsing | `libphonenumber-js` (max metadata), default region IN | §7.2 |
| Errors/metrics | Sentry + Grafana Cloud (Loki logs, Prometheus metrics) + Bull Board | §4.1 Ops |
| Hosting | 2 VPS in an India region (Mumbai): `ingest+api` and `worker`, managed Postgres with PITR, managed Redis. Docker images built by GitHub Actions | §4.4 "boring and cheap" |

Each of these gets a one-page ADR in `docs/adr/` during Phase 0.

---

## 2. Repository layout

```
Leadtracking/
├─ apps/
│  ├─ ingest/          # Fastify: /webhooks/whatsapp, /webhooks/email, /webhooks/gmail-push, /intake/form
│  ├─ api/             # NestJS: REST + WebSocket gateway
│  ├─ worker/          # NestJS standalone: BullMQ processors + scheduler
│  └─ web/             # Next.js agent workspace
├─ packages/
│  ├─ db/              # Drizzle schema, SQL migrations, seed, test factories
│  ├─ domain/          # Pure logic: normalise, identity, lead-decision, window, scoring, routing, business-hours math
│  ├─ messaging/       # MessagingProvider interface + WhatsAppCloudProvider (+ BSP stub later)
│  ├─ email/           # Inbound parse adapter, Gmail adapter, SES sender, threading, reply-stripper
│  ├─ parsers/         # Portal lead parser registry + fixtures
│  ├─ contracts/       # zod schemas + shared TS types (API DTOs, queue job payloads, WS events)
│  └─ config/          # env loading/validation (zod), logger, Sentry init
├─ infra/
│  ├─ docker-compose.yml   # postgres, redis, minio, mailpit
│  ├─ docker/              # Dockerfiles per app
│  └─ deploy/              # Caddy config, systemd/compose for VPS, backup scripts
├─ fixtures/           # Saved Meta webhook payloads, MIME emails, portal emails
├─ docs/
│  ├─ IMPLEMENTATION_PLAN.md
│  ├─ adr/
│  └─ runbook.md
└─ .github/workflows/  # ci.yml, deploy-staging.yml, deploy-prod.yml
```

**Rule:** `packages/domain` has no I/O and is fully unit-tested. Window rules, SLA business-hours math, scoring, routing selection and lead decisions all live there. Most of the logic that can go wrong is in these functions, so this is where tests pay off most.

---

## 3. Cross-cutting engineering design

These hold across all phases. Build them correctly in Phase 1, because they are hard to retrofit.

### 3.1 Ingestion contract (§2 principle 5, §5.7)
1. `ingest` verifies the signature: `X-Hub-Signature-256` HMAC over the **raw body**, Postmark basic-auth plus IP allowlist, form shared secret plus rate limit.
2. `INSERT INTO webhook_events (provider, external_id, payload, signature_ok) ON CONFLICT (provider, external_id) DO NOTHING`.
3. Enqueue `{webhook_event_id}` to `ingest.process`, then return `200`. No parsing happens on the request thread. Target p95 under 200ms (load-tested with k6 in Phase 1).
4. If Redis is down, the row is still in Postgres. A sweeper re-enqueues rows where `processed_at IS NULL AND received_at < now() - 1 min`. **Postgres is the durability layer; Redis is only the transport.**

### 3.2 Concurrency and idempotency
- **Per-contact serialisation:** the processor takes `pg_advisory_xact_lock(hashtext(kind||':'||value_normalised))` before identity resolution. Two messages from the same new number in the same second then cannot create two contacts or two leads (§9.1 "Two webhooks… must not produce two owners").
- `channel_identities` has a unique index on `(kind, value_normalised)` and is inserted with `ON CONFLICT`.
- Assignment uses `UPDATE leads SET owner_id = $1 WHERE id = $2 AND owner_id IS NULL RETURNING`. Exactly one writer wins.
- Every outbound `messages` row carries an `idempotency_key` (unique). The worker re-checks `status = 'queued'` before calling the provider.

### 3.3 Events and history (§2 principle 4)
- Every state change writes an `activities` row **in the same transaction** as the change (stage, owner, qualification, tags, notes, tasks).
- Writes to leads, consent, templates and settings also write `audit_log` (before/after). This is done in a service-layer helper, not with DB triggers, so the actor and IP are available.
- After commit, an outbox publishes to Redis pub/sub, which pushes WebSocket events to the inbox.

### 3.4 Timers: delayed job plus sweeper
SLA warnings and breaches, cadence steps, window expiry, snoozes and task reminders are stored as **rows with a `due_at`** (`sla_timers`, `enrollments.next_run_at`, `conversations.window_expires_at`, …). A BullMQ delayed job fires each one on time. A once-a-minute sweeper catches any job lost to a Redis restart. Breaches are written as `sla_breaches` rows (§9.5).

### 3.5 Business-hours math
`packages/domain/business-hours.ts` takes the team's weekly windows, the holiday calendar and the timezone, and provides `addBusinessMinutes(start, n)` and `businessMinutesBetween(a, b)`. The SLA, cadence quiet hours (09:00–20:00 contact TZ) and the "speed to lead" metric all use this one implementation. Property-based tests (fast-check) cover DST-free IST plus a non-IST team.

### 3.6 Permissions
Use a NestJS guard plus a query scoping helper: `scopeLeads(user)` returns where-clauses (Rep: `owner_id = me OR owner_id IS NULL OR shared_with ∋ me`; Manager/Admin: all; Viewer: no message bodies). Every repository method that lists data must go through it, and a lint test enforces this.

### 3.7 Spec points that need a decision (flagged, defaults chosen)
| Spec point | Ambiguity | Default |
|---|---|---|
| §8.4 rule 3 "no save without `next_step_at`" | System-created leads have no next step | The rule applies to **human edits** only. Auto-created leads get a system task "First contact" due at the SLA deadline |
| §7.3 "open lead older than 30 days → new lead" | The old lead would stay open alongside the new one | The stale lead auto-closes as `Lost: went_silent` with a link to the new lead. If the stale lead is in Quoted or Negotiation, attach to it instead |
| §5.7 echo messages + §3.1 step 10 | Does a phone-app reply stop the SLA clock? | **Yes.** An echo is a human outbound message (`author = phone_app`). It is marked separately in reports so managers can see out-of-system usage (§15.1) |
| §4.2 `raw_events` vs §7.1 `webhook_events` | Two names for one table | `webhook_events` |
| §3.2 Attempting "up to 5 attempts" vs §9.3 seven steps | Count mismatch | Attempts = human or cadence outbound touches. Auto-ack counts as touch #1 for portal leads only (§9.2) |

---

## 4. Data model build order

Migrations go in this order so that each phase ships a working schema. All tables get `id uuid pk default gen_random_uuid()`, `org_id`, `created_at` and `updated_at`.

| Migration | Tables | Phase |
|---|---|---|
| 0001 core | `orgs`, `users`, `teams`, `business_hours`, `holidays` | 1 |
| 0002 identity | `companies`, `contacts`, `channel_identities` (unique `(org_id, kind, value_normalised)`), `free_email_domains` (seed) | 1 |
| 0003 leads | `leads` (+ partial index `WHERE closed_at IS NULL` on `(contact_id)`), `lead_sources`, `activities`, `notes`, `tasks` | 1 |
| 0004 messaging | `conversations`, `messages` (unique `(channel, provider_message_id)`, unique `idempotency_key`, `tsvector` generated column + GIN), `attachments` | 1 |
| 0005 ingest | `webhook_events` (unique `(provider, external_id)`), `parse_failures` | 1 |
| 0006 templates | `templates`, `snippets`, `snippet_folders` | 2 |
| 0007 email threading | `email_message_ids` (Message-ID → message_id), `mailbox_connections` (OAuth tokens encrypted, `history_id`, `watch_expires_at`) | 2 |
| 0008 discipline | `routing_rules`, `sla_policies`, `sla_timers`, `sla_breaches`, `lost_reasons` (seed), `sequences`, `sequence_steps`, `enrollments`, `enrollment_events` | 3 |
| 0009 consent | `consent_records` (append-only: no UPDATE grant for the app role except `withdrawn_at` via a new row), `notice_versions`, `suppression` view | 3 |
| 0010 intelligence | `enrichment_results`, `score_events`, `broadcasts`, `broadcast_recipients`, materialised views `mv_funnel_daily`, `mv_rep_response`, `mv_template_perf`, `mv_wa_cost_monthly` | 4 |
| 0011 compliance | `audit_log` (from Phase 1, extended here), `data_rights_requests`, `grievances`, `duplicate_suggestions` | 1 / 5 |

Retention jobs (§7.4): purge `webhook_events` older than 30 days nightly (Phase 1). Archive messages older than 24 months (Phase 5). Erasure anonymises in place (Phase 5).

---

## 5. Phase plan

Estimates are engineer-days (d) for one full-stack engineer. Two engineers can run the backend and frontend columns in parallel. IDs are used for tracking.

### Phase 0 — Prerequisites (week 0, in parallel with Phase 1 start)

**Business/admin tasks (Doott owner, not code). Start on day 1: Meta verification is the longest-lead item.**

| ID | Task | Owner |
|---|---|---|
| P0-1 | Create Meta Business Portfolio and WABA. **Submit business verification** | Doott admin |
| P0-2 | Buy the test SIM. Register it on a **separate test WABA**. Create a Meta app with WhatsApp product, system user and permanent token | Doott admin + eng |
| P0-3 | Plan the Coexistence onboarding of the live number (done in Phase 1 week 3, after ingestion is proven on the test number) | Doott admin |
| P0-4 | DNS: `inbox.doott.com` MX → Postmark. `mail.doott.com` SPF/DKIM/DMARC (`p=none`) → SES. Verify the SES domain and request production access | eng |
| P0-5 | Google Cloud project: Gmail API, Pub/Sub topic `gmail-push`, grant `gmail-api-push@system.gserviceaccount.com` publisher, **Internal** OAuth consent screen | Workspace admin + eng |
| P0-6 | **Submit the first four templates to Meta**: `lead_ack`, `after_hours_ack`, `follow_up_1`, `follow_up_2` (staging copies on the test WABA) | eng + sales lead |
| P0-7 | Interim BSP inbox subscription on Coexistence (§14) | Doott admin |

**Engineering tasks (≈5d):**

| ID | Task | Est |
|---|---|---|
| E0-1 | Monorepo scaffold, TS config, ESLint/Prettier, Vitest, Turborepo pipelines | 0.5d |
| E0-2 | `infra/docker-compose.yml` (Postgres 16, Redis 7, MinIO, Mailpit) and `pnpm dev` that starts everything | 0.5d |
| E0-3 | `packages/config`: zod-validated env, pino logger with request IDs, Sentry init | 0.5d |
| E0-4 | CI: lint, typecheck, unit tests, integration tests against service containers, Docker build | 1d |
| E0-5 | Staging + prod VPS provisioned, managed PG (PITR on) and Redis, Caddy TLS, deploy workflow, health checks, uptime monitor on `ingest` | 1.5d |
| E0-6 | Smoke spike: `ingest` receives a real Meta webhook from the test number, and a test email to `test@inbox.doott.com` arrives as JSON | 1d |

**Done when:** a test message sent and received through the Cloud API on the test number is visible in `webhook_events`, and a test email lands on the inbound webhook (spec Phase 0 criterion).

---

### Phase 1 — Capture and record (weeks 1–3)

**Goal:** every enquiry produces a lead with an owner. No inbox replies yet.

| ID | Task | Spec | Est |
|---|---|---|---|
| **Backend** ||||
| P1-1 | Migrations 0001–0005, Drizzle schema, seed (org, admin user, team, IST business hours, Indian holidays 2026–27, free-email domains, lead sources) | §7.1 | 2d |
| P1-2 | `ingest` WhatsApp endpoint: GET verify challenge, POST HMAC verify on raw body, store, enqueue, 200 | §5.7 | 1d |
| P1-3 | `ingest` email endpoint (Postmark Inbound) and `/intake/form` (shared secret, per-IP rate limit, honeypot) | §6.1A | 1d |
| P1-4 | Re-enqueue sweeper and dead-letter queue. Bull Board behind admin auth | §3.1 above | 0.5d |
| P1-5 | `domain/normalise`: E.164 via libphonenumber, email lower-case, wa_id kept separate, reply/signature stripping (`email-reply-parser` + Indian-signature fixtures) | §3.1.3, §7.2 | 1.5d |
| P1-6 | `domain/identity`: ordered deterministic matching, company-from-domain with free-provider blocklist, advisory lock | §7.3 | 1.5d |
| P1-7 | `domain/lead-decision`: attach to an open lead under 30 days old, otherwise create a new lead linked to the previous one; closed lead → new lead | §3.1.5, §7.3 | 1d |
| P1-8 | WhatsApp inbound processor: all message types (text, image, document, audio, video, location, contacts, interactive/button replies), `statuses` (store pricing block), **echo messages** as outbound `author=phone_app`, template status and quality events stored for later | §5.7 | 3d |
| P1-9 | Media worker: media id → URL → download with bearer token → R2 → `attachments` (mime, size). Never hotlink | §5.7 | 1d |
| P1-10 | Email inbound processor: participants, Message-ID storage, header threading (In-Reply-To/References), plus-address `lead+<id>-<hmac>@` decoding, auto-reply detection (`Auto-Submitted`, `X-Autoreply`, OOO patterns), internal-forward → note, attachments to R2 | §6.3, §6.5 | 2.5d |
| P1-11 | Simple manual + round-robin assignment (full routing engine comes in Phase 3), idempotent claim | §9.1 | 1d |
| P1-12 | New-lead notifications: in-app WebSocket, web push (VAPID), email to owner via SES | §13 P1 | 1d |
| P1-13 | Auth: Google SSO + password/TOTP, sessions, roles, `scopeLeads` guard, audit log helper | §11 | 2d |
| P1-14 | REST: leads list/filter/detail, contacts, companies, conversations (read), messages (read), assignment, sources admin, CSV import (dry-run + commit) | §13 P1 | 2d |
| **Frontend** ||||
| P1-15 | App shell, auth pages, nav, keyboard shortcut framework (`g i`, `g p`, `j/k`) | §8.2 | 1.5d |
| P1-16 | Lead list with filters (source, owner, stage, date, unassigned) and lead detail (read-only timeline across channels) | §8.1 | 2.5d |
| P1-17 | Admin: users and roles, sources, CSV import wizard | §8.1 | 1.5d |
| **Go-live of capture** ||||
| P1-18 | k6 load test: `ingest` p95 under 200ms at 50 rps. Restart-chaos test (kill the worker mid-burst, nothing is lost) | §4.5 | 0.5d |
| P1-19 | **Reconciliation harness:** a script sends 50 mixed enquiries (WA text/media, sales@, info@, form, duplicates, same-second pairs) and asserts 50 leads, 0 duplicates, all with an owner, under 60s each | §13 P1 | 1d |
| P1-20 | Onboard the live number via **Coexistence** (Embedded Signup), import the 180-day history sync, verify echoes | §5.2 | 0.5d |

**≈ 31d.** One engineer can finish in 3 weeks only with tight scope. Two engineers is comfortable.

**Done when:** P1-19 passes on staging and then again on production against the live number. Every lead has a named owner within 60s (Outcome #1).

---

### Phase 2 — Two-way messaging and the unified inbox (weeks 4–6)

**Goal:** a rep runs a full enquiry, from first message to quote, without the phone or Gmail.

| ID | Task | Spec | Est |
|---|---|---|---|
| **Backend** ||||
| P2-1 | `MessagingProvider` interface (`sendText`, `sendTemplate`, `sendMedia`, `fetchMedia`, `normaliseInbound`) and `WhatsAppCloudProvider` | §5.1 | 1.5d |
| P2-2 | Outbound pipeline: row first (`queued`), worker sends, status webhooks move it through sent → delivered → read/failed. Plain-language error mapping for Meta codes (131047 window closed, 131026 undeliverable, 470, 131049 …) | §4.3, §8.4.6 | 2d |
| P2-3 | **Window engine:** `last_inbound_at`, `window_expires_at`, server-side revalidation at send time, expiry sweep → `window_closed` + WS event | §5.3 | 1.5d |
| P2-4 | Template sync: pull the WABA template list, template-status webhook, local variables schema, cost class per category (India rate card in config) | §5.5, §5.4 | 1.5d |
| P2-5 | Gmail mailbox connect (OAuth Internal), `users.watch` → Pub/Sub push to `ingest`, `history.list` incremental fetch, watch renewal job (every 6 days), token refresh | §6.1B | 3d |
| P2-6 | Email send: through the rep's Gmail when connected (correct `In-Reply-To`/`References`, `Reply-To: lead+<id>-<hmac>@inbox`), otherwise SES. Bounce/complaint webhooks → mark email invalid | §6.4, §6.5 | 2d |
| P2-7 | Notes with @mentions (notify), snippets with variables and folders, tasks CRUD | §8.2 | 1.5d |
| P2-8 | Auto-acknowledgement v1: WA free-form when the window is open, `lead_ack`/`after_hours_ack` template when it is closed or out of hours; email auto-reply at most once per 24h per contact, never to an auto-reply | §9.2 | 1.5d |
| P2-9 | **First-response stamping:** `leads.first_response_at` set by the first human outbound (including echo), never by auto-ack | §3.1.10 | 0.5d |
| P2-10 | Presence: viewing/typing over WS, soft compose lock | §8.2 | 1d |
| P2-11 | Search: Postgres FTS over messages and notes plus trigram on contacts/companies, one endpoint, under 500ms (seed 5M synthetic messages to verify) | §4.5 | 1.5d |
| **Frontend** ||||
| P2-12 | **Inbox:** 3-pane layout, conversation list with filters (Unassigned, Mine, Team, Awaiting us, Window <2h, Unread, Junk), virtualised list, live updates | §8.1–8.2 | 3d |
| P2-13 | Thread view: messages, media previews, delivery ticks, failed-state with reason and retry, internal notes styled clearly, activity events inline | §8.2 | 2d |
| P2-14 | **Composer:** WA open (free-form + countdown chip), WA closed (template picker with pre-filled vars, live preview, cost class), email (subject, quoted thread, attachments, send-later), `/` snippets, `r` / `t` shortcuts | §8.2, §5.3 | 3d |
| P2-15 | Context rail: contact, company, source, stage, owner, value, last 5 activities, open tasks, consent per channel (placeholder until P3), previous lead | §8.3 | 1.5d |
| P2-16 | Quick actions: stage change, next-step date, task, tag, snooze, junk, claim (`a`), close (`e`). Mobile-responsive inbox and web push | §8.2 | 2d |
| **Acceptance** ||||
| P2-17 | Scripted E2E (Playwright) for a full enquiry on staging with the test number. Then a **pilot with 2 reps for 1 week** before cutover | §13 P2 | 1d |
| P2-18 | **Cutover:** reps move to the system; interim BSP kept one extra month (§14) | §14 | — |

**≈ 33d.**

**Done when:** pilot reps complete enquiries end to end with no phone or Gmail tab. Echo-message share (sends from the phone app) is reported and falling.

---

### Phase 3 — Discipline: pipeline, SLA, routing, cadence, consent (weeks 7–9)

| ID | Task | Spec | Est |
|---|---|---|---|
| P3-1 | Stage machine in `domain/`: allowed transitions, qualification-complete gate past Engaged, Lost requires a reason from a fixed list, Nurture requires a revisit date, Disqualified tag | §3.2, §3.3, §8.4 | 1.5d |
| P3-2 | Qualification block UI (10 fields, saved any time, validated on advance) | §3.3 | 1.5d |
| P3-3 | Pipeline Kanban: drag between columns (runs the same stage gate), count and value per column, filters | §8.1 | 2d |
| P3-4 | **Routing engine:** rules in priority order (conditions JSON: source, source_detail, size band, keywords, city/state, language), strategies (sticky owner first, source, territory, round-robin with capacity and working hours), fallback to Unassigned. Admin rule form plus a "test this rule against lead X" dry-run | §9.1 | 3d |
| P3-5 | **SLA engine:** policies by stage, business-hours clocks, 50% warn / 100% breach / 200% auto-reassign, `sla_breaches` rows, escalation notifications, manager watcher | §9.5, §3.2 | 2.5d |
| P3-6 | Admin: business hours per team, holiday calendar, SLA targets, lost reasons | §8.1 | 1d |
| P3-7 | **Cadence engine:** sequences/steps/enrollments; enrol on Attempting; stop on reply on any channel, stage past Engaged, or close; window-aware substitution (template → email fallback, never a silent skip); quiet hours 09–20 contact TZ plus holidays; at most one channel per day; consent check at send; every skip/substitute/suppress logged on the lead | §9.3 | 4d |
| P3-8 | Seed the default 7-step inbound sequence; step 7 → Nurture + 60-day revisit task | §9.3 | 0.5d |
| P3-9 | **Consent ledger:** append-only records (basis, purpose, evidence, notice version, IP); capture from form opt-in, WhatsApp inbound (service-only basis), manual entry with evidence upload | §7.1, §11.4 | 1.5d |
| P3-10 | Opt-out: STOP/UNSUBSCRIBE/रोकें/बंद करो/band karo … keywords, email one-click unsubscribe (RFC 8058 `List-Unsubscribe-Post`), immediate suppression across sequences, confirmation reply | §5.6, §6.4 | 1d |
| P3-11 | Server-side send gate: no business-initiated WA without granted consent; enforced in the worker, not only the UI | §8.4.4 | 0.5d |
| P3-12 | **My day** screen: overdue tasks, today's follow-ups, SLA at risk, unanswered conversations | §8.1 | 1.5d |
| P3-13 | Remaining templates submitted: `quote_sent`, `meeting_confirm`, `meeting_reminder`, `sample_data_ready`, Hindi `lead_ack`/`after_hours_ack` | §5.5 | 0.5d |
| P3-14 | Duplicate suggestions queue + one-click merge (reparents identities, leads, conversations, activities; audit record) | §7.3 | 2d |

**≈ 23d.** Build P3-4, P3-5 and P3-7 first: Phase 3 is judged on them.

**Done when:** system-measured median first response in business hours is under 5 minutes for two consecutive weeks, and no lead sits unassigned for more than 2 minutes (spec Phase 3 criterion).

---

### Phase 4 — Intelligence and reporting (weeks 10–11)

| ID | Task | Spec | Est |
|---|---|---|---|
| P4-1 | Materialised views refreshed every 5 min (`REFRESH … CONCURRENTLY`): funnel by source × month, rep response (median/p90 on business minutes), template performance, WA cost (from Meta pricing on status webhooks), leakage, unanswered-24h | §10 | 2.5d |
| P4-2 | Dashboards: **Today**, **Funnel**, **Team**, **Channel & cost** (incl. service-message usage vs 1,000 free per number per month) | §10 | 3d |
| P4-3 | **Doott enrichment** on lead creation: internal Doott DB lookup by email/phone/domain → job title, company size, industry, city; email verification state; store in `enrichment_results` with source/time; shown in context rail | §3.1.6 | 2d |
| P4-4 | **Scoring:** rule table from §9.4, explanation shown as a list of points ("+15 buyer role"), recomputed on relevant events, queue ordering by score, bands hot/warm/low | §9.4 | 1.5d |
| P4-5 | **Portal parser registry:** match by sender/subject; parsers for IndiaMART, TradeIndia, Justdial, LinkedIn, website form; portal lead id dedupe; `parse_failed` admin queue with raw body; fixture tests per parser | §6.2 | 3d |
| P4-6 | Portal-lead first touch: WA utility template + email, both counted as attempt #1 | §9.2 | 0.5d |
| P4-7 | **Broadcasts:** segment builder → consent filter → preview, recipient count, estimated cost (category × rate), typed confirmation, manager approval, per-minute send cap, results by template | §8.4.5, §12.2 | 2.5d |
| P4-8 | Quality rating and messaging-limit pull from Graph API onto the Today dashboard, with alert on yellow/red | §11.3 | 0.5d |
| P4-9 | Spam/vendor classifier v1 (rules + blocklist) → Junk view | §6.5 | 1d |

**≈ 16.5d.**

**Done when:** the weekly sales review runs entirely from the dashboards, with no spreadsheet.

---

### Phase 5 — Hardening and assist (week 12 onward)

| ID | Task | Spec |
|---|---|---|
| P5-1 | Backup/restore drill on staging (PITR to a timestamp), documented in the runbook. **Gate for calling v1 done** | §4.5, §11.2 |
| P5-2 | Dead-letter replay UI (re-run `webhook_events` after a bug fix) | §5.7 |
| P5-3 | DPDP: notice versioning on all forms, data-rights request queue (access/correct/erase) with turnaround tracking, anonymise-in-place erasure, grievance queue, breach procedure doc | §11.4 |
| P5-4 | Retention: archive messages/media older than 24 months to cold storage | §7.4 |
| P5-5 | Rate limits per endpoint, outbound cap per number, admin export rate-limited and logged | §11.1–11.2 |
| P5-6 | Secret rotation schedule (Meta app secret, system-user token), dependency/container scanning in CI | §11.2 |
| P5-7 | AI assist (draft-and-approve only): reply drafts, thread summary, qualification auto-fill suggestions; every suggestion logged with accept/reject | §13 P5 |
| P5-8 | Microsoft Graph mailbox adapter, if needed | §6.1B |

Deadline note: DPDP substantive obligations apply from **13 May 2027**. P5-3 must ship before then, and the consent ledger (P3-9) is the foundation for it.

---

## 6. Timeline at a glance

```
Week:      0    1    2    3    4    5    6    7    8    9   10   11   12+
Phase 0  ████
Phase 1       ██████████████
Phase 2                      ██████████████
                                        ▲ cutover (end wk 6), BSP kept +1 month
Phase 3                                     ██████████████
Phase 4                                                    █████████
Phase 5                                                              ████…
Meta verification  ═══════════════════ (external; start day 1)
Template approvals ════════      ═════ (batch 1 in P0, batch 2 in P3)
```

Sequencing rule (§13): if a phase slips, **cut scope inside the phase**. Do not reorder phases. Candidates to cut, in order: presence/typing (P2-10), send-later, duplicate merge UI (keep the queue), Hindi templates, the classifier (blocklist only).

---

## 7. Testing strategy

| Layer | What | Tooling |
|---|---|---|
| Unit | `packages/domain`: normalise, identity order, lead decision, window, business-hours math, SLA thresholds, cadence step selection, scoring, routing selection, stage gates | Vitest + fast-check |
| Contract | Every saved Meta webhook fixture and every MIME and portal email fixture parses to the expected normalised event | Vitest + `fixtures/` |
| Integration | Processors against real Postgres/Redis (testcontainers in CI): concurrency tests firing 20 same-second webhooks for one new number → 1 contact, 1 lead, 1 owner | Vitest |
| E2E | Inbox flows, composer window states, stage gates, broadcast confirmation | Playwright on staging |
| Load | `ingest` p95 under 200ms; search under 500ms at 5M messages | k6 + synthetic seed |
| Reconciliation | 50-enquiry zero-loss harness (P1-19), run before every production deploy that touches ingestion | script in CI (staging) |

Fixtures policy: whenever a production payload breaks a processor, it is anonymised and added to `fixtures/` with a regression test before the fix merges.

---

## 8. Environments and operations

| Env | WhatsApp | Email | Data |
|---|---|---|---|
| Local | Recorded fixtures + `ngrok` to test WABA when needed | Mailpit; Postmark fixtures | Docker PG/Redis/MinIO |
| Staging | **Test WABA / test number** | `staging-inbox.doott.com` | Separate managed DB; synthetic data |
| Production | Live number (Coexistence) | `inbox.doott.com`, rep Gmail | Managed PG with PITR, daily encrypted offsite backup |

Runbook (`docs/runbook.md`) covers: deploy and rollback, rotate Meta token, renew Gmail watches manually, replay dead letters, restore from backup, what to do when the quality rating turns yellow, and how to disconnect Coexistence.

Alerts: `ingest` 5xx or p95 over 200ms, queue depth over 500 or oldest job over 2 min, any unprocessed `webhook_events` older than 5 min, Gmail watch expiring within 24h, WA quality rating change, service-message usage over 80% of the free allowance, any SLA hard breach.

---

## 9. Definition of done for v1

1. **Zero lost enquiries:** the reconciliation harness passes on production, and the daily "Unassigned for more than 2 min" and "Unanswered 24h" counts are 0.
2. **Fast first response:** system-measured median under 5 min and p90 under 15 min in business hours, for 2 consecutive weeks.
3. **One truth:** the funnel dashboard shows source → qualified → quoted → won with cost per won deal, and it is used for the weekly review.
4. Restore drill done, runbook written, and at least two people have deployed to production.

---

## 10. Immediate next steps

1. Answer or confirm the §0 assumptions, especially #2 (who builds), #3 (internal vs product) and #4 (numbers and mailboxes).
2. Start **P0-1 (Meta business verification)** and **P0-6 (first 4 templates)** today. They are external waits.
3. Engineering starts E0-1 → E0-6 (monorepo scaffold, docker-compose, CI, staging, webhook smoke test).

---

## 11. Build status (18 Nov 2026)

**Built and tested** (98 automated tests; the reconciliation harness passes on a live local stack: 50/50 enquiries, 0 duplicates, 0 unowned, ingest p95 7ms):

- Phase 0: monorepo, env validation, migrations, seed, CI workflow, Dockerfile, compose, Caddy, backup script.
- Phase 1: WhatsApp, Postmark, Gmail-push and form ingestion; idempotent raw event store with sweeper; normalisation; deterministic identity resolution with per-identity locks; the lead decision rule; routing; notifications; CSV import; reconciliation harness.
- Phase 2: unified inbox; thread and composer with window states, templates, snippets and attachments; delivery/read statuses; email threading (reply-address tag, then headers, then subject heuristic); Gmail send; coexistence echoes; notes with @mentions; presence; search.
- Phase 3: stage rules and qualification gate; pipeline board; routing rules engine; business-hours SLA with 50/100/200% escalation; cadence engine (window-aware substitution, quiet hours, one channel per day, every outcome logged); consent ledger; STOP/unsubscribe; My day; duplicate merge.
- Phase 4: four dashboards on materialised views; scoring with a visible breakdown; Doott enrichment adapter; portal parser registry with fixtures and admin queue; consent-gated broadcasts with cost preview and typed confirmation.
- Phase 5 (partial): audit log, DPDP rights queue with anonymise-in-place erasure and data export, retention purge, rate limits, dead-letter replay.

**Not yet done / needs real accounts:**

- Not yet run against real Meta, Postmark, SES or Gmail accounts. Everything is built to their documented contracts and tested with recorded-shape payloads and the fake provider.
- The Doott enrichment API contract is a proposal (`packages/core/src/intelligence.ts`); the endpoint must be built on the Doott side.
- The web UI has been compiled and served but not yet reviewed in a browser or on a phone.
- Not yet built: a Microsoft 365 mailbox adapter, AI draft-and-approve, the cold-storage archive at 24 months, the k6 load test and Playwright end-to-end tests.
