/**
 * Send realistic inbound traffic to the local ingest service — exactly what Meta / Postmark /
 * the website would send, signed the same way.
 *
 *   pnpm simulate wa +919876543210 "Hi, need HR contacts in Pune" "Rahul Kumar"
 *   pnpm simulate echo +919876543210 "Replying from the phone app"
 *   pnpm simulate status <wamid> delivered|read|failed
 *   pnpm simulate email rahul@acme.co.in "Need data" "We need 5,000 HR heads in Pune"
 *   pnpm simulate indiamart
 *   pnpm simulate form anita@bigco.com "Anita Rao" "Please send pricing" [--consent]
 */
import { randomUUID } from "node:crypto";
import { env } from "@lead/config";
import { hmacHex } from "@lead/domain";

const BASE = process.env.INGEST_URL ?? `http://localhost:${env.INGEST_PORT}`;
const [cmd, ...args] = process.argv.slice(2);

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(path.startsWith("/webhooks/whatsapp") && env.WA_APP_SECRET ? { "x-hub-signature-256": "sha256=" + hmacHex(env.WA_APP_SECRET, raw) } : {}),
      ...headers,
    },
    body: raw,
  });
  console.log(`${res.status} ${path}`, (await res.text()).slice(0, 200));
}

const waId = (phone: string) => phone.replace(/\D/g, "").replace(/^0/, "91").replace(/^(\d{10})$/, "91$1");
const ts = () => String(Math.floor(Date.now() / 1000));
const wa = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: env.WA_WABA_ID || "WABA_DEV", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "919000000000", phone_number_id: env.WA_PHONE_NUMBER_ID || "PNID_DEV" }, ...value } }] }],
});

switch (cmd) {
  case "wa": {
    const [phone = "+919876543210", text = "Hi, I need verified HR contacts in Pune. What's the price?", name = "Rahul Kumar"] = args;
    const id = `wamid.sim.${randomUUID()}`;
    await postJson("/webhooks/whatsapp", wa("messages", { contacts: [{ profile: { name }, wa_id: waId(phone) }], messages: [{ from: waId(phone), id, timestamp: ts(), type: "text", text: { body: text } }] }));
    console.log("message id:", id);
    break;
  }
  case "echo": {
    const [phone = "+919876543210", text = "Sent from the phone app"] = args;
    await postJson("/webhooks/whatsapp", wa("smb_message_echoes", { message_echoes: [{ from: "919000000000", to: waId(phone), id: `wamid.echo.${randomUUID()}`, timestamp: ts(), type: "text", text: { body: text } }] }));
    break;
  }
  case "status": {
    const [id, status = "delivered"] = args;
    if (!id) throw new Error("usage: status <wamid> <delivered|read|failed>");
    await postJson("/webhooks/whatsapp", wa("messages", { statuses: [{ id, status, timestamp: ts(), recipient_id: "919876543210", pricing: { billable: true, category: "service" }, ...(status === "failed" ? { errors: [{ code: 131047, title: "Re-engagement message" }] } : {}) }] }));
    break;
  }
  case "email": {
    const [from = "rahul@acme.co.in", subject = "Need HR contacts", text = "Hi, we need 5,000 HR head contacts in Pune. Pricing?"] = args;
    const auth = "Basic " + Buffer.from(`${env.POSTMARK_INBOUND_USER}:${env.POSTMARK_INBOUND_PASSWORD}`).toString("base64");
    await postJson(
      "/webhooks/email/postmark",
      {
        MessageID: randomUUID(),
        From: from,
        FromFull: { Email: from, Name: from.split("@")[0] },
        To: "sales@doott.com",
        ToFull: [{ Email: "sales@doott.com" }],
        Subject: subject,
        TextBody: text,
        Date: new Date().toUTCString(),
        Headers: [{ Name: "Message-ID", Value: `<${randomUUID()}@${from.split("@")[1]}>` }],
      },
      { authorization: auth },
    );
    break;
  }
  case "indiamart": {
    const auth = "Basic " + Buffer.from(`${env.POSTMARK_INBOUND_USER}:${env.POSTMARK_INBOUND_PASSWORD}`).toString("base64");
    const n = Math.floor(Math.random() * 900000 + 100000);
    await postJson(
      "/webhooks/email/postmark",
      {
        MessageID: randomUUID(),
        From: "buyleads@indiamart.com",
        To: "sales@doott.com",
        Subject: "Enquiry for B2B Contact Database from Suresh Mehta",
        TextBody: `Buyer's Enquiry\nEnquiry ID: IM-${n}\nName: Suresh Mehta\nMobile: +91-98200 ${String(n).slice(0, 5)}\nEmail: suresh${n}@mehtatraders.in\nCompany: Mehta Traders\nCity: Ahmedabad, Gujarat\nProduct: B2B contact database\nQuantity: 10000 records\nMessage: Need distributor contacts in Gujarat`,
        Headers: [{ Name: "Message-ID", Value: `<${randomUUID()}@indiamart.com>` }],
      },
      { authorization: auth },
    );
    break;
  }
  case "form": {
    const [email = "anita@bigco.com", name = "Anita Rao", message = "Please share pricing for 10k contacts"] = args;
    await postJson("/intake/form", { email, name, message, consent_marketing: args.includes("--consent"), notice_version: "2026-11-v1", page_url: "https://doott.com/contact" }, { "x-form-secret": env.FORM_INTAKE_SECRET });
    break;
  }
  default:
    console.log("commands: wa | echo | status | email | indiamart | form");
}
