import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsWebhookService, WEBHOOK_SECRET_REFS, evidenceRefFor, optOutHash, parseCommsConfig, parseMetaBody, parseTwilioParams, sha256Hex, type WebhookRequest } from "../src/index.ts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-8, JARVIS-112): en WhatsApp-meldings-id (`wamid.HBgL<base64>...`) KAN (UVERIFISERT mot en ekte id) kode AVSENDERENS TELEFONNUMMER i base64. Hendelsesnøkkelen ble lagret rått i `comms_inbound_events` (30/1825 d),
 * `comms_inbound_receipts` (1825 d) og som peker i `comms_recipient_opt_outs.evidence_ref` - i strid med påstanden «ingen mottaker, ingen tekst» for kvitteringstabellen, og den omgikk pseudonymiseringen av en STOP-avsender. Nå er nøkkelen
 * for WhatsApp ALLTID en SHA-256 av id-en (samme funksjon og format som K3 brukte for lange id-er: ÉN mekanisme), deterministisk (dedupe virker) og uavhengig av pepperen (STOP-mottak skal aldri kreve at en pepper er konfigurert).
 * Id-en bygges her SAMMENSATT ved kjøring (aldri en bokstavelig ID-lignende streng i kildekoden), på Metas antatte form: lengdeprefiks, telefonnummeret som tekst, og en tilfeldig meldings-id-hale.
 */
const META_SECRET = "fake-meta-app-secret";
const PHONE_ID = "109876543210";
let chain: Chain;
let svcA: CommsWebhookService;
let svcB: CommsWebhookService;
let n = 0;

/** En `wamid` som koder `digits` (avsenderens nummer) i base64, med en unik hale. */
function wamidFor(digits: string): string {
  const tail = createHmac("sha256", "x").update(`tail-${++n}-${digits}`).digest("hex").slice(0, 20).toUpperCase();
  const blob = Buffer.concat([Buffer.from([0x1c, 0x18, digits.length]), Buffer.from(digits, "utf8"), Buffer.from([0x15, 0x02, 0x00, 0x12, 0x18, 0x14]), Buffer.from(tail, "utf8"), Buffer.from([0x00])]);
  return `wamid.${blob.toString("base64")}`;
}
/** Alle tre base64-justeringer av nummeret (hvor i en 3-byte-gruppe det starter), så et søk ikke kan unngås av at nummeret ligger forskjøvet i blokken. */
function numberNeedles(digits: string): string[] {
  const needles: string[] = [digits];
  for (const pad of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(pad), Buffer.from(digits, "utf8")]).toString("base64");
    needles.push(b64.slice(Math.ceil((pad * 4) / 3) + 1, -2)); // den midtre, justeringsuavhengige delen
  }
  return needles.filter((x) => x.length >= 8);
}
const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waBody = (messages: Array<{ from: string; id: string; text: string }>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: PHONE_ID },
    messages: messages.map((m) => ({ from: m.from, id: m.id, timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: m.text } }))
  } }] }]
});
const digitsOf = (): string => chain.phone().replace("+", "");
const wkey = (id: string): string => `wa:msg:sha256:${sha256Hex(id)}`;

/** Antall rader i ALLE `comms_*`-tabeller der noen kolonne (som tekst) inneholder nålen. Rad-til-tekst, så ingen kolonne kan hoppes over. */
async function hitsAnywhere(needles: readonly string[]): Promise<Record<string, number>> {
  const tables = ((await chain.db.admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'comms\\_%' ORDER BY 1")).rows as Array<{ tablename: string }>).map((r) => r.tablename);
  const out: Record<string, number> = {};
  for (const t of tables) {
    for (const needle of needles) {
      const hits = ((await chain.db.admin.query(`SELECT count(*)::int AS n FROM ${t} x WHERE strpos(x::text, $1) > 0`, [needle])).rows[0] as { n: number }).n;
      if (hits > 0) out[`${t}:${needle.slice(0, 12)}`] = hits;
    }
  }
  return out;
}

beforeAll(async () => {
  chain = await startChain("g1ckp", { JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" });
  await authorizeAll(chain, [["whatsapp", PHONE_ID, "meta_whatsapp"]]);
  const secrets = { get: async (ref: string) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) };
  svcA = new CommsWebhookService({ store: chain.store, graph: chain.graph, config: chain.config, secrets, clock: chain.now });
  svcB = new CommsWebhookService({
    store: chain.store, graph: chain.graph, secrets, clock: chain.now,
    config: parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "whatsapp", JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_B, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" })
  });
  await chain.db.admin.query(
    "INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, status, source) VALUES ($1, 'acct-b-wa-0001', 'business', 'whatsapp', $2, 'meta_whatsapp', 'active', 'owner_route')", [TENANT_B, PHONE_ID]
  );
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("FIX-8: hendelsesnøkkelen for WhatsApp er alltid en SHA-256 (parser)", () => {
  it("meldinger og statusvarsler: `wa:msg:sha256:<hex>`/`wa:status:sha256:<hex>`, aldri id-en eller nummeret; deterministisk; ulike id-er og ulike statuser gir ulike nøkler", () => {
    const [d1, d2] = [digitsOf(), digitsOf()];
    const [w1, w2] = [wamidFor(d1), wamidFor(d2)];
    const a = parseMetaBody(waBody([{ from: d1, id: w1, text: "Hei" }, { from: d2, id: w2, text: "STOPP" }]));
    expect(a.events.map((e) => e.event_key)).toEqual([wkey(w1), wkey(w2)]);
    for (const e of a.events) {
      expect(e.event_key).toMatch(/^wa:msg:sha256:[0-9a-f]{64}$/);
      expect(e.event_key).not.toContain("wamid");
      for (const needle of [...numberNeedles(d1), ...numberNeedles(d2)]) expect(e.event_key).not.toContain(needle);
    }
    expect(parseMetaBody(waBody([{ from: d1, id: w1, text: "Hei" }])).events[0]!.event_key, "stabil: dedupe virker").toBe(wkey(w1));
    const status = (s: string) => parseMetaBody({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: w1, status: s, recipient_id: d1, timestamp: "1763380800" }] } }] }] }).events[0]!.event_key;
    expect(status("read")).toBe(`wa:status:sha256:${sha256Hex(`${w1}\nread`)}`);
    expect(status("read")).not.toBe(status("delivered"));
    expect(status("read")).not.toContain("wamid");
  });

  it("andre leverandører uendret: en vanlig Twilio-SID beholder sin rene nøkkel (kun WhatsApp-id-er kan kode et telefonnummer)", () => {
    const sid = `SM${"a1".repeat(16)}`;
    const tw = parseTwilioParams(new Map([["MessageSid", [sid]], ["From", ["+4790000001"]], ["To", ["+4791000000"]], ["Body", ["Hei"]]]));
    expect(tw.events[0]!.event_key).toBe(`twilio:msg:${sid}`);
  });

  it("evidenspekeren er en ren funksjon av nøkkelen: den hashede nøkkelen (71 tegn) brukes uendret", () => {
    const key = wkey(wamidFor(digitsOf()));
    expect(key.length).toBeLessThan(200);
    expect(evidenceRefFor(key)).toBe(key);
  });
});

describe("FIX-8: ingen tabell inneholder den rå meldings-id-en eller avsenderens nummer i klartekst eller base64 etter innsetting", () => {
  it("STOP, START og vanlig melding gjennom den signerte webhooken: hendelser, kvitteringer og avmeldingens evidens-peker bærer kun hashen", async () => {
    const [stopper, starter, talker] = [digitsOf(), digitsOf(), digitsOf()];
    const ids = { stop: wamidFor(stopper), start: wamidFor(starter), talk: wamidFor(talker) };
    const r = await svcA.handle("meta", metaReq(waBody([
      { from: stopper, id: ids.stop, text: "STOPP" }, { from: starter, id: ids.start, text: "START" }, { from: talker, id: ids.talk, text: "Hei, har dere åpent?" }
    ])));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ events: { received: 3, inserted: 3, opt_outs: 1, opt_ins: 1 } });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", `+${stopper}`))).toBe(true);

    const needles = [ids.stop, ids.start, ids.talk, ids.stop.slice("wamid.".length), ids.start.slice("wamid.".length), ids.talk.slice("wamid.".length), ...numberNeedles(stopper), ...numberNeedles(starter), ...numberNeedles(talker)];
    expect(await hitsAnywhere(needles), "ingen comms-tabell har id-en eller nummeret (rått eller base64)").toEqual({});

    // kontroll: det som ER lagret er hashen, i alle tre sporene
    const events = (await chain.db.admin.query("SELECT event_key FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = ANY($2::text[])", [TENANT_A, [wkey(ids.stop), wkey(ids.start), wkey(ids.talk)]])).rows;
    expect(events).toHaveLength(3);
    const receipt = (await chain.db.admin.query("SELECT event_key FROM comms_inbound_receipts WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, wkey(ids.start)])).rows;
    expect(receipt, "START har første-mottak-kvittering på den hashede nøkkelen").toHaveLength(1);
    const evidence = (await chain.db.admin.query("SELECT evidence_ref FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, optOutHash(TENANT_A, "whatsapp", `+${stopper}`)])).rows;
    expect(evidence).toEqual([{ evidence_ref: wkey(ids.stop) }]);
    // kontroll av kontrollen: nåler som SKAL finnes gir treff (testen kan ikke bestå fordi søket er blindt)
    const control = await hitsAnywhere([wkey(ids.stop)]);
    expect(Object.keys(control).sort()).toEqual(["comms_inbound_events:wa:msg:sha25", "comms_recipient_opt_outs:wa:msg:sha25"]);
  });

  it("dedupe virker på den hashede nøkkelen: samme levering to ganger gir én lagret hendelse og én avmelding", async () => {
    const stopper = digitsOf();
    const id = wamidFor(stopper);
    const body = waBody([{ from: stopper, id, text: "STOPP" }]);
    expect((await svcA.handle("meta", metaReq(body))).body).toMatchObject({ events: { inserted: 1, duplicates: 0, opt_outs: 1 } });
    expect((await svcA.handle("meta", metaReq(body))).body).toMatchObject({ events: { inserted: 0, duplicates: 1, opt_outs: 0 } });
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, wkey(id)])).rows[0] as { n: number }).n).toBe(1);
  });

  it("kryss-tenant: samme meldings-id i to tenanter dedupes uavhengig (tenant A sin levering skjuler ikke tenant B sin), og nøkkelen er den samme hashen i begge (nøkkelen er del av en tenant-nøklet primærnøkkel)", async () => {
    const stopper = digitsOf();
    const id = wamidFor(stopper);
    const body = waBody([{ from: stopper, id, text: "STOPP" }]);
    expect((await svcA.handle("meta", metaReq(body))).body).toMatchObject({ events: { inserted: 1, opt_outs: 1 } });
    expect((await svcB.handle("meta", metaReq(body))).body, "tenant B ser ikke A sin dedupe-rad").toMatchObject({ events: { inserted: 1, duplicates: 0, opt_outs: 1 } });
    expect((await svcB.handle("meta", metaReq(body))).body).toMatchObject({ events: { inserted: 0, duplicates: 1 } });
    const rows = (await chain.db.admin.query("SELECT tenant_id FROM comms_inbound_events WHERE event_key = $1 ORDER BY tenant_id", [wkey(id)])).rows;
    expect(rows).toEqual([{ tenant_id: TENANT_A }, { tenant_id: TENANT_B }]);
    expect(await chain.store.isOptedOut(TENANT_B, optOutHash(TENANT_B, "whatsapp", `+${stopper}`))).toBe(true);
  });
});
