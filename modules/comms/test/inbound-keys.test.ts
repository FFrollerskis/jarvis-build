import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsWebhookService, WEBHOOK_SECRET_REFS, optOutHash, parseMetaBody, parseTelnyxBody, parseTwilioParams, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde 2, B-NY LOW (delta-review B): en WhatsApp-STOP med meldings-id over 200 tegn - eller med tegn utenfor vårt trygge sett (`~ % * $`, mellomrom) - ble DROPPET stille av parseren (`ignored=1`, ingen rad), så mottakerens
 * avmelding forsvant. Urealistisk med ekte Meta-id-er, men STOP er rettighetsbærende. Nå gir en uvanlig id en stabil hash-nøkkel (`<prefiks>:sha256:<hex>`) i stedet for en forkastet hendelse.
 */
const META_SECRET = "fake-meta-app-secret";
const waBody = (id: string, text: string, from = "4790000001") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "109876543210" },
    messages: [{ from, id, timestamp: "1763380800", type: "text", text: { body: text } }]
  } }] }]
});
const SAFE = /^[A-Za-z0-9._:@=+/-]{1,300}$/;

describe("parserne: en hendelse forkastes aldri på grunn av id-en (ren tolkning)", () => {
  it("vanlige id-er gir UENDRET nøkkel; uvanlige (lange, `~ % * $`, mellomrom) gir en stabil hash-nøkkel i trygt tegnsett - og samme id gir alltid samme nøkkel", () => {
    const usual = "wamid.HBgLNDc5MDAwMDAwMRUCABIYFjNFQjAxMjM0NTY3ODlBQkNERUY=";
    const ok = parseMetaBody(waBody(usual, "Hei"));
    expect(ok.events.map((e) => e.event_key)).toEqual([`wa:msg:${usual}`]);
    // en lang id (250 tegn, trygt tegnsett, nøkkelen <= 300) ble tidligere forkastet (over 200); den beholdes nå UENDRET som nøkkel
    const long = `wamid.${"B".repeat(250)}`;
    const longKey = parseMetaBody(waBody(long, "STOPP"));
    expect(longKey.ignored).toBe(0);
    expect(longKey.events.map((e) => e.event_key)).toEqual([`wa:msg:${long}`]);
    const odd = ["wamid.a~b%c*d", "wamid.med mellomrom", `wamid.${"x".repeat(900)}`, "mid.$cAAAB", `wamid.${"B".repeat(300)}`];
    const keys = odd.map((id) => {
      const r = parseMetaBody(waBody(id, "STOPP"));
      expect(r.ignored, id.slice(0, 20)).toBe(0);
      expect(r.events, id.slice(0, 20)).toHaveLength(1);
      return r.events[0]!.event_key;
    });
    for (const k of keys) {
      expect(k).toMatch(/^wa:msg:sha256:[0-9a-f]{64}$/);
      expect(SAFE.test(k)).toBe(true);
    }
    expect(new Set(keys).size).toBe(odd.length);
    expect(parseMetaBody(waBody(odd[0]!, "STOPP")).events[0]!.event_key).toBe(keys[0]); // stabil: dedupe virker
    // en id over grensen vi leser (1000) er fortsatt avvist (ikke en gyldig leverandør-id)
    expect(parseMetaBody(waBody("y".repeat(1001), "STOPP")).ignored).toBe(1);
  });

  it("samme regel for statusvarsel, Messenger/Instagram (`mid.$…`), Twilio og Telnyx", () => {
    const status = parseMetaBody({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ value: { metadata: { phone_number_id: "109876543210" }, statuses: [{ id: "wamid.a~b", status: "read", recipient_id: "4790000001", timestamp: "1763380800" }] } }] }] });
    expect(status.events[0]!.event_key).toMatch(/^wa:status:sha256:[0-9a-f]{64}$/);
    const msgr = parseMetaBody({ object: "page", entry: [{ id: "123456", messaging: [{ sender: { id: "1234567" }, recipient: { id: "123456" }, timestamp: 1763380800000, message: { mid: "mid.$cAAAB-Xyz", text: "Hei" } }] }] });
    expect(msgr.ignored).toBe(0);
    expect(msgr.events[0]!.event_key).toMatch(/^msgr:sha256:[0-9a-f]{64}$/);
    const tw = parseTwilioParams(new Map([["MessageSid", ["SM12*34"]], ["From", ["+4790000001"]], ["To", ["+4791000000"]], ["Body", ["STOP"]]]));
    expect(tw.events[0]!.event_key).toMatch(/^twilio:msg:sha256:[0-9a-f]{64}$/);
    const tn = parseTelnyxBody({ data: { event_type: "message.received", id: "ev~1", occurred_at: "2026-11-17T11:00:00Z", payload: { direction: "inbound", text: "STOP", from: { phone_number: "+4790000001" }, to: [{ phone_number: "+4791000000" }] } } });
    expect(tn.events[0]!.event_key).toMatch(/^telnyx:sha256:[0-9a-f]{64}$/);
  });
});

describe("ende-til-ende: en WhatsApp-STOP med uvanlig id registrerer avmeldingen (og dedupes)", () => {
  let chain: Chain;
  let webhooks: CommsWebhookService;
  beforeAll(async () => {
    chain = await startChain("g1ik", { JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A });
    webhooks = new CommsWebhookService({
      store: chain.store, graph: chain.graph, config: chain.config,
      secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock: chain.now
    });
    await authorizeAll(chain, [["whatsapp", "109876543210", "meta_whatsapp"]]);
  }, 240_000);
  afterAll(async () => { await chain?.stop(); }, 120_000);

  const metaReq = (body: object): WebhookRequest => {
    const raw = Buffer.from(JSON.stringify(body));
    return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
  };
  const body = (id: string, text: string, from: string) => {
    const b = waBody(id, text, from);
    (b.entry[0]!.changes[0]!.value.messages[0] as { timestamp: string }).timestamp = String(Math.floor(chain.now().getTime() / 1000));
    return b;
  };

  it("id med 250 tegn og id med `~ % *`: STOP registreres (ikke `ignored`), og samme leveranse en gang til er en duplikat uten ny rad", async () => {
    for (const [i, id] of [`wamid.${"Z".repeat(250)}`, "wamid.q~r%s*t u"].entries()) {
      const num = chain.phone();
      const from = num.replace("+", "");
      const first = await webhooks.handle("meta", metaReq(body(id, "stopp", from)));
      expect(first.body, `id ${i}`).toMatchObject({ events: { received: 1, inserted: 1, opt_outs: 1, ignored: 0 } });
      expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", num)), `id ${i}`).toBe(true);
      const again = await webhooks.handle("meta", metaReq(body(id, "stopp", from)));
      expect(again.body, `id ${i} (gjenspilling)`).toMatchObject({ events: { inserted: 0, duplicates: 1 } });
      const rows = (await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, optOutHash(TENANT_A, "whatsapp", num)])).rows[0] as { n: number };
      expect(rows.n).toBe(1);
    }
  });
});
