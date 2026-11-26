import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CommsWebhookService, WEBHOOK_SECRET_REFS, optOutHash, type WebhookRequest } from "../src/index.ts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-2, JARVIS-112 d): over-tak-svaret må gi FREMDRIFT. Taket (1000) telte ALLE hendelser, også duplikater: en batch på 1001 ga 503, og leverandørens retry ga `duplicates: 1000, deferred: 1` - hendelse nr. 1001 ble
 * aldri behandlet, uansett hvor mange ganger leverandøren prøvde (5 av 45 STOP og 10 av 60 vanlige meldinger ble aldri satt inn etter fire forsøk). Nå: kjente duplikater (dedupe-raden finnes, og effekten ble skrevet i SAMME transaksjon, B-H2) slås opp
 * i ÉN spørring og hoppes over uten arbeid; kun hendelser som faktisk SKRIVES teller mot taket; stopp-/start-ord behandles fortsatt først. Hver retry tar dermed neste porsjon, og en 503 betyr alltid at det gjenstår nye hendelser.
 */
const META_SECRET = "fake-meta-app-secret";
const PHONE_ID = "109876543210";
let chain: Chain;
let mid = 0;
const warnings: Array<Record<string, unknown>> = [];

const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waMessage = (from: string, text: string, id = `wamid.prog.${++mid}.${Math.random().toString(36).slice(2, 10)}`) => ({ from, id, timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: text } });
const waBatch = (messages: object[], phoneNumberId = PHONE_ID): object => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: phoneNumberId }, messages } }] }]
});
const waNum = (): string => chain.phone().replace("+", "");
const optedWa = (digits: string): Promise<boolean> => chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", `+${digits}`));
const service = (extra: { maxEventsPerRequest?: number } = {}) => new CommsWebhookService({
  store: chain.store, graph: chain.graph, config: chain.config, clock: chain.now, warn: (w) => warnings.push(w), ...extra,
  secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }
});
/** Antall lagrede WhatsApp-meldingshendelser (FIX-8: nøkkelen er en hash, så en delmengde kan ikke telles på id-prefiks - testene sammenligner før/etter). */
const storedCount = async (): Promise<number> => ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_inbound_events WHERE tenant_id = $1 AND event_key LIKE 'wa:msg:sha256:%'", [TENANT_A])).rows[0] as { n: number }).n;

beforeAll(async () => {
  chain = await startChain("g1c2p", { JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" });
  await authorizeAll(chain, [["whatsapp", PHONE_ID, "meta_whatsapp"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("FIX-2: hver retry tar neste porsjon (konvergerer)", () => {
  it("2500 hendelser (det ekte taket 1000), STOP SIST: konvergerer innen 3 forsøk; STOP er registrert allerede i første forsøk; alle 2500 er lagret til slutt", async () => {
    const stopper = waNum();
    ++mid;
    const stored0 = await storedCount();
    const normals = Array.from({ length: 2499 }, (_, i) => waMessage(waNum(), "hei", `wamid.conv${mid}x${i}`));
    const body = waBatch([...normals, waMessage(stopper, "STOPP", `wamid.conv${mid}xSTOP`)]);
    const svc = service();
    const attempt1 = await svc.handle("meta", metaReq(body));
    expect(attempt1.status, "forsøk 1: taket nådd").toBe(503);
    expect(attempt1.body).toMatchObject({ error: "batch_over_cap", events: { inserted: 1000, opt_outs: 1, deferred: 1500 } });
    expect(await optedWa(stopper), "STOP står sist i kroppen men behandles FØRST: registrert i første forsøk").toBe(true);

    const attempt2 = await svc.handle("meta", metaReq(body));
    expect(attempt2.status, "forsøk 2: neste porsjon").toBe(503);
    expect(attempt2.body).toMatchObject({ error: "batch_over_cap", events: { inserted: 1000, duplicates: 1000, deferred: 500 } });

    const attempt3 = await svc.handle("meta", metaReq(body));
    expect(attempt3.status, "forsøk 3: resten, ferdig").toBe(200);
    expect(attempt3.body).toMatchObject({ received: true, events: { inserted: 500, duplicates: 2000 } });
    expect((await storedCount()) - stored0).toBe(2500);

    const attempt4 = await svc.handle("meta", metaReq(body));
    expect(attempt4.status).toBe(200);
    expect(attempt4.body).toMatchObject({ events: { inserted: 0, duplicates: 2500 } });
  }, 300_000);

  it("1001 hendelser: forsøk 1 gir 503 med nøyaktig én utsatt; forsøk 2 behandler hendelse nr. 1001 og gir 200 (før: `duplicates: 1000, deferred: 1`, for alltid)", async () => {
    const msgs = Array.from({ length: 1001 }, (_, i) => waMessage(waNum(), "hei", `wamid.one${mid}x${i}`));
    const body = waBatch(msgs);
    const stored0 = await storedCount();
    const svc = service();
    const first = await svc.handle("meta", metaReq(body));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ events: { inserted: 1000, deferred: 1 } });
    const second = await svc.handle("meta", metaReq(body));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ events: { inserted: 1, duplicates: 1000 } });
    expect((await storedCount()) - stored0).toBe(1001);
  }, 300_000);

  it("kjente duplikater slås opp i ÉN spørring og koster ingen behandling: retry av en kropp der alt unntatt halen er sett kaller recordInbound kun for halen", async () => {
    const svc = service({ maxEventsPerRequest: 20 });
    const msgs = Array.from({ length: 45 }, (_, i) => waMessage(waNum(), "hei", `wamid.dd${mid}x${i}`));
    const body = waBatch(msgs);
    expect((await svc.handle("meta", metaReq(body))).status).toBe(503); // 20 nye
    expect((await svc.handle("meta", metaReq(body))).status).toBe(503); // 20 nye til (20 duplikater hoppes over)
    const spy = vi.spyOn(chain.store, "recordInbound");
    try {
      const last = await svc.handle("meta", metaReq(body));
      expect(last.status).toBe(200);
      expect(last.body).toMatchObject({ events: { inserted: 5, duplicates: 40 } });
      expect(spy, "kun de 5 nye hendelsene når lagringen - de 40 kjente er hoppet over").toHaveBeenCalledTimes(5);
    } finally { spy.mockRestore(); }
  }, 120_000);

  it("«utsatt» teller kun NYE hendelser: kjente duplikater som står ETTER taket regnes ikke som utsatte (503 betyr alltid at det gjenstår nye hendelser)", async () => {
    const svc = service({ maxEventsPerRequest: 5 });
    const all = Array.from({ length: 12 }, (_, i) => waMessage(waNum(), "hei", `wamid.post${mid}x${i}`));
    // to hendelser midt i halen er kjent fra før (levert alene): de står etter taket i den fulle kroppen
    expect((await svc.handle("meta", metaReq(waBatch([all[8]!, all[9]!])))).status).toBe(200);
    const first = await svc.handle("meta", metaReq(waBatch(all)));
    expect(first.status).toBe(503);
    expect(first.body, "e8 og e9 er kjent men står etter taket: de er verken telt som duplikater eller som utsatte").toMatchObject({ error: "batch_over_cap", events: { inserted: 5, deferred: 5, duplicates: 0 } });
    // alt som gjenstår er kjent: ingen utsatt, ingen 503 (200)
    const second = await svc.handle("meta", metaReq(waBatch(all)));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ events: { inserted: 5, duplicates: 7 } });
  }, 120_000);

  it("duplikater teller IKKE mot taket: 10 sett fra før + 10 nye ved tak 10 gir 200 (alle 10 nye behandles)", async () => {
    const svc = service({ maxEventsPerRequest: 10 });
    const all = Array.from({ length: 20 }, (_, i) => waMessage(waNum(), "hei", `wamid.dup${mid}x${i}`));
    expect((await svc.handle("meta", metaReq(waBatch(all.slice(0, 10))))).status).toBe(200);
    const res = await svc.handle("meta", metaReq(waBatch(all)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ events: { received: 20, inserted: 10, duplicates: 10 } });
  }, 120_000);

  it("hendelser som ikke skrives (ignorert: ukjent konto) teller IKKE mot taket - de kan ikke sulte ut de som skal behandles", async () => {
    const svc = service({ maxEventsPerRequest: 5 });
    const ignored = Array.from({ length: 30 }, (_, i) => waMessage("4790000001", "hei", `wamid.ign${mid}x${i}`));
    const real = Array.from({ length: 5 }, (_, i) => waMessage(waNum(), "hei", `wamid.real${mid}x${i}`));
    // de ignorerte står FØRST i kroppen (til en konto eieren ikke har autorisert), de 5 ekte sist
    const res = await svc.handle("meta", metaReq({
      object: "whatsapp_business_account",
      entry: [{ id: "waba1", changes: [
        { field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "999999999999" }, messages: ignored } },
        { field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: PHONE_ID }, messages: real } }
      ] }]
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, events: { inserted: 5, ignored: 30 } });
  }, 120_000);

  it("503-loggen har fortsatt KUN årsakskode og tall (provider, events, cap, deferred), ingen id/nummer/tekst", async () => {
    const svc = service({ maxEventsPerRequest: 3 });
    warnings.length = 0;
    const stopper = waNum();
    const res = await svc.handle("meta", metaReq(waBatch([...Array.from({ length: 6 }, () => waMessage(waNum(), "hemmelig-tekst-xyz")), waMessage(stopper, "STOPP")])));
    expect(res.status).toBe(503);
    const log = warnings.find((w) => w["msg"] === "comms_webhook_batch_over_cap");
    expect(log).toEqual({ msg: "comms_webhook_batch_over_cap", provider: "meta", events: 7, cap: 3, deferred: 4 });
    expect(JSON.stringify(warnings)).not.toContain("hemmelig-tekst-xyz");
    expect(JSON.stringify(warnings)).not.toContain(stopper);
  });
});

describe("FIX-2: «kjent hendelsesnøkkel» er per tenant OG per leverandør (dedupe-nøkkelen er (tenant, leverandør, nøkkel))", () => {
  it("samme nøkkel hos en annen leverandør er en annen hendelse: ikke kjent (ellers ville en ekte hendelse hoppes over som duplikat og aldri skrives); og den kan skrives der", async () => {
    const key = `shared-key-${++mid}-${Math.random().toString(36).slice(2, 10)}`;
    const base = { channel: "sms" as const, account_ref: "+4791000000", event_key: key, kind: "message" as const, sender_hash: null, sender_hint: null, identity_id: null, thread_ref: null, content_excerpt: "hei", content_sha256: null, provider_ts: null, ingest_id: "ingest-known-0001" };
    expect((await chain.store.recordInbound(TENANT_A, "business", { ...base, provider: "twilio" }, 30)).inserted).toBe(true);
    expect([...(await chain.store.knownEventKeys(TENANT_A, "business", "twilio", [key, "ukjent-nokkel"]))], "kontroll: nøkkelen er kjent hos leverandøren den ble skrevet for").toEqual([key]);
    expect((await chain.store.knownEventKeys(TENANT_A, "business", "meta", [key])).size, "samme nøkkel hos en annen leverandør: ikke kjent").toBe(0);
    expect((await chain.store.knownEventKeys(TENANT_B, "business", "twilio", [key])).size, "samme nøkkel og leverandør i en annen tenant: ikke kjent").toBe(0);
    expect((await chain.store.recordInbound(TENANT_A, "business", { ...base, provider: "meta", channel: "whatsapp", account_ref: PHONE_ID }, 30)).inserted, "den andre leverandørens hendelse med samme nøkkel skrives").toBe(true);
  });
});
