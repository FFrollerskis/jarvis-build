import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { CommsStore, CommsWebhookService, evidenceRefFor, optOutHash, parseCommsConfig, sha256Hex, WEBHOOK_SECRET_REFS, type WebhookRequest } from "../src/index.ts";
import { TENANT_A, startCommsDb, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1 fiks-runde B-H2: mottakerens STOP kan ikke gå tapt. Før: dedupe-raden (`recordInbound`) og avmeldingen (`recordOptOut`) lå i to transaksjoner - feilet den andre, var leverandørens retry en «duplikat» og STOP ble aldri
 * registrert. Og en WhatsApp-STOP med meldings-id på 194+ tegn ga en hendelsesnøkkel > 200 tegn som brøt `evidence_ref`-CHECK-en ETTER at dedupe-raden var lagret (deterministisk tap). Nå: ÉN transaksjon, og en lang nøkkel
 * erstattes av sin SHA-256 i `evidence_ref`.
 */
const NOW = 1_763_380_800;
const clock = () => new Date(NOW * 1000);
const META_SECRET = "fake-meta-app-secret";
let db: CommsDb;
let store: CommsStore;
let service: CommsWebhookService;
let n = 0;

const waStop = (from: string, mid: string, text = "STOP") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: "109876543210" }, messages: [{ from, id: mid, timestamp: String(NOW), type: "text", text: { body: text } }] } }] }]
});
const metaReq = (body: object): WebhookRequest => {
  const raw = Buffer.from(JSON.stringify(body));
  return { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META_SECRET).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/webhooks/comms/meta", query: new URLSearchParams() };
};
const phone = () => `+4790${String(700000 + ++n).padStart(6, "0").slice(-6)}`;
const digits = (e164: string) => e164.slice(1);
/** FIX-8: WhatsApp-hendelsesnøkkelen er alltid en SHA-256 av meldings-id-en (aldri den rå `wamid`). */
const waKey = (mid: string): string => `wa:msg:sha256:${sha256Hex(mid)}`;
const opted = (e164: string) => store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", e164));
const eventRows = async (key: string) => (await db.admin.query("SELECT kind, event_key FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, key])).rows as Array<{ kind: string; event_key: string }>;
const optRows = async (e164: string) => (await db.admin.query("SELECT status, source, evidence_ref FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, optOutHash(TENANT_A, "whatsapp", e164)])).rows as Array<{ status: string; source: string; evidence_ref: string }>;

beforeAll(async () => {
  db = await startCommsDb("g1stp");
  // Marginen 0 = ren sekvensmodell (en START løfter alt med lavere sekvens): denne testen legger inn en STOP og straks en START og forventer at START løfter. Tie-marginen (STOP vinner innenfor 5 s) er bevist i `stop-start-overlap.test.ts`.
  // FIX-6 (runde 2): HELE filen bruker en pool med `lock_timeout` 5 s (ikke bare X6-testen under). Uten den ga en selv-vranglås (STOP i egen transaksjon: mutant M62) at den ELDSTE testen hang til test-timeouten (30 s), og `afterAll` ventet så ut hook-timeouten
  // (120 s) fordi den hengende forbindelsen aldri ble frigitt: 159 s totalt og en feilmelding om timeout. Nå feiler den med en rask, tydelig 55P03 (lock_timeout) og pool-en kan lukkes. Testene venter aldri på en lås i normal drift, så ingenting svekkes.
  const pool = db.appPool({ lockTimeoutMs: 5000 });
  store = new CommsStore(pool, clock, { startTieMarginMs: 0 });
  const graph = new ConversationGraphService(pool);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "whatsapp", JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A });
  service = new CommsWebhookService({ store, graph, config, secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock });
  await store.authorizeAccount(TENANT_A, "business", { channel: "whatsapp", account_ref: "109876543210", provider: "meta_whatsapp", source: "owner_route" }, { person_id: "person-g1-owner", session_id: "sess-stp" });
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("evidenceRefFor: en avmelding kan aldri feile på lengden av leverandørens id", () => {
  it("nøkler opptil 200 tegn beholdes; lengre erstattes av sha256:<hex> (deterministisk, ≤ 200 tegn)", () => {
    expect(evidenceRefFor("wa:msg:abc")).toBe("wa:msg:abc");
    expect(evidenceRefFor("x".repeat(200))).toBe("x".repeat(200));
    const long = `wa:msg:${"A".repeat(250)}`;
    const ref = evidenceRefFor(long);
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidenceRefFor(long)).toBe(ref);
    expect(evidenceRefFor(`${long}B`)).not.toBe(ref);
  });
});

describe("B-H2: WhatsApp-STOP med lang meldings-id registreres alltid", () => {
  it.each([193, 194, 200])("meldings-id på %i tegn: hendelsen lagres, avmeldingen registreres, evidens-peker innenfor DB-grensen", async (idLength) => {
    const from = phone();
    const mid = `wamid.${"A".repeat(idLength - 6)}`;
    expect(mid).toHaveLength(idLength);
    const r = await service.handle("meta", metaReq(waStop(digits(from), mid)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ events: { received: 1, inserted: 1, duplicates: 0, opt_outs: 1 } });
    expect(await opted(from)).toBe(true);
    const rows = await optRows(from);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("inbound_stop_keyword");
    expect(rows[0]!.evidence_ref!.length).toBeLessThanOrEqual(200);
    expect(rows[0]!.evidence_ref, "peker til den hashede nøkkelen, aldri den rå id-en").toBe(evidenceRefFor(waKey(mid)));
    expect(rows[0]!.evidence_ref).not.toContain(mid);
    expect(await eventRows(waKey(mid))).toEqual([{ kind: "opt_out", event_key: waKey(mid) }]);
    // gjenspilling av samme levering: duplikat, ingen ny avmelding, fortsatt avmeldt
    const again = await service.handle("meta", metaReq(waStop(digits(from), mid)));
    expect(again.body).toMatchObject({ events: { inserted: 0, duplicates: 1, opt_outs: 0 } });
    expect(await opted(from)).toBe(true);
  });
});

describe("B-H2: feil i avmeldingen ruller tilbake hele hendelsen (retry behandles på nytt, aldri en «duplikat» uten avmelding)", () => {
  it("avmeldings-INSERT feiler (simulert via DB-trigger): leveringen gir feil, INGEN dedupe-rad og ingen avmelding; retry samme levering registrerer STOP", async () => {
    const from = phone();
    const mid = "wamid.FAILME-retry-1";
    const key = waKey(mid);
    // FIX-8: evidens-pekeren er den hashede nøkkelen, så triggeren feiler på akkurat den (hex-tegn, trygt å sette inn i SQL)
    await db.admin.query(`
      CREATE FUNCTION g1_fail_optout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.evidence_ref = '${key}' THEN RAISE EXCEPTION 'simulert feil i avmeldingssteget'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER g1_fail_optout BEFORE INSERT ON comms_recipient_opt_outs FOR EACH ROW EXECUTE FUNCTION g1_fail_optout();`);
    try {
      await expect(service.handle("meta", metaReq(waStop(digits(from), mid)))).rejects.toThrow(/simulert feil/);
      expect(await eventRows(key)).toEqual([]); // dedupe-raden er rullet tilbake sammen med avmeldingen
      expect(await opted(from)).toBe(false);
    } finally {
      await db.admin.query("DROP TRIGGER g1_fail_optout ON comms_recipient_opt_outs; DROP FUNCTION g1_fail_optout()");
    }
    const retry = await service.handle("meta", metaReq(waStop(digits(from), mid)));
    expect(retry.body).toMatchObject({ events: { inserted: 1, duplicates: 0, opt_outs: 1 } });
    expect(await opted(from)).toBe(true);
    expect(await eventRows(key)).toHaveLength(1);
  });

  it("en vanlig melding (ikke STOP) med lang id lagres som før; START etter STOP opphever kun den innkommende avmeldingen (uendret atferd)", async () => {
    const from = phone();
    const mid = `wamid.${"B".repeat(194)}`;
    await service.handle("meta", metaReq(waStop(digits(from), mid)));
    expect(await opted(from)).toBe(true);
    const start = await service.handle("meta", metaReq(waStop(digits(from), `wamid.start-${++n}`, "START")));
    expect(start.body).toMatchObject({ events: { inserted: 1, opt_ins: 1 } });
    expect(await opted(from)).toBe(false);
    const hello = await service.handle("meta", metaReq(waStop(digits(from), `wamid.hello-${++n}`, "Hei, kan jeg få time?")));
    expect(hello.body).toMatchObject({ events: { inserted: 1, opt_outs: 0, opt_ins: 0 } });
  });
});

describe("B-H2/X6: hendelsen og STOP-effekten bruker NØYAKTIG ÉN transaksjon (rask, ren assertion i stedet for en henging)", () => {
  /**
   * `recordInbound` tar mottakerlåsen i sin transaksjon og skriver dedupe-raden og avmeldingen under den. Kjørte avmeldingen i en EGEN transaksjon (egen forbindelse), ville den vente på låsen `recordInbound` selv holder: en selv-vranglås
   * som uten tidsgrense bare ga en 159 s lang test-timeout. Med `lock_timeout` på de to forbindelsene blir det et rask, tydelig avslag (SQLSTATE 55P03 etter ca. 2 s), og denne testen feiler på `resolves`-sjekken, ikke på en timeout.
   */
  it("en STOP gjennom webhook-tjenesten fullfører på ÉN forbindelse med lock_timeout 2 s: avmeldt, nøyaktig én hendelsesrad og én avmeldingsrad", async () => {
    const guarded = db.appPool({ lockTimeoutMs: 2000 });
    const guardedStore = new CommsStore(guarded, clock, { startTieMarginMs: 0 });
    const guardedService = new CommsWebhookService({
      store: guardedStore, graph: new ConversationGraphService(guarded),
      config: parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "whatsapp", JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A }),
      secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : null) }, clock
    });
    const from = phone();
    const mid = `wamid.x6-single-tx-${++n}`;
    const started = Date.now();
    await expect(guardedService.handle("meta", metaReq(waStop(digits(from), mid)))).resolves.toMatchObject({ status: 200 });
    expect(Date.now() - started, "ingen venting på en lås: fullfører langt under lock_timeout").toBeLessThan(1500);
    expect(await opted(from)).toBe(true);
    expect(await eventRows(waKey(mid))).toHaveLength(1);
    expect(await optRows(from)).toHaveLength(1);
  }, 30_000);
});
