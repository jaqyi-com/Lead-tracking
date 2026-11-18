/**
 * Phase 1 done-criterion (§13): send 50 mixed enquiries through the REAL ingest endpoint and
 * reconcile to zero loss — every enquiry produces a lead with a named owner within 60 seconds.
 *
 *   pnpm reconcile                 # against local ingest + DATABASE_URL
 *   INGEST_URL=https://staging… pnpm reconcile
 *
 * Exit code 1 on any loss, duplicate or unowned lead.
 */
import { randomUUID } from "node:crypto";
import { env } from "@lead/config";
import { getDb, closeDb, sql } from "@lead/db";
import { hmacHex } from "@lead/domain";

const BASE = process.env.INGEST_URL ?? `http://localhost:${env.INGEST_PORT}`;
const N = Number(process.env.N ?? 50);
const run = randomUUID().slice(0, 8);
const auth = "Basic " + Buffer.from(`${env.POSTMARK_INBOUND_USER}:${env.POSTMARK_INBOUND_PASSWORD}`).toString("base64");

async function send(path: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const sig = path.includes("whatsapp") && env.WA_APP_SECRET ? { "x-hub-signature-256": "sha256=" + hmacHex(env.WA_APP_SECRET, raw) } : {};
  const t = Date.now();
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...sig, ...headers }, body: raw });
  return { ok: res.ok, ms: Date.now() - t };
}

const markers: string[] = [];
const latencies: number[] = [];
const started = new Date();

for (let i = 0; i < N; i++) {
  const marker = `rc-${run}-${String(i).padStart(3, "0")}`;
  markers.push(marker);
  const kind = i % 5;
  let r;
  if (kind === 0 || kind === 1) {
    const from = `9195${run.replace(/\D/g, "").padEnd(4, "0").slice(0, 4)}${String(i).padStart(4, "0")}`;
    const msg = { from, id: `wamid.${marker}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: `enquiry ${marker}` } };
    const payload = { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, contacts: [{ wa_id: from, profile: { name: `WA ${i}` } }], messages: [msg] } }] }] };
    r = await send("/webhooks/whatsapp", payload);
    if (kind === 1) await send("/webhooks/whatsapp", payload); // duplicate delivery — must not double count
  } else if (kind === 2) {
    r = await send("/webhooks/email/postmark", { MessageID: randomUUID(), From: `buyer.${marker}@company${i}.com`, To: "sales@doott.com", Subject: `Enquiry ${marker}`, TextBody: `enquiry ${marker}`, Headers: [{ Name: "Message-ID", Value: `<${marker}@company${i}.com>` }] }, { authorization: auth });
  } else if (kind === 3) {
    r = await send("/intake/form", { submission_id: marker, email: `form.${marker}@corp${i}.in`, name: `Form ${i}`, message: `enquiry ${marker}` }, { "x-form-secret": env.FORM_INTAKE_SECRET });
  } else {
    r = await send("/webhooks/email/postmark", {
      MessageID: randomUUID(),
      From: "buyleads@indiamart.com",
      To: "sales@doott.com",
      Subject: `Enquiry for data from Buyer ${i}`,
      TextBody: `Enquiry ID: ${marker}\nName: Buyer ${i}\nMobile: +91 98${String(10000000 + i).slice(0, 8)}\nEmail: im.${marker}@trade${i}.in\nMessage: enquiry ${marker}`,
      Headers: [{ Name: "Message-ID", Value: `<im-${marker}@indiamart.com>` }],
    }, { authorization: auth });
  }
  if (!r.ok) console.error(`✗ ${marker} rejected by ingest`);
  latencies.push(r.ms);
}

latencies.sort((a, b) => a - b);
console.log(`sent ${N} enquiries · ingest p50 ${latencies[Math.floor(N * 0.5)]}ms · p95 ${latencies[Math.floor(N * 0.95)]}ms`);

const db = getDb();
const deadline = Date.now() + 60_000;
let found: { marker: string; leads: number; owned: number }[] = [];
while (Date.now() < deadline) {
  const r = await db.execute(sql`
    select m.marker, count(distinct msg.lead_id)::int as leads, count(distinct l.id) filter (where l.owner_id is not null)::int as owned
    from unnest(${`{${markers.join(",")}}`}::text[]) as m(marker)
    left join los_messages msg on msg.direction = 'inbound' and (msg.body like '%' || m.marker || '%' or msg.subject like '%' || m.marker || '%')
    left join los_leads l on l.id = msg.lead_id
    group by m.marker`);
  found = r.rows as typeof found;
  if (found.every((f) => f.leads === 1 && f.owned === 1)) break;
  await new Promise((res) => setTimeout(res, 2000));
}
const missing = found.filter((f) => f.leads === 0);
const dupes = found.filter((f) => f.leads > 1);
const unowned = found.filter((f) => f.leads === 1 && f.owned === 0);
const secs = ((Date.now() - started.getTime()) / 1000).toFixed(1);
console.log(`leads found: ${found.filter((f) => f.leads >= 1).length}/${N} · missing ${missing.length} · duplicated ${dupes.length} · unowned ${unowned.length} · ${secs}s`);
if (missing.length) console.log("missing:", missing.map((m) => m.marker).join(", "));
if (unowned.length) console.log("unowned (is any rep available and in working hours?):", unowned.map((m) => m.marker).join(", "));
await closeDb();
process.exit(missing.length || dupes.length || unowned.length ? 1 : 0);
