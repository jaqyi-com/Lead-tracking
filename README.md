# Doott Lead Operating System

Every inbound WhatsApp message and email becomes a lead with an owner, a stage and a timer. Reps reply from one inbox, every message, note and stage change lands on one append-only timeline, and managers see response times, the pipeline and conversion by source.

Spec: *Doott Lead Operating System — Build Spec & Workflow* (18 Nov 2026). Plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Operations: [`docs/runbook.md`](docs/runbook.md).

## Architecture

```
WhatsApp Cloud API ─┐                    ┌──────────── worker (BullMQ) ───────────────┐
Postmark Inbound ───┼─► apps/ingest ─► webhook_events ─► normalise → identity → lead → route → SLA → ack
Gmail Pub/Sub ──────┤   verify, store,   (Postgres)    outbound sends · media · cadence · scoring
Website form ───────┘   enqueue, 200     ▲             sweepers: webhooks, SLA, cadence, windows
                                         │
apps/web (Next.js) ◄──► apps/api (Fastify REST + Socket.IO) ◄── Redis pub/sub ◄── core events
```

| Path | What it does |
|---|---|
| `apps/ingest` | Webhook endpoints. Verifies the signature, stores the raw event, enqueues it and replies 200 (p95 under 10ms locally). Deployed separately so API deploys never drop webhooks. |
| `apps/worker` | Queue processors plus sweepers. Postgres, not Redis, is the durability layer. |
| `apps/api` | Auth (password + TOTP, Google SSO), inbox, leads, pipeline, reports, admin, realtime. |
| `apps/web` | Agent workspace: inbox, lead page, pipeline, My day, reports, admin, settings. |
| `packages/domain` | Pure rules with no I/O: phone/email normalisation, the 24h window, business-hours maths, SLA, stages, scoring, routing, cadence decisions, portal parsers. |
| `packages/core` | Database-backed services shared by api and worker. Every state change writes its timeline activity in the same transaction. |
| `packages/db` | Drizzle schema, SQL migrations (including materialised report views) and seed data. |

## Run locally

Needs Node 22+, pnpm, Postgres 16 binaries and Redis. Docker is not needed.

```bash
pnpm install
cp .env.example .env                    # MESSAGING_PROVIDER=fake: no Meta account needed
pnpm devdb:start                        # throwaway Postgres on :5434 in .devdata/
pnpm db:migrate
SEED_DEMO=1 pnpm db:seed                # demo users below; templates approved (fake provider only)
pnpm dev                                # ingest :4100 · api :4000 · worker · web :3000
```

Sign in at http://localhost:3000 with `priya@doott.local` / `rep12345` (rep), `manager@doott.local` / `manager12345` or `admin@doott.local` / `admin12345`.

Send it traffic exactly as Meta, Postmark and the website would:

```bash
pnpm simulate wa +919876543210 "Need HR contacts in Pune, price?" "Rahul Kumar"
pnpm simulate email rahul@acme.co.in "Data for Pune" "Can you share a sample?"
pnpm simulate indiamart
pnpm simulate form anita@bigco.com "Anita Rao" "Pricing please" --consent
pnpm simulate echo +919876543210 "Replying from the phone app"   # coexistence echo
pnpm reconcile                          # Phase 1 gate: 50 enquiries → 50 owned leads, zero loss
```

## Tests

```bash
pnpm test        # 98 tests: domain rules, portal fixtures, full ingestion flows on in-memory Postgres, HTTP
pnpm typecheck
```

The integration tests run against PGlite, a real Postgres compiled to WASM, so they need no database server.

## Going live

See the checklist in [`docs/runbook.md`](docs/runbook.md#go-live-checklist). In short: Meta verification, the Coexistence number, templates submitted, DNS for `inbox.` and `mail.`, an Internal Google OAuth app, `MESSAGING_PROVIDER=cloud`, and a backup restore drill.
