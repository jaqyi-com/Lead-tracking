# Runbook

## Topology

| Host | Runs | Notes |
|---|---|---|
| Box A | caddy, ingest ×2, api, web, migrate (one-shot) | `hooks.doott.com` → ingest; `leads.doott.com` → web + `/api`, `/ws`, `/files` → api |
| Box B | worker | Single leader for schedulers (Redis lock); safe to run two |
| Managed | Postgres 16 (PITR on), Redis 7, R2 bucket (private) | India region |

Deploy: CI builds `ghcr.io/<repo>:<sha>`. Then `IMAGE=…:<sha> docker compose --profile app up -d` on box A and `--profile worker` on box B. The `migrate` service runs first. To roll back, redeploy the previous sha. Migrations are additive, so rolling back the code doesn't need a down-migration.

## Go-live checklist

1. **Meta.** Business verification done. A test WABA and number for staging. Live number onboarded via **Coexistence** (Embedded Signup). Webhook URL `https://hooks.doott.com/webhooks/whatsapp`, verify token = `WA_VERIFY_TOKEN`, subscribed to `messages`, `smb_message_echoes`, `history`, `message_template_status_update`, `phone_number_quality_update` and `account_alerts`. A payment method on the WABA.
2. **Templates.** In Admin → Templates, submit `lead_ack`, `after_hours_ack`, `follow_up_1` and `follow_up_2` first, then the rest. Once approved, *Sync from Meta*.
3. **Email.** MX for `inbox.doott.com` → Postmark Inbound, webhook `https://hooks.doott.com/webhooks/email/postmark` with basic auth. Forward `sales@` and `info@` to `sales@inbox.doott.com`. SES domain `mail.doott.com` with SPF, DKIM and DMARC `p=none`; move to `quarantine` once reports are clean. Request SES production access.
4. **Gmail.** GCP project, Internal OAuth consent screen, redirect URI `https://leads.doott.com/api/auth/google/callback`. Pub/Sub topic with publisher role granted to `gmail-api-push@system.gserviceaccount.com`. Push subscription to `https://hooks.doott.com/webhooks/gmail?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>`.
5. **Form.** The website posts to `https://hooks.doott.com/intake/form` with header `x-form-secret`, including `consent_marketing` (never pre-ticked) and `notice_version`.
6. **Secrets.** A random 32-byte `APP_SECRET`, plus `WA_APP_SECRET`, `WA_ACCESS_TOKEN` (system-user token), VAPID keys and `SENTRY_DSN`. Set `MESSAGING_PROVIDER=cloud`.
7. **People.** Create users in Admin → Team. Admins enable TOTP (enforced in production). Set business hours and festival holidays.
8. **Prove it.** `INGEST_URL=https://hooks-staging… DATABASE_URL=… pnpm reconcile` exits 0 on staging. Then do a **restore drill** (`infra/deploy/backup.sh`, restore section) on staging.

## Alerts and what to do

| Alert | Meaning | Action |
|---|---|---|
| Unprocessed webhook events older than 5 min | Worker down or failing | Check worker logs. Admin → Queue health → Replay after a fix. |
| WhatsApp quality yellow/red | Recipients blocking or reporting | Pause broadcasts and marketing templates; review recent template copy. |
| Gmail watch expires in under 24h / mailbox `error` | Token revoked or watch renewal failing | The rep reconnects in Settings. Renewal runs every 6h. |
| Messages stuck `sending`, failed with `send_interrupted` | Worker died mid-send | Check WhatsApp manually before pressing Retry. The system never re-sends blindly. |
| Service messages over 80% of 1,000/month | Free allowance nearly used | Expected at volume. Confirm the payment method on the WABA. |

## Common operations

- **Replay a failed webhook after a bug fix:** Admin → Queue health → Replay. Raw payloads are kept for 30 days.
- **Rotate the Meta token:** create a new system-user token, update `WA_ACCESS_TOKEN`, restart worker and api.
- **Disconnect Coexistence:** on the phone, WhatsApp Business app → Settings → Account → Business Platform → Disconnect.
- **Erasure request (DPDP):** Admin → Data requests → log it → *Erase now*. This anonymises in place; the consent ledger and audit log are kept.
- **Portal parser broke:** the lead still exists, flagged in Admin → Parser queue. Anonymise the email, add it to `fixtures/portal/`, then fix `packages/domain/src/parsers.ts` until `pnpm test` passes.
