import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommsWebhookService, WEBHOOK_MAX_BYTES, WEBHOOK_MAX_BYTES_BY_PROVIDER, WEBHOOK_SECRET_REFS, optOutHash, type CommsWebhookProvider } from "@jarvis/comms";
import { authorizeAll, startChain, type Chain } from "../../../modules/comms/test/support/chain.ts";
import { TENANT_A } from "../../../modules/comms/test/support/harness.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-1, JARVIS-112 d): en GYLDIG, korrekt signert Meta-batch over 256 KB ga 413 FØR signaturen ble vurdert, og en STOP i den ble aldri registrert (en realistisk Meta-melding er 266-439 B, så bare ~600-980 av de 1000 meldingene
 * i en batch fikk plass; taket på 1000 var praktisk uoppnåelig, og leverandørens retry ga 413 igjen). Nå har hver leverandør sin egen byte-grense FØR signaturen (`WEBHOOK_MAX_BYTES_BY_PROVIDER`): Meta 4 MiB (Metas oppgitte grense er 3 MB, UVERIFISERT mot
 * primærkilden), de andre uendret 256 KB. 413 logges med leverandør og årsakskode (aldri innhold). Signatur-før-parsing og strengere per-IP-grense er uendret.
 */
const META_SECRET = "fake-meta-app-secret";
const PHONE_ID = "109876543210";
const MIB = 1024 * 1024;
let chain: Chain;
let baseUrl = "";
let close: () => Promise<void>;
const warnings: Array<Record<string, unknown>> = [];
let logSinkDown = false;
let n = 0;

const sign = (raw: Buffer, secret = META_SECRET): string => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const wamid = (): string => `wamid.HBgLNDc5OTk5OTk5OTkVAgASGBQ${(++n).toString(16).padStart(8, "0")}${Math.random().toString(36).slice(2, 12)}QzQTdDRjBFOTA1QzE0RjM3RTQxRQA=`;
const msg = (from: string, text: string) => ({ from, id: wamid(), timestamp: String(Math.floor(chain.now().getTime() / 1000)), type: "text", text: { body: text } });
const contact = (from: string) => ({ profile: { name: "Kari Nordmann" }, wa_id: from });
const num = (): string => chain.phone().replace("+", "");
const opted = (digits: string): Promise<boolean> => chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "whatsapp", `+${digits}`));
/** En realistisk Meta-batch (meldinger + contacts-blokk per melding) med STOP som SISTE hendelse. */
function metaBatch(count: number, stopper: string): Buffer {
  const others = Array.from({ length: count - 1 }, () => { const f = num(); return [msg(f, "Hei, har dere åpent i morgen og kan jeg bestille time?"), contact(f)] as const; });
  const messages = [...others.map((o) => o[0]), msg(stopper, "STOPP")];
  const contacts = [...others.map((o) => o[1]), contact(stopper)];
  return Buffer.from(JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "4791000000", phone_number_id: PHONE_ID }, contacts, messages } }] }]
  }));
}
/** En JSON-kropp av NØYAKTIG `size` byte (polstring i ett felt). */
function bodyOfSize(size: number): Buffer {
  const overhead = Buffer.byteLength(JSON.stringify({ pad: "" }));
  return Buffer.from(JSON.stringify({ pad: "x".repeat(size - overhead) }));
}
const post = async (provider: string, raw: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> => {
  const res = await fetch(`${baseUrl}/webhooks/comms/${provider}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw as never });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  chain = await startChain("g1c2b", { JARVIS_COMMS_WEBHOOKS: "slack,meta,twilio,telnyx", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" });
  await authorizeAll(chain, [["whatsapp", PHONE_ID, "meta_whatsapp"]]);
  const service = new CommsWebhookService({
    store: chain.store, graph: chain.graph, config: chain.config, clock: chain.now, warn: (w) => { if (logSinkDown) throw new Error("log sink down"); warnings.push(w); },
    secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META_SECRET : "fake-secret-for-test-0000") }
  });
  const providers = new Set<CommsWebhookProvider>(["slack", "meta", "twilio", "telnyx"]);
  const server = createApiServer({ comms: { webhooks: { service, providers } }, rateLimits: { authPerIpPerMinute: 100000 } } as unknown as ApiDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
}, 240_000);
afterAll(async () => { await close?.(); await chain?.stop(); }, 120_000);

describe("FIX-1: byte-grensen er per leverandør", () => {
  it("Meta 4 MiB; Slack, Twilio og Telnyx uendret 256 KB (grensen er en eksakt tabell, ikke en regel)", () => {
    expect(WEBHOOK_MAX_BYTES).toBe(256 * 1024);
    expect(WEBHOOK_MAX_BYTES_BY_PROVIDER).toEqual({ slack: 256 * 1024, meta: 4 * MIB, twilio: 256 * 1024, telnyx: 256 * 1024 });
  });

  it("en gyldig signert Meta-batch på 1000 meldinger (> 256 KB) med STOP som nr. 1000: HTTP 200 og STOP registrert (før: 413, STOP aldri registrert)", async () => {
    const stopper = num();
    const raw = metaBatch(1000, stopper);
    expect(raw.length, "batchen er større enn den gamle felles grensen").toBeGreaterThan(WEBHOOK_MAX_BYTES);
    expect(raw.length).toBeLessThan(WEBHOOK_MAX_BYTES_BY_PROVIDER.meta);
    const res = await post("meta", raw, { "x-hub-signature-256": sign(raw) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ received: true, events: { received: 1000, opt_outs: 1 } });
    expect(await opted(stopper)).toBe(true);
  }, 120_000);

  it("Meta: nøyaktig 4 MiB passerer grensen (videre til signaturkontrollen: 401 for feil signatur), 4 MiB + 1 byte gir 413 - selv med GYLDIG signatur og uten at tjenesten ser kroppen", async () => {
    const exact = bodyOfSize(4 * MIB);
    expect(exact.length).toBe(4 * MIB);
    expect((await post("meta", exact, { "x-hub-signature-256": "sha256=00" })).status, "på grensen: forbi størrelsesgrensen, avvist på signaturen").toBe(401);
    const over = bodyOfSize(4 * MIB + 1);
    warnings.length = 0;
    const res = await post("meta", over, { "x-hub-signature-256": sign(over) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toMatchObject({ error: "payload_too_large" });
  }, 60_000);

  for (const provider of ["slack", "twilio", "telnyx"] as const) {
    it(`${provider}: nøyaktig 256 KB passerer grensen (aldri 413), 256 KB + 1 byte gir 413 - uendret fra før`, async () => {
      const exact = bodyOfSize(256 * 1024);
      expect((await post(provider, exact)).status, "på grensen").not.toBe(413);
      const over = bodyOfSize(256 * 1024 + 1);
      expect((await post(provider, over)).status).toBe(413);
    }, 60_000);
  }

  it("413 logges med leverandør og årsakskode - aldri innhold, signatur eller kropp", async () => {
    warnings.length = 0;
    const over = Buffer.from(JSON.stringify({ pad: `hemmelig-tekst-${"y".repeat(5 * MIB)}` }));
    expect((await post("meta", over)).status).toBe(413);
    expect((await post("slack", bodyOfSize(256 * 1024 + 10))).status).toBe(413);
    const rejected = warnings.filter((w) => w["msg"] === "comms_webhook_rejected");
    expect(rejected).toEqual([
      { msg: "comms_webhook_rejected", provider: "meta", reason: "payload_too_large" },
      { msg: "comms_webhook_rejected", provider: "slack", reason: "payload_too_large" }
    ]);
    expect(JSON.stringify(warnings)).not.toContain("hemmelig-tekst");
  }, 60_000);

  it("en feil i loggen endrer aldri svaret: 413 forblir 413 selv om logg-sluken kaster", async () => {
    logSinkDown = true;
    try {
      expect((await post("meta", Buffer.alloc(4 * MIB + 5, 0x61))).status).toBe(413);
      expect((await post("twilio", bodyOfSize(256 * 1024 + 5))).status).toBe(413);
    } finally {
      logSinkDown = false;
    }
  }, 60_000);

  it("signaturen vurderes fortsatt FØR kroppen tolkes: en stor Meta-batch (under grensen) med feil signatur gir 401, ingenting skrives til databasen", async () => {
    const before = ((await chain.db.admin.query("SELECT (SELECT count(*) FROM comms_inbound_events)::int AS e, (SELECT count(*) FROM comms_inbound_receipts)::int AS r")).rows[0]) as { e: number; r: number };
    const raw = metaBatch(500, num());
    expect(raw.length).toBeGreaterThan(WEBHOOK_MAX_BYTES / 2);
    const res = await post("meta", raw, { "x-hub-signature-256": sign(raw, "feil-hemmelighet") });
    expect(res.status).toBe(401);
    const after = ((await chain.db.admin.query("SELECT (SELECT count(*) FROM comms_inbound_events)::int AS e, (SELECT count(*) FROM comms_inbound_receipts)::int AS r")).rows[0]) as { e: number; r: number };
    expect(after).toEqual(before);
  }, 60_000);
});
