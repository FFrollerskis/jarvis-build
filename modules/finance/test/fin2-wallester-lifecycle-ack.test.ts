import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { CardService, ProviderResponseInvalidError, WallesterTransport, createRsaJwtSigner, runWallesterSweepForAllTenants, type WallesterCredentials } from "../src/index.ts";

/**
 * WP-FIN2 fiks-runde 1 (FIX-1): Wallester livssyklusverb (activate/block/unblock/close) mot ekte Postgres og den EKTE transporten (stubbet `fetch`). K7 krevde `id` og `status` i PATCH-svaret, men
 * tjenesten bruker kun `status` (id står i URL-en) og transporten sier selv at PATCH-svar kan være tomme: en tom 2xx ga `outcome_unknown` MENS Wallester hadde utført verbet - og NØDBREMSEN
 * (`freeze_card`) ble aldri registrert lokalt (kortet sto `active`). Nå: måltilstanden anvendes alltid ved en gyldig 2xx, `provider_state = 'unconfirmed'` når svaret ikke bærer en status, hendelsen
 * merkes `confirmed: false`, og `sync_card_state` bekrefter etterpå. Et felt som er til stede men ugyldig (eller en kropp som ikke er JSON) er fortsatt `outcome_unknown` og lokal tilstand røres ikke.
 * Fiks-runde 2 (FIX-C, nederst): bekreftelsen kommer IKKE like for alle verb - nattsveipet henter ikke lukkede kort, så en `close` med tom 2xx må bekreftes manuelt med `sync_card_state` (kjent begrensning, pinnet her).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-fin2-lifecycle";
const APP_ROLE = "jarvis_fin2_lifecycle";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const creds: WallesterCredentials = { baseUrl: "https://wallester.test", apiKey: ["api", "key", "fixture"].join("-"), sign: createRsaJwtSigner(privateKey), accountId: "wacc-life", environment: "sandbox" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fin2-lifecycle-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${APP_ROLE}`);
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'FIN2 lifecycle', 'business')`);
  appPool = createPool({ ...base, user: APP_ROLE, password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);
afterEach(() => vi.unstubAllGlobals());

const service = (configuredTenant: string = TENANT): CardService => new CardService(appPool, { getCredentials: async () => creds }, (c) => new WallesterTransport(c.baseUrl, c.apiKey, c.sign, c.accountId), () => null, () => configuredTenant);
type Verb = "freeze" | "unfreeze" | "activate" | "close";
const VERBS: ReadonlyArray<{ verb: Verb; initial: string; target: string; event: string; path: string }> = [
  { verb: "freeze", initial: "active", target: "frozen", event: "frozen", path: "/block" },
  { verb: "unfreeze", initial: "frozen", target: "active", event: "unfrozen", path: "/unblock" },
  { verb: "activate", initial: "pending_provider", target: "active", event: "activated", path: "/activate" },
  { verb: "close", initial: "active", target: "closed", event: "closed", path: "/close" }
];
const run = (svc: CardService, verb: Verb, cardId: string) =>
  verb === "freeze" ? svc.freezeCard(TENANT, "business", cardId) : verb === "unfreeze" ? svc.unfreezeCard(TENANT, "business", cardId) : verb === "activate" ? svc.activateCard(TENANT, "business", cardId) : svc.closeCard(TENANT, "business", cardId);

async function cardIn(svc: CardService, state: string, tenant: string = TENANT): Promise<{ cardId: string; providerCardId: string }> {
  const card = await svc.createCard(tenant, "business", { idempotency_key: `card-${randomUUID()}`, name: "K", purpose: "P", card_type: "virtual", currency: "EUR" });
  const providerCardId = `wc-${randomUUID().slice(0, 8)}`;
  await adminPool.query("UPDATE provider_cards SET provider_card_id = $2, state = $3, provider_state = 'Active', submitted_at = now() WHERE card_id = $1", [card.card_id, providerCardId, state]);
  return { cardId: card.card_id, providerCardId };
}
const row = async (cardId: string) => (await adminPool.query("SELECT state, provider_state, anomaly_flags FROM provider_cards WHERE card_id = $1", [cardId])).rows[0] as { state: string; provider_state: string; anomaly_flags: string[] };
const events = async (cardId: string) => (await adminPool.query("SELECT event_type, detail FROM card_events WHERE card_id = $1 ORDER BY created_at", [cardId])).rows as Array<{ event_type: string; detail: Record<string, unknown> }>;
function stubWallester(respond: (url: string, method: string) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${String(url)}`); return respond(String(url), init?.method ?? "GET"); });
  return calls;
}

describe("FIX-1: en gyldig 2xx uten status anvender ALLTID måltilstanden lokalt (provider_state = unconfirmed)", () => {
  const EMPTY: ReadonlyArray<[string, (pid: string) => Response]> = [
    ["tom kropp", () => new Response("", { status: 200 })],
    ["204 uten kropp", () => new Response(null, { status: 204 })],
    ["{}", () => new Response("{}", { status: 200 })],
    ["JSON null", () => new Response("null", { status: 200 })],
    ["kun {id}", (pid) => new Response(JSON.stringify({ id: pid }), { status: 200 })],
    ["wrapper {card:{id,status}}", (pid) => new Response(JSON.stringify({ card: { id: pid, status: "Blocked" } }), { status: 200 })]
  ];
  for (const { verb, initial, target, event, path } of VERBS) {
    for (const [label, body] of EMPTY) {
      it(`${verb}: ${label} -> kortet står ${target}, provider_state=unconfirmed, hendelse ${event} (confirmed:false), ingen flagg`, async () => {
        const svc = service();
        const { cardId, providerCardId } = await cardIn(svc, initial);
        const calls = stubWallester(() => body(providerCardId));
        const result = await run(svc, verb, cardId);
        expect(result.state).toBe(target);
        expect(calls.filter((c) => c.startsWith("PATCH") && c.endsWith(path))).toHaveLength(1);
        expect(await row(cardId)).toEqual({ state: target, provider_state: "unconfirmed", anomaly_flags: [] });
        const ev = (await events(cardId)).map((e) => e.event_type);
        expect(ev).toEqual(["requested", event]);
        expect((await events(cardId))[1]!.detail).toMatchObject({ provider_state: "unconfirmed", confirmed: false });
      });
    }
    it(`${verb}: svar med status (som før) -> provider_state = leverandørens status, ingen confirmed-markør`, async () => {
      const svc = service();
      const { cardId, providerCardId } = await cardIn(svc, initial);
      stubWallester(() => new Response(JSON.stringify({ id: providerCardId, status: "Blocked" }), { status: 200 }));
      expect((await run(svc, verb, cardId)).state).toBe(target);
      expect((await row(cardId)).provider_state).toBe("Blocked");
      expect((await events(cardId))[1]!.detail).toEqual({ provider_state: "Blocked" });
    });
  }

  it("B-K8-4: freeze_card med TOM 2xx gir lokal `frozen`, aldri `active`; en gjentatt freeze er en no-op uten nytt leverandørkall", async () => {
    const svc = service();
    const { cardId } = await cardIn(svc, "active");
    const calls = stubWallester(() => new Response("", { status: 200 }));
    expect((await svc.freezeCard(TENANT, "business", cardId)).state).toBe("frozen");
    expect((await svc.freezeCard(TENANT, "business", cardId)).state).toBe("frozen");
    expect(calls).toHaveLength(1);
  });

  it("sync_card_state bekrefter etterpå: provider_state erstattes av leverandørens status; ingen konflikt når statusen stemmer", async () => {
    const svc = service();
    const { cardId, providerCardId } = await cardIn(svc, "active");
    stubWallester(() => new Response("", { status: 200 }));
    await svc.freezeCard(TENANT, "business", cardId);
    expect((await row(cardId)).provider_state).toBe("unconfirmed");
    stubWallester(() => new Response(JSON.stringify({ id: providerCardId, status: "Blocked" }), { status: 200 }));
    const synced = await svc.syncCardState(TENANT, "business", cardId);
    expect(synced.state).toBe("frozen");
    expect(await row(cardId)).toEqual({ state: "frozen", provider_state: "Blocked", anomaly_flags: [] });
  });

  it("sync_card_state oppdager at verbet IKKE ble utført hos Wallester (leverandøren sier fortsatt Active): leverandørsannheten vinner, aldri en skjult avvikelse", async () => {
    const svc = service();
    const { cardId, providerCardId } = await cardIn(svc, "active");
    stubWallester(() => new Response("{}", { status: 200 }));
    await svc.freezeCard(TENANT, "business", cardId);
    stubWallester(() => new Response(JSON.stringify({ id: providerCardId, status: "Active" }), { status: 200 }));
    const synced = await svc.syncCardState(TENANT, "business", cardId);
    expect(synced.state).toBe("active");
    expect((await row(cardId)).provider_state).toBe("Active");
  });
});

describe("FIX-1: til stede-men-ugyldig er fortsatt `outcome_unknown` og lokal tilstand røres ikke", () => {
  for (const [label, body, code] of [
    ["status feil type", () => new Response(JSON.stringify({ status: 5 }), { status: 200 }), "status_wrong_type"],
    ["id feil type", () => new Response(JSON.stringify({ id: 12, status: "Blocked" }), { status: 200 }), "id_wrong_type"],
    ["ikke JSON (HTML 200 fra en mellomtjener)", () => new Response("<html>502</html>", { status: 200 }), "body_not_json"],
    ["liste", () => new Response("[]", { status: 200 }), "body_wrong_type"]
  ] as const) {
    it(`freeze: ${label} -> ${code}; kortet står uendret active (kun requested-hendelsen)`, async () => {
      const svc = service();
      const { cardId } = await cardIn(svc, "active");
      stubWallester(() => body());
      const err = await svc.freezeCard(TENANT, "business", cardId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderResponseInvalidError);
      expect((err as ProviderResponseInvalidError).code).toBe(code);
      expect((err as Error).message).toMatch(/^outcome_unknown:/);
      expect((await row(cardId)).state).toBe("active");
      expect((await events(cardId)).map((e) => e.event_type)).toEqual(["requested"]);
    });
  }
});

// === Fiks-runde 2 / FIX-C: `close` med tom 2xx bekreftes IKKE av nattsveipet ================================================================
describe("FIX-C (fiks-runde 2): et lokalt lukket kort (close med tom 2xx) hentes ikke av nattsveipet - manuell sync_card_state er bekreftelsen", () => {
  const SWEEP_TENANT = "tenant-fin2-lifecycle-sweep"; // egen tenant: sveipet går over ALLE kort i tenanten, så kortene fra de andre testene ville støyet
  const sweepPool = { query: async () => ({ rows: [{ tenant_id: SWEEP_TENANT }] }) } as unknown as pg.Pool; // `listBusinessTenantIds` (som i sveiptestene i apps/api)
  const idIn = (url: string): string => /\/v1\/cards\/([^/?]+)/.exec(url)?.[1] ?? "";
  const respondCard = (status: string) => (url: string): Response =>
    /\/authorizations/.test(url) ? new Response(JSON.stringify({ authorizations: [] }), { status: 200 })
    : /\/transactions/.test(url) ? new Response(JSON.stringify({ transactions: [] }), { status: 200 })
    : new Response(JSON.stringify({ id: idIn(url), status }), { status: 200 });

  beforeAll(async () => {
    await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'FIN2 lifecycle sweep', 'business')", [SWEEP_TENANT]);
  });

  /** Et aktivt kort lukkes med TOM 2xx: lokalt `closed` (terminal) + `provider_state = 'unconfirmed'`, ingen flagg. */
  async function closedUnconfirmed(svc: CardService): Promise<{ cardId: string; providerCardId: string }> {
    const card = await cardIn(svc, "active", SWEEP_TENANT);
    stubWallester(() => new Response("", { status: 200 }));
    expect((await svc.closeCard(SWEEP_TENANT, "business", card.cardId)).state).toBe("closed");
    expect(await row(card.cardId)).toEqual({ state: "closed", provider_state: "unconfirmed", anomaly_flags: [] }); // forutsetningen for testene under
    return card;
  }

  it("nattsveipet spør IKKE Wallester om det lukkede kortet og setter ingen flagg (selv om Wallester sier Active), mens et aktivt kort i samme tenant synkes (kontroll)", async () => {
    const svc = service(SWEEP_TENANT);
    const closed = await closedUnconfirmed(svc);
    const control = await cardIn(svc, "active", SWEEP_TENANT);
    const calls = stubWallester((url) => respondCard("Active")(url));
    const result = await runWallesterSweepForAllTenants(sweepPool, svc);
    expect(calls.some((c) => c.includes(control.providerCardId))).toBe(true); // kontroll: sveipet kjørte og hentet det aktive kortet
    expect(calls.filter((c) => c.includes(closed.providerCardId))).toEqual([]); // ...men aldri det lukkede
    expect(result[SWEEP_TENANT]?.cards_state_synced).toBe(1);
    expect(await row(closed.cardId)).toEqual({ state: "closed", provider_state: "unconfirmed", anomaly_flags: [] }); // KJENT BEGRENSNING (FINANCE_D_CHAIN §11.1/§11.6): ingen flagg før noen kjører sync_card_state
  });

  it("manuell sync_card_state på det lokalt lukkede kortet: Wallester sier Active -> CARD_PROVIDER_STATE_CONFLICT + hendelsen provider_state_conflict; kortet gjenopplives ALDRI", async () => {
    const svc = service(SWEEP_TENANT);
    const { cardId } = await closedUnconfirmed(svc);
    stubWallester((url) => respondCard("Active")(url));
    const synced = await svc.syncCardState(SWEEP_TENANT, "business", cardId);
    expect(synced.state).toBe("closed");
    expect(await row(cardId)).toEqual({ state: "closed", provider_state: "Active", anomaly_flags: ["CARD_PROVIDER_STATE_CONFLICT"] });
    const conflict = (await events(cardId)).find((e) => e.event_type === "provider_state_conflict");
    expect(conflict?.detail).toMatchObject({ canonical_state: "closed", provider_state: "Active" });
  });

  it("manuell sync_card_state: Wallester sier Closed -> bekreftet (provider_state = Closed), ingen flagg og ingen konflikthendelse", async () => {
    const svc = service(SWEEP_TENANT);
    const { cardId } = await closedUnconfirmed(svc);
    stubWallester((url) => respondCard("Closed")(url));
    expect((await svc.syncCardState(SWEEP_TENANT, "business", cardId)).state).toBe("closed");
    expect(await row(cardId)).toEqual({ state: "closed", provider_state: "Closed", anomaly_flags: [] });
    expect((await events(cardId)).map((e) => e.event_type)).not.toContain("provider_state_conflict");
  });

  it("hvorfor sveip-utvidelsen er DEFERRED: Closing (verifisert mellomtilstand) avbildes til frozen, så en manuell sync på et lokalt lukket kort gir også en konflikt-flagg; leverandørfakta er unverified", async () => {
    const svc = service(SWEEP_TENANT);
    const { cardId } = await closedUnconfirmed(svc);
    stubWallester((url) => respondCard("Closing")(url));
    await svc.syncCardState(SWEEP_TENANT, "business", cardId);
    expect(await row(cardId)).toEqual({ state: "closed", provider_state: "Closing", anomaly_flags: ["CARD_PROVIDER_STATE_CONFLICT"] });
  });
});
