import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsWebhookService, MAX_EVENTS_PER_REQUEST, WEBHOOK_SECRET_REFS, optOutHash, parseMetaBody, parseSlackBody, parseTelnyxBody, parseTwilioParams, twilioSignatureBase, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K3 (JARVIS-112 d): ingen STOP/avmelding kan droppes stille.
 *  - Taket på 100 hendelser per signert Meta-forespørsel droppet stille (`received: 100, ignored: 50, opt_outs: 0`, HTTP 200 - leverandøren prøver ikke på nytt): en WhatsApp-STOP som nr. 120 gikk tapt. Nå: taket er Metas dokumenterte batch-størrelse
 *    (1000, UVERIFISERT mot primærkilde), STOP-/START-ord behandles FØRST, og over taket svarer tjenesten en FEILSTATUS (503) - aldri 200 med droppede hendelser. Logg: kun årsakskode og antall.
 *  - En meldings-id over 1000 tegn, en Twilio-SID over 64 og en Slack `event_id` over 100 ble forkastet. Nå gir enhver id en dedupe-nøkkel via SHA-256 av HELE id-en (aldri forkastet, aldri avkortet).
 */
const BASE = "https://hooks.example.com";
const TWILIO_TOKEN = "fake-twilio-auth-token";
const META_SECRET = "fake-meta-app-secret";
const PHONE_ID = "109876543210";
let chain: Chain;
let webhooks: CommsWebhookService;
let mid = 0;
const warnings: Array<Record<string, unknown>> = [];

const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waMessage = (from: string, text: string, id = `wamid.cap.${++mid}.${Math.random().toString(36).slice(2, 10)}`) => ({ from, id, timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: text } });
const waBatch = (messages: object[], phoneNumberId = PHONE_ID): object => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: phoneNumberId }, messages } }] }]
});
const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
const waNum = (): string => chain.phone().replace("+", "");
const hashWa = (digits: string) => optOutHash(TENANT_A, "whatsapp", `+${digits}`);
const optedWa = (digits: string): Promise<boolean> => chain.store.isOptedOut(TENANT_A, hashWa(digits));
const service = (extra: { maxEventsPerRequest?: number } = {}) => new CommsWebhookService({
  store: chain.store, graph: chain.graph, config: chain.config, clock: chain.now, warn: (w) => warnings.push(w), ...extra,
  secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }
});

beforeAll(async () => {
  chain = await startChain("g1c3", { JARVIS_COMMS_WEBHOOKS: "twilio,meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE });
  webhooks = service();
  await authorizeAll(chain, [["whatsapp", PHONE_ID, "meta_whatsapp"], ["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("K3: parserne forkaster ingen hendelse på antall (taket håndheves av tjenesten)", () => {
  it("100, 101, 120, taket (1000) og over taket (1001): ALLE hendelsene kommer ut av parseren, ingen `ignored`", () => {
    expect(MAX_EVENTS_PER_REQUEST).toBe(1000);
    for (const n of [100, 101, 120, MAX_EVENTS_PER_REQUEST, MAX_EVENTS_PER_REQUEST + 1]) {
      const outcome = parseMetaBody(waBatch(Array.from({ length: n }, (_, i) => waMessage("4790000001", i === n - 1 ? "STOPP" : "hei", `wamid.p.${n}.${i}`))));
      expect(outcome.events, `n=${n}`).toHaveLength(n);
      expect(outcome.ignored, `n=${n}`).toBe(0);
      expect(outcome.events[n - 1]!.text, `n=${n}`).toBe("STOPP");
    }
  });

  it("lange id-er: meldings-id over 1000 tegn, Twilio-SID over 64, Slack event_id over 100 og Telnyx-id over 1000 forkastes ikke - de gir en SHA-256-nøkkel av HELE id-en (aldri avkortet)", () => {
    const hashKey = /^[a-z:]+:sha256:[0-9a-f]{64}$/;
    const longWa = parseMetaBody(waBatch([waMessage("4790000001", "STOPP", `wamid.${"A".repeat(5000)}`), waMessage("4790000001", "STOPP", `wamid.${"A".repeat(4999)}B`)]));
    expect(longWa.ignored).toBe(0);
    const [k1, k2] = longWa.events.map((e) => e.event_key);
    expect(k1).toMatch(hashKey);
    expect(k2).toMatch(hashKey);
    expect(k1, "to id-er som kun skiller seg i siste tegn gir ULIK nøkkel (aldri avkortet)").not.toBe(k2);
    expect(parseMetaBody(waBatch([waMessage("4790000001", "STOPP", `wamid.${"A".repeat(5000)}`)])).events[0]!.event_key, "stabil nøkkel").toBe(k1);
    const twParse = (messageSid: string) => parseTwilioParams(new Map([["MessageSid", [messageSid]], ["From", ["+4790000001"]], ["To", ["+4791000000"]], ["Body", ["STOP"]]]));
    // 200 tegn (over den gamle grensen på 64): beholdes UENDRET i nøkkelen så lenge nøkkelen er trygg og <= 300 tegn (aldri avkortet); 400 tegn: SHA-256 av hele id-en
    const mid200 = twParse(`SM${"0".repeat(200)}`);
    expect(mid200.ignored).toBe(0);
    expect(mid200.events[0]!.event_key).toBe(`twilio:msg:SM${"0".repeat(200)}`);
    const tw = twParse(`SM${"0".repeat(400)}`);
    expect(tw.ignored).toBe(0);
    expect(tw.events[0]!.event_key).toMatch(hashKey);
    expect(twParse(`SM${"0".repeat(399)}1`).events[0]!.event_key, "ikke avkortet: id-er som skiller seg i siste tegn gir ulik nøkkel").not.toBe(tw.events[0]!.event_key);
    const slack = parseSlackBody({ type: "event_callback", event_id: `Ev${"X".repeat(400)}`, team_id: "T0123ABCD", event: { type: "message", user: "U0123ABCD", channel: "D0123ABCD", ts: "1763380800.000100", text: "stop" } });
    expect((slack as unknown as { events: unknown[] }).events).toHaveLength(1);
    const telnyx = parseTelnyxBody({ data: { event_type: "message.received", id: "e".repeat(3000), occurred_at: "2026-11-17T11:00:00Z", payload: { direction: "inbound", text: "STOP", from: { phone_number: "+4790000001" }, to: [{ phone_number: "+4791000000" }] } } });
    expect(telnyx.ignored).toBe(0);
    expect(telnyx.events[0]!.event_key).toMatch(hashKey);
  });
});

describe("K3: en STOP som nr. 120 i ÉN signert Meta-forespørsel registreres (var: `received: 100, ignored: 50, opt_outs: 0`)", () => {
  for (const n of [100, 101, 120]) {
    it(`batch på ${n} hendelser med STOP som nr. ${n}: HTTP 200, STOP registrert, ingen droppet`, async () => {
      const stopper = waNum();
      const others = Array.from({ length: n - 1 }, (_, i) => waMessage(waNum(), "hei", `wamid.b${n}.${i}.${Math.random().toString(36).slice(2, 8)}`));
      const res = await webhooks.handle("meta", metaReq(waBatch([...others, waMessage(stopper, "STOPP")])));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true, events: { received: n, opt_outs: 1, ignored: 0 } });
      expect(await optedWa(stopper)).toBe(true);
    }, 120_000);
  }
});

describe("K3: stopp-/start-ord behandles FØRST, og over taket svarer tjenesten en FEILSTATUS (aldri 200 med droppede hendelser)", () => {
  it("taket lavt (50): batch på 120 med STOP som siste hendelse -> STOP behandles (først), svaret er 503 `batch_over_cap` med antall, og loggen har kun årsakskode og tall", async () => {
    const svc = service({ maxEventsPerRequest: 50 });
    const stopper = waNum();
    const others = Array.from({ length: 119 }, () => waMessage(waNum(), "hei"));
    warnings.length = 0;
    const res = await svc.handle("meta", metaReq(waBatch([...others, waMessage(stopper, "STOPP")])));
    expect(res.status, "aldri 200 med droppede hendelser").toBe(503);
    expect(res.body).toMatchObject({ error: "batch_over_cap", events: { received: 50, deferred: 70, opt_outs: 1 } });
    expect(await optedWa(stopper), "STOP-en ble behandlet FØRST og er registrert").toBe(true);
    const log = warnings.find((w) => w["msg"] === "comms_webhook_batch_over_cap");
    expect(log).toEqual({ msg: "comms_webhook_batch_over_cap", provider: "meta", events: 120, cap: 50, deferred: 70 });
    expect(JSON.stringify(warnings)).not.toContain("hei"); // ingen innhold i loggen
    expect(JSON.stringify(warnings)).not.toContain(stopper);
  });

  it("akkurat PÅ taket gir 200; ett over gir 503 (grensen er presis)", async () => {
    const svc = service({ maxEventsPerRequest: 30 });
    const at = await svc.handle("meta", metaReq(waBatch(Array.from({ length: 30 }, () => waMessage(waNum(), "hei")))));
    expect(at.status).toBe(200);
    const over = await svc.handle("meta", metaReq(waBatch(Array.from({ length: 31 }, () => waMessage(waNum(), "hei")))));
    expect(over.status).toBe(503);
    expect(over.body).toMatchObject({ events: { received: 30, deferred: 1 } });
  });

  it("det ekte taket (1000): 1001 hendelser der STOP står SIST -> STOP registreres (prioritert først), svaret er 503 og nøyaktig én hendelse er utsatt", async () => {
    const stopper = waNum();
    // til en ikke-autorisert konto: hendelsene ignoreres raskt (kun STOP lagres), så testen måler taket - ikke databasen
    const noise = Array.from({ length: 1000 }, (_, i) => waMessage("4790000001", "hei", `wamid.real.${i}`));
    const res = await webhooks.handle("meta", metaReq(waBatch([...noise, waMessage(stopper, "STOPP")], "999999999999")));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "batch_over_cap", events: { received: 1000, deferred: 1, opt_outs: 1 } });
    expect(await optedWa(stopper)).toBe(true);
  }, 120_000);

  it("rekkefølgen mellom STOP og START i samme batch bevares (de prioriteres som ÉN gruppe): STOP, så START -> fri; START, så STOP -> avmeldt - også med mange vanlige meldinger imellom", async () => {
    const a = waNum();
    const b = waNum();
    const filler = () => Array.from({ length: 5 }, () => waMessage(waNum(), "hei"));
    const res = await webhooks.handle("meta", metaReq(waBatch([waMessage(a, "STOPP"), ...filler(), waMessage(a, "START"), waMessage(b, "START"), ...filler(), waMessage(b, "STOPP")])));
    expect(res.status).toBe(200);
    expect(await optedWa(a), "STOP, så START: fri").toBe(false);
    expect(await optedWa(b), "START, så STOP: avmeldt").toBe(true);
  });
});

describe("K3: lange id-er ende til ende (STOP registreres og dedupe virker)", () => {
  it("WhatsApp-STOP med meldings-id på 1001, 5000 og 100 000 tegn registreres; samme levering en gang til er en duplikat uten ny rad", async () => {
    for (const length of [1001, 5000, 100_000]) {
      const num = waNum();
      const id = `wamid.${"Z".repeat(length)}`;
      const first = await webhooks.handle("meta", metaReq(waBatch([waMessage(num, "STOP", id)])));
      expect(first.status, `length ${length}`).toBe(200);
      expect(first.body, `length ${length}`).toMatchObject({ events: { received: 1, inserted: 1, opt_outs: 1, ignored: 0 } });
      expect(await optedWa(num)).toBe(true);
      const again = await webhooks.handle("meta", metaReq(waBatch([waMessage(num, "STOP", id)])));
      expect(again.body, `length ${length}`).toMatchObject({ events: { received: 1, inserted: 0, duplicates: 1, opt_outs: 0 } });
      const n = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hashWa(num)])).rows[0] as { n: number }).n;
      expect(n).toBe(1);
    }
  });

  it("Twilio-SID på 65 og 300 tegn: STOP registreres (var forkastet over 64); to SID-er som kun skiller seg i siste tegn er to ulike hendelser", async () => {
    const hashSms = (num: string) => optOutHash(TENANT_A, "sms", num);
    for (const length of [65, 300]) {
      const num = chain.phone();
      const res = await webhooks.handle("twilio", twilioReq({ MessageSid: `SM${"1".repeat(length)}`, From: num, To: "+4791000000", Body: "STOP", AccountSid: "AC1234567890abcdef" }));
      expect(res.body, `length ${length}`).toMatchObject({ events: { received: 1, inserted: 1, opt_outs: 1, ignored: 0 } });
      expect(await chain.store.isOptedOut(TENANT_A, hashSms(num))).toBe(true);
    }
    const x = chain.phone();
    const y = chain.phone();
    const common = `SM${"7".repeat(120)}`;
    const r1 = await webhooks.handle("twilio", twilioReq({ MessageSid: `${common}A`, From: x, To: "+4791000000", Body: "STOP", AccountSid: "AC1234567890abcdef" }));
    const r2 = await webhooks.handle("twilio", twilioReq({ MessageSid: `${common}B`, From: y, To: "+4791000000", Body: "STOP", AccountSid: "AC1234567890abcdef" }));
    expect(r1.body).toMatchObject({ events: { inserted: 1 } });
    expect(r2.body, "ikke avkortet: den andre er IKKE en duplikat av den første").toMatchObject({ events: { inserted: 1, duplicates: 0 } });
  });
});

describe("K3: en STOP forkastes aldri på alder (en forsinket levering av en ekte STOP skal ikke forsvinne stille)", () => {
  it("en STOP med leverandør-tidsstempel eldre enn dedupe-vinduet (30 d) registreres; en vanlig melding og en START med samme alder ignoreres som før", async () => {
    const old = (text: string, num: string) => waBatch([{ from: num, id: `wamid.old.${++mid}.${Math.random().toString(36).slice(2, 8)}`, timestamp: "1700000000", type: "text", text: { body: text } }]); // 2023
    const a = waNum();
    const stopRes = await webhooks.handle("meta", metaReq(old("STOPP", a)));
    expect(stopRes.body).toMatchObject({ events: { inserted: 1, opt_outs: 1, ignored: 0 } });
    expect(await optedWa(a)).toBe(true);
    const msg = await webhooks.handle("meta", metaReq(old("hei", waNum())));
    expect(msg.body).toMatchObject({ events: { inserted: 0, ignored: 1 } });
    const start = await webhooks.handle("meta", metaReq(old("START", a)));
    expect(start.body).toMatchObject({ events: { opt_ins: 0, ignored: 1 } });
    expect(await optedWa(a), "en gammel START løfter aldri en STOP").toBe(true);
  });
});

describe("K7 (reviewer B, Y13): statusvarsler på samme UVANLIGE id", () => {
  it("to statusvarsler på SAMME lange id men ulik status får hver sin dedupe-nøkkel (hashen dekker hele id-en OG statusen), mens samme id og samme status gir samme nøkkel - ingen kollisjon som kan skjule et varsel", () => {
    const long = `wamid.${"x".repeat(400)}`;
    const body = { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_ID },
      statuses: [{ id: long, status: "sent", timestamp: "1731850000", recipient_id: "4791000001" }, { id: long, status: "delivered", timestamp: "1731850001", recipient_id: "4791000001" }, { id: long, status: "sent", timestamp: "1731850002", recipient_id: "4791000001" }]
    } }] }] };
    const out = parseMetaBody(body);
    const keys = "events" in out ? out.events.map((e) => e.event_key) : [];
    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
    for (const k of keys) expect(k).toMatch(/^wa:status:sha256:[0-9a-f]{64}$/);
  });
});
