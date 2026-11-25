import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { CommsWebhookService, ProviderRejectedError, WEBHOOK_SECRET_REFS, commsToolDefinitions, optOutHash, twilioSignatureBase, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde 2, A-N1 (+ B-NY LOW): en senere STOP ble SLÅTT SAMMEN med en eksisterende uten å bevare kanal og kilde (`recordOptOutIn` svarte `created: false`). To konsekvenser (reviewer A og B):
 *  (a) stopp-ord, så eierens `record_opt_out`, så START på samme kanal => eierens avmelding var borte (strider mot «en eierregistrert avmelding oppheves aldri»);
 *  (b) STOP WhatsApp, STOP SMS, START WhatsApp => SMS fritt igjen (strider mot «START opphever kun SAMME kanal»; omvendt løftet en SMS-START også WhatsApp).
 * LEDER-AVGJØRELSE: én aktiv rad per (tenant, mottaker-navnerom, KANAL, KILDE); START løfter kun stopp-ord-/leverandørfeil-rader for SAMME kanal, og aldri en eierregistrert avmelding.
 */
const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const META_SECRET = "fake-meta-app-secret";
let chain: Chain;
let webhooks: CommsWebhookService;
let sid = 0;
let midn = 0;

const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const smsFrom = (from: string, text: string) => twilioReq({ MessageSid: `SM${String(++sid).padStart(32, "0")}`, From: from, To: "+4791000000", Body: text, AccountSid: "AC1234567890abcdef" });
const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waFrom = (num: string, text: string) => metaReq({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "109876543210" },
    messages: [{ from: num.replace("+", ""), id: `wamid.n1.${++midn}.${Math.random().toString(36).slice(2, 12)}`, timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: text } }]
  } }] }]
});
const sendP = (recipient: string): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet." });
const hashOf = (num: string) => optOutHash(TENANT_A, "sms", num);
const rows = async (num: string) => (await chain.db.admin.query(
  "SELECT channel, source, status FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY channel, source", [TENANT_A, hashOf(num)]
)).rows as Array<{ channel: string; source: string; status: string }>;
const blocked = async (num: string) => {
  const r = await chain.act("send", sendP(num), chain.key("n1"));
  return !r.ok && r.status === "denied" && r.denial_codes.includes("recipient_opted_out");
};

beforeAll(async () => {
  chain = await startChain("g1n1", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE });
  webhooks = new CommsWebhookService({
    store: chain.store, graph: chain.graph, config: chain.config,
    secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock: chain.now
  });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["whatsapp", "109876543210", "meta_whatsapp"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("A-N1: STOP-rader per (kanal, kilde) - en senere STOP absorberes aldri", () => {
  it("(a) stopp-ord på SMS, så eierens record_opt_out, så START på SMS: stopp-ord-raden løftes, EIERENS avmelding består", async () => {
    const n = chain.phone();
    expect((await webhooks.handle("twilio", smsFrom(n, "STOP"))).body).toMatchObject({ events: { opt_outs: 1 } });
    const rec = await chain.act("record_opt_out", { channel: "sms", recipient: n });
    expect(rec.ok && (rec.data as { created: boolean }).created, "eierens registrering skal få sin egen rad, ikke absorberes").toBe(true);
    expect((await webhooks.handle("twilio", smsFrom(n, "START"))).body).toMatchObject({ events: { opt_ins: 1 } });
    expect(await rows(n)).toEqual([{ channel: "sms", source: "inbound_stop_keyword", status: "lifted" }, { channel: "sms", source: "owner_recorded", status: "active" }]);
    expect(await chain.store.isOptedOut(TENANT_A, hashOf(n))).toBe(true);
    expect(await blocked(n)).toBe(true);
  });

  it("(a2) omvendt: eierens registrering først, så stopp-ord, så START: eierens avmelding består også", async () => {
    const n = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: n });
    await webhooks.handle("twilio", smsFrom(n, "STOP"));
    await webhooks.handle("twilio", smsFrom(n, "START"));
    expect(await rows(n)).toEqual([{ channel: "sms", source: "inbound_stop_keyword", status: "lifted" }, { channel: "sms", source: "owner_recorded", status: "active" }]);
    expect(await blocked(n)).toBe(true);
  });

  it("(b) STOP på WhatsApp, STOP på SMS, START på WhatsApp: SMS-STOP består (START gjelder kun samme kanal)", async () => {
    const n = chain.phone();
    expect((await webhooks.handle("meta", waFrom(n, "stopp"))).body).toMatchObject({ events: { opt_outs: 1 } });
    expect((await webhooks.handle("twilio", smsFrom(n, "STOP"))).body).toMatchObject({ events: { opt_outs: 1 } });
    expect((await webhooks.handle("meta", waFrom(n, "start"))).body).toMatchObject({ events: { opt_ins: 1 } });
    expect(await rows(n)).toEqual([{ channel: "sms", source: "inbound_stop_keyword", status: "active" }, { channel: "whatsapp", source: "inbound_stop_keyword", status: "lifted" }]);
    expect(await blocked(n), "SMS-STOP ble løftet av en START på WhatsApp").toBe(true);
    // START på SMS løfter resten: mottakeren er fri igjen, og sendingen når leverandøren
    expect((await webhooks.handle("twilio", smsFrom(n, "START"))).body).toMatchObject({ events: { opt_ins: 1 } });
    expect(await chain.store.isOptedOut(TENANT_A, hashOf(n))).toBe(false);
    chain.twilio.calls.length = 0;
    expect((await chain.act("send", sendP(n), chain.key("n1free"))).ok).toBe(true);
    expect(chain.twilio.calls.filter((c) => c.op === "send")).toHaveLength(1);
  });

  it("(c) omvendt rekkefølge: STOP på SMS, STOP på WhatsApp, START på SMS: WhatsApp-STOP består (en SMS-START åpner ikke WhatsApp)", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsFrom(n, "STOP"));
    await webhooks.handle("meta", waFrom(n, "stopp"));
    await webhooks.handle("twilio", smsFrom(n, "START"));
    expect(await rows(n)).toEqual([{ channel: "sms", source: "inbound_stop_keyword", status: "lifted" }, { channel: "whatsapp", source: "inbound_stop_keyword", status: "active" }]);
    expect(await chain.store.isOptedOut(TENANT_A, hashOf(n))).toBe(true);
    // WhatsApp-START løfter den siste
    await webhooks.handle("meta", waFrom(n, "start"));
    expect(await chain.store.isOptedOut(TENANT_A, hashOf(n))).toBe(false);
  });

  it("(d) leverandørens STOP (Twilio 21610), så eierens registrering, så START: eierens avmelding består", async () => {
    const n = chain.phone();
    const saved = chain.twilio.send;
    chain.twilio.send = async () => { throw new ProviderRejectedError("twilio", "21610"); };
    try {
      await chain.act("send", sendP(n), chain.key("n1pe"));
    } finally {
      chain.twilio.send = saved;
    }
    expect(await chain.store.isOptedOut(TENANT_A, hashOf(n))).toBe(true);
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: n })).ok).toBe(true);
    await webhooks.handle("twilio", smsFrom(n, "START"));
    expect(await rows(n)).toEqual([{ channel: "sms", source: "owner_recorded", status: "active" }, { channel: "sms", source: "provider_error", status: "lifted" }]);
    expect(await blocked(n)).toBe(true);
  });

  it("samme STOP en gang til (samme kanal og kilde) gir fortsatt ÉN rad, også med samtidige leveranser; en gjentatt eierregistrering er idempotent", async () => {
    const n = chain.phone();
    await Promise.all([webhooks.handle("twilio", smsFrom(n, "STOP")), webhooks.handle("twilio", smsFrom(n, "stop")), webhooks.handle("twilio", smsFrom(n, "Stop"))]);
    expect(await rows(n)).toEqual([{ channel: "sms", source: "inbound_stop_keyword", status: "active" }]);
    const first = await chain.act("record_opt_out", { channel: "sms", recipient: n });
    const again = await chain.act("record_opt_out", { channel: "sms", recipient: n });
    expect(first.ok && (first.data as { created: boolean }).created).toBe(true);
    expect(again.ok && (again.data as { created: boolean }).created).toBe(false);
    expect(await rows(n)).toHaveLength(2);
  });

  it("listen over avmeldinger viser hver rad med kilde og kanal (account_ref er alltid `*`: kolonnen er et internt kilde-spor)", async () => {
    const n = chain.phone();
    await webhooks.handle("twilio", smsFrom(n, "STOP"));
    await chain.act("record_opt_out", { channel: "sms", recipient: n });
    const all = await chain.store.listOptOuts(TENANT_A, "business", 500);
    expect(new Set(all.map((r) => r.account_ref))).toEqual(new Set(["*"]));
    expect(new Set(all.filter((r) => r.status === "active").map((r) => r.source))).toEqual(new Set(["inbound_stop_keyword", "owner_recorded"]));
  });
});

describe("A-N5: verktøyteksten for record_opt_out stemmer med koden", () => {
  it("beskriver en EIERREGISTRERT avmelding som aldri løftes av en START (kun av eierens angre, comms.lift_owner_opt_out, WP-G1c K5) - ikke «kun mottakerens START»; rollback-teksten sier det samme", () => {
    const def = commsToolDefinitions({ transport: {} as never, store: {} as never }).find((d) => d.action === "record_opt_out")!;
    expect(def.description).toContain("EIERREGISTRERT");
    expect(def.description).toContain("ALDRI");
    expect(def.description).not.toContain("kun mottakerens egen START på kanalen");
    // WP-G1c K5: angre-veien finnes nå (og teksten sier det), men kun for en eierregistrert rad - aldri for mottakerens egne avmeldinger.
    expect(def.description).toContain("comms.lift_owner_opt_out");
    expect(def.description).toContain("recipient_request");
    expect(def.rollback_procedure).toContain("oppheves ikke av noen START");
    expect(def.rollback_procedure).toContain("comms.lift_owner_opt_out");
    expect(def.rollback_procedure).not.toContain("verken oppheves av eieren eller av en START");
    expect(def.rollback_procedure).not.toContain("oppheves kun av mottakerens egen START");
    expect(def.reversible).toBe(false);
  });
});
