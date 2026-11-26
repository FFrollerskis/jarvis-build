import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { CommsStore, CommsWebhookService, evidenceRefFor, optOutHash, parseCommsConfig, WEBHOOK_SECRET_REFS, type WebhookRequest } from "../src/index.ts";
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
const opted = (e164: string) => store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", e164));
const eventRows = async (key: string) => (await db.admin.query("SELECT kind, event_key FROM comms_inbound_events WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, key])).rows as Array<{ kind: string; event_key: string }>;
const optRows = async (e164: string) => (await db.admin.query("SELECT status, source, evidence_ref FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, optOutHash(TENANT_A, "whatsapp", e164)])).rows as Array<{ status: string; source: string; evidence_ref: string }>;

beforeAll(async () => {
  db = await startCommsDb("g1stp");
  // Marginen 0 = ren sekvensmodell (en START løfter alt med lavere sekvens): denne testen legger inn en STOP og straks en START og forventer at START løfter. Tie-marginen (STOP vinner innenfor 5 s) er bevist i `stop-start-overlap.test.ts`.
  store = new CommsStore(db.app, clock, { startTieMarginMs: 0 });
  const graph = new ConversationGraphService(db.app);
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
    if (`wa:msg:${mid}`.length > 200) expect(rows[0]!.evidence_ref).toBe(evidenceRefFor(`wa:msg:${mid}`));
    expect(await eventRows(`wa:msg:${mid}`)).toEqual([{ kind: "opt_out", event_key: `wa:msg:${mid}` }]);
    // gjenspilling av samme levering: duplikat, ingen ny avmelding, fortsatt avmeldt
    const again = await service.handle("meta", metaReq(waStop(digits(from), mid)));
    expect(again.body).toMatchObject({ events: { inserted: 0, duplicates: 1, opt_outs: 0 } });
    expect(await opted(from)).toBe(true);
  });
});

describe("B-H2: feil i avmeldingen ruller tilbake hele hendelsen (retry behandles på nytt, aldri en «duplikat» uten avmelding)", () => {
  it("avmeldings-INSERT feiler (simulert via DB-trigger): leveringen gir feil, INGEN dedupe-rad og ingen avmelding; retry samme levering registrerer STOP", async () => {
    await db.admin.query(`
      CREATE FUNCTION g1_fail_optout() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.evidence_ref LIKE '%FAILME%' THEN RAISE EXCEPTION 'simulert feil i avmeldingssteget'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER g1_fail_optout BEFORE INSERT ON comms_recipient_opt_outs FOR EACH ROW EXECUTE FUNCTION g1_fail_optout();`);
    const from = phone();
    const mid = "wamid.FAILME-retry-1";
    const key = `wa:msg:${mid}`;
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
