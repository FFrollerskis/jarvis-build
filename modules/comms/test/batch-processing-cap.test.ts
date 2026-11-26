import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsWebhookService, PROCESSING_CAP_FACTOR, WEBHOOK_SECRET_REFS, optOutHash, type WebhookRequest } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c fiks-runde 2 (FIX-3): taket (1000) teller kun SKREVNE hendelser, så arbeidet per forespørsel var bare byte-begrenset. En signert Meta-kropp kan være 4 MiB, og hendelser som ikke skrives (ignorert: ukjent konto, for gammel) koster likevel
 * minst ett kontooppslag hver: 16 000 ignorerte hendelser (2,7 MB) tok 6,9 s (0,43 ms per hendelse), ca. 10 s per 4 MiB på utviklingsdatabasen og mer på NAS - lenger enn leverandørens svarfrist (UVERIFISERT), så leverandøren ville sendt
 * samme kropp på nytt (retry-storm). Nå finnes et EGET tak på BEHANDLEDE hendelser per forespørsel (`PROCESSING_CAP_FACTOR` x skrivetaket = 5000 som standard): over det svarer tjenesten 503 `batch_over_cap` (som for skrivetaket), og loggen har
 * kun årsakskode og tall.
 *
 * STOP-sikkerheten er uendret og bevist her: stopp-ord (STOP) er UNNTATT behandlingstaket (de skrives alltid, og antallet er begrenset av skrivetaket), og de behandles først, så en STOP som står sist i en kropp med langt flere ignorerbare
 * hendelser enn taket er registrert i FØRSTE forsøk og forblir det ved alle retry. Kjente duplikater (dedupe-raden finnes) hoppes over uten arbeid og teller ikke.
 */
const META_SECRET = "fake-meta-app-secret";
const PHONE_ID = "109876543210";
const UNKNOWN_PHONE_ID = "999999999999";
let chain: Chain;
let mid = 0;
const warnings: Array<Record<string, unknown>> = [];

const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const waMessage = (from: string, text: string, id = `wamid.pc.${++mid}.${Math.random().toString(36).slice(2, 10)}`) => ({ from, id, timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: text } });
/** En Meta-kropp med flere `changes` (hver mot sin telefon-id): rekkefølgen i kroppen er rekkefølgen i listen. */
const waBody = (changes: Array<{ phoneNumberId: string; messages: object[] }>): object => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: changes.map((c) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: c.phoneNumberId }, messages: c.messages } })) }]
});
const waNum = (): string => chain.phone().replace("+", "");
const optedWa = (digits: string): Promise<boolean> => chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", `+${digits}`));
const service = (extra: { maxEventsPerRequest?: number; maxProcessedPerRequest?: number } = {}) => new CommsWebhookService({
  store: chain.store, graph: chain.graph, config: chain.config, clock: chain.now, warn: (w) => warnings.push(w), ...extra,
  secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }
});
const ignorable = (n: number, text = "hei"): object[] => Array.from({ length: n }, () => waMessage("4790000001", text));

beforeAll(async () => {
  chain = await startChain("g2pc", { JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" });
  await authorizeAll(chain, [["whatsapp", PHONE_ID, "meta_whatsapp"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("FIX-3 (runde 2): eget tak på BEHANDLEDE hendelser per forespørsel", () => {
  it("standard: behandlingstaket er 5 x skrivetaket", () => {
    expect(PROCESSING_CAP_FACTOR).toBe(5);
  });

  it("ignorerte hendelser (ukjent konto) teller mot BEHANDLINGSTAKET (ikke skrivetaket): 503 `batch_over_cap`, og STOP som står SIST er registrert i første forsøk", async () => {
    const svc = service({ maxEventsPerRequest: 5, maxProcessedPerRequest: 10 });
    const stopper = waNum();
    const body = waBody([
      { phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(25) },
      { phoneNumberId: PHONE_ID, messages: [waMessage(waNum(), "hei"), waMessage(waNum(), "hei"), waMessage(waNum(), "hei"), waMessage(stopper, "STOPP")] }
    ]);
    warnings.length = 0;
    const res = await svc.handle("meta", metaReq(body));
    expect(res.status, "over behandlingstaket: feilstatus så leverandøren prøver på nytt").toBe(503);
    // STOP (prioritert først) + 9 ignorerte = 10 behandlet; 16 ignorerte + 3 ekte meldinger utsatt
    expect(res.body).toMatchObject({ error: "batch_over_cap", events: { received: 10, inserted: 1, ignored: 9, opt_outs: 1, deferred: 19 } });
    expect(await optedWa(stopper), "STOP står sist i kroppen men behandles FØRST: registrert i første forsøk").toBe(true);
    const log = warnings.find((w) => w["msg"] === "comms_webhook_batch_over_cap");
    expect(log, "loggen har kun årsakskode og tall").toEqual({ msg: "comms_webhook_batch_over_cap", provider: "meta", reason: "processing_cap", events: 29, cap: 5, deferred: 19 });
    expect(JSON.stringify(warnings)).not.toContain(stopper);
  });

  it("grensen er presis: akkurat PÅ behandlingstaket gir 200, ett over gir 503 med nøyaktig én utsatt (standardtaket 5000 med ekte konfigurasjon)", async () => {
    const svc = service();
    const at = await svc.handle("meta", metaReq(waBody([{ phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(5000) }])));
    expect(at.status).toBe(200);
    expect(at.body).toMatchObject({ received: true, events: { received: 5000, ignored: 5000, inserted: 0 } });
    const over = await svc.handle("meta", metaReq(waBody([{ phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(5001) }])));
    expect(over.status).toBe(503);
    expect(over.body).toMatchObject({ error: "batch_over_cap", events: { received: 5000, ignored: 5000, deferred: 1 } });
  }, 120_000);

  it("STOP over behandlingstaket mistes ALDRI, heller ikke når tusenvis av ignorerbare stopp-/start-ord står FØR den: registrert i forsøk 1 og forblir registrert ved alle retry", async () => {
    const svc = service({ maxEventsPerRequest: 5, maxProcessedPerRequest: 10 });
    const stopper = waNum();
    // 30 START (til en ukjent konto: ignoreres, kan aldri bli «kjent») står FØR STOP i kroppen, og begge er stopp-/start-ord (behandles først, i kroppens rekkefølge)
    const body = waBody([
      { phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(30, "START") },
      { phoneNumberId: PHONE_ID, messages: [waMessage(stopper, "STOPP")] }
    ]);
    const first = await svc.handle("meta", metaReq(body));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ error: "batch_over_cap", events: { received: 11, inserted: 1, ignored: 10, opt_outs: 1, deferred: 20 } });
    expect(await optedWa(stopper), "STOP (unntatt behandlingstaket) er registrert i første forsøk").toBe(true);
    for (let attempt = 2; attempt <= 4; attempt++) {
      const again = await svc.handle("meta", metaReq(body));
      // dokumentert grense: ignorerbare hendelser kan aldri bli «kjent» (de lagres ikke), så en kropp med flere av dem enn taket gir 503 ved hver retry - men STOP er kjent (duplikat) og forblir registrert
      expect(again.status, `forsøk ${attempt}`).toBe(503);
      expect(again.body, `forsøk ${attempt}`).toMatchObject({ error: "batch_over_cap", events: { duplicates: 1, inserted: 0, opt_outs: 0, deferred: 20 } });
      expect(await optedWa(stopper), `forsøk ${attempt}: STOP forblir registrert`).toBe(true);
    }
  }, 120_000);

  it("begge tak i SAMME forespørsel: utsatt telles riktig (behandlingstak og skrivetak), STOP over skrivetaket utsettes (ikke mistes) og er registrert etter retry; alle tre avmeldt", async () => {
    // skrivetak 2, behandlingstak 3: 4 ignorerbare START (ukjent konto) står først, så tre STOP. START 1-3 behandles (ignorert), START 4 utsettes av behandlingstaket; STOP 1-2 skrives (unntatt behandlingstaket), STOP 3 utsettes av skrivetaket.
    const svc = service({ maxEventsPerRequest: 2, maxProcessedPerRequest: 3 });
    const stoppers = [waNum(), waNum(), waNum()];
    const body = waBody([
      { phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(4, "START") },
      { phoneNumberId: PHONE_ID, messages: stoppers.map((n) => waMessage(n, "STOPP")) }
    ]);
    warnings.length = 0;
    const first = await svc.handle("meta", metaReq(body));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ error: "batch_over_cap", events: { received: 5, inserted: 2, ignored: 3, opt_outs: 2, deferred: 2 } });
    expect(warnings.find((w) => w["msg"] === "comms_webhook_batch_over_cap"), "årsaken er den FØRSTE grensen som utsatte noe").toMatchObject({ reason: "processing_cap", events: 7, deferred: 2 });
    expect(await Promise.all(stoppers.map(optedWa))).toEqual([true, true, false]);
    const second = await svc.handle("meta", metaReq(body));
    expect(second.status, "den utsatte START-en er ignorerbar og gir 503 til den ikke lenger er over taket (dokumentert grense)").toBe(503);
    expect(second.body).toMatchObject({ events: { duplicates: 2, inserted: 1, opt_outs: 1, deferred: 1 } });
    expect(await Promise.all(stoppers.map(optedWa)), "alle tre STOP er registrert").toEqual([true, true, true]);
  }, 120_000);

  it("kjente duplikater teller IKKE mot behandlingstaket: 30 sett fra før + 10 ignorerbare ved behandlingstak 10 gir 200", async () => {
    const seen = Array.from({ length: 30 }, () => waMessage(waNum(), "hei"));
    expect((await service({ maxEventsPerRequest: 100 }).handle("meta", metaReq(waBody([{ phoneNumberId: PHONE_ID, messages: seen }])))).status).toBe(200);
    const svc = service({ maxEventsPerRequest: 100, maxProcessedPerRequest: 10 });
    const res = await svc.handle("meta", metaReq(waBody([{ phoneNumberId: PHONE_ID, messages: seen }, { phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(10) }])));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, events: { received: 40, duplicates: 30, ignored: 10, inserted: 0 } });
  }, 120_000);

  it("skrivetaket gjelder fortsatt uavhengig: 12 nye ekte hendelser ved skrivetak 5 og stort behandlingstak gir 503 med årsak `write_cap`, og retry tar neste porsjon (uendret fremdrift fra FIX-2)", async () => {
    const svc = service({ maxEventsPerRequest: 5, maxProcessedPerRequest: 1000 });
    const body = waBody([{ phoneNumberId: PHONE_ID, messages: Array.from({ length: 12 }, () => waMessage(waNum(), "hei")) }]);
    warnings.length = 0;
    const a = await svc.handle("meta", metaReq(body));
    expect(a.status).toBe(503);
    expect(a.body).toMatchObject({ events: { inserted: 5, deferred: 7 } });
    expect(warnings.find((w) => w["msg"] === "comms_webhook_batch_over_cap")).toMatchObject({ reason: "write_cap", deferred: 7 });
    expect((await svc.handle("meta", metaReq(body))).status).toBe(503);
    const c = await svc.handle("meta", metaReq(body));
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ events: { inserted: 2, duplicates: 10 } });
  }, 120_000);

  it("en kropp under begge tak er uendret: 40 nye ekte hendelser + 20 ignorerte ved skrivetak 100 og behandlingstak 100 gir 200", async () => {
    const svc = service({ maxEventsPerRequest: 100, maxProcessedPerRequest: 100 });
    const res = await svc.handle("meta", metaReq(waBody([{ phoneNumberId: UNKNOWN_PHONE_ID, messages: ignorable(20) }, { phoneNumberId: PHONE_ID, messages: Array.from({ length: 40 }, () => waMessage(waNum(), "hei")) }])));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, events: { received: 60, inserted: 40, ignored: 20 } });
  }, 120_000);
});
