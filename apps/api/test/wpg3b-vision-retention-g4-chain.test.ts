import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { LocalHashEmbedding } from "@jarvis/memory";
import { retireSignalSituations, signalSituationWindowDays } from "@jarvis/situations";
import { VisionRetentionConfirmationRequiredError, VisionService } from "@jarvis/vision";
import { OWNER, startG4Db, TENANT_A, type G4Db } from "../../../modules/situations/test/support/wpg4-db.ts";
import { createSituationSignalsWiring } from "../src/situation-signals-wiring.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";
import { buildVisionRuntime, type VisionRuntime } from "../src/vision-runtime.ts";

/**
 * WP-G3b (D-485), fiks-runde 1 (F1 + F2): G4-KJEDEN ende-til-ende. Eierens retensjonsrute (`/vision/retention/set`: ekte server, ekte `VisionService`, ekte Postgres, kjøretiden bygd av `buildVisionRuntime` slik main.ts gjør) ->
 * `createSituationSignalsWiring` (ekte komposisjon) -> `runner.tick()` -> `retireSignalSituations`.
 *
 * Kjeden: vinduene er forankret ved skriving (lagrede hendelser, bilder og inventar slettes ikke av en endring), men signalsituasjoner i domenet `vision` (en AVLEDET tabell, kun med JARVIS_SITUATION_SIGNALS=on) ryddes ved sveipet
 * mot `min(JARVIS_SITUATION_LOG_RETENTION_DAYS, retention_days)` (uten rad: grunnvinduet selv). En forkorting kan derfor slette eldre avledede situasjoner (også åpne og `security_alert`; tilbakemeldinger kaskade-slettes) - derfor typet
 * bekreftelse, og den må regnes mot DET sveipet bruker, ikke mot rutens standard (30): F1 (grunnvindu over 30).
 *  A. kjeden slik den er (standard grunnvindu): hva som slettes og hva som består, og at 409/200 sier at eksisterende avledede situasjoner kan bli slettet (F2);
 *  B. F1: grunnvindu over 30 (S3);
 *  C. flagg AV: signalbryteren av gir ingen avledet regel og ingen nye felt (identisk med før);
 *  D. orakel: alle overganger (grunnvindu x forrige x ny) mot det EKTE sveipet - ingen ekstra sletting uten bekreftelse, ingen unødvendig bekreftelse;
 *  E. kildevakter: regelen har ÉN definisjon (sveipet bruker den), og main.ts gir kjøretiden verdien fra den allerede parsede wiringen (ingen ny `process.env`-lesing).
 */
let db: G4Db;
let vision: VisionService;
const closers: Array<() => Promise<void> | void> = [];
const urls = new Map<string, string>();
const DAY = 86_400_000;
const GRANT = "owner-signed";
const grantsMap = new Map<string, Record<string, string>>([
  [GRANT, { person_id: OWNER, tenant_id: TENANT_A, channel: "web", auth_strength: "signed", session_id: "s-o", memory_space: "home", device_id: "web-o" }],
  ["owner-personal", { person_id: OWNER, tenant_id: TENANT_A, channel: "web", auth_strength: "signed", session_id: "s-p", memory_space: "personal", device_id: "web-p" }]
]);
const ownerIdentity = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "home", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as IdentityContext;

function wiringFor(env: Record<string, string>, visionDep: unknown = vision) {
  return createSituationSignalsWiring({
    env: env as NodeJS.ProcessEnv,
    pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses,
    gateway: { execute: async () => ({ ok: false, reason: "unused" }), register: () => undefined, get: () => undefined } as never,
    modelGateway: { complete: async () => { throw new Error("unused"); } } as never,
    ownerIdentity, ownerTenant: TENANT_A, ownerPersonId: OWNER,
    incidents: { listIncidents: async () => [] },
    vision: visionDep as never, // standard: PRODUKSJONENS objekt (main.ts gir `visionService`): wiringen kaller `getRetentionPolicy` på den
    health: { getRecentMetrics: async () => [] },
    haTransport: { invoke: async () => ({}) } as never,
    killSwitch: { isActiveDurable: async () => false }
  });
}
/** Signalsveipet slik main.ts kobler det (en NY løper = en ny «daglig» vurdering). */
const make = (env: Record<string, string> = {}) => wiringFor({ JARVIS_SITUATION_SIGNALS: "on", ...env });

/** API-serveren med kjøretiden bygd av `buildVisionRuntime` og G4-regelen fra wiringen med SAMME miljø - nøyaktig sammensetningen i main.ts (`signalSituationWindowDays` bare når wiringen har en). */
async function serve(env: Record<string, string>): Promise<string> {
  const key = JSON.stringify(env);
  const cached = urls.get(key);
  if (cached !== undefined) return cached;
  const wiring = wiringFor(env);
  const runtime = buildVisionRuntime({
    pool: db.appPool, env: { JARVIS_VISION_ENABLED: "on" } as NodeJS.ProcessEnv, vision, gateway: { complete: async () => ({ text: "{}", provider: "local_vision", model: "m" }) },
    memoryEmbedding: new LocalHashEmbedding(), devices: { approverFor: async () => undefined }, ownerTenantId: TENANT_A, secrets: { get: async () => null },
    ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } },
    ...(wiring.visionSituationWindowDays !== null ? { signalSituationWindowDays: wiring.visionSituationWindowDays } : {})
  }) as VisionRuntime;
  closers.push(() => runtime.stop());
  const server = createApiServer({
    grants: { verify: async (t: string) => (grantsMap.has(t) ? { ok: true, grant: grantsMap.get(t) } : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    owner: { tenant_id: TENANT_A, person_id: OWNER },
    ownerGate: (id: IdentityContext) => id.person_id === OWNER && id.tenant_id === TENANT_A && id.delegation_id === undefined,
    vision: runtime.api
  } as unknown as ApiDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  urls.set(key, url);
  return url;
}

beforeAll(async () => {
  db = await startG4Db("g3brg4");
  vision = new VisionService(db.appPool);
}, 240_000);
afterAll(async () => {
  for (const c of closers) await c();
  await db?.stop();
}, 120_000);
beforeEach(async () => {
  await db.reset();
  await db.adminPool.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1`, [TENANT_A]);
  auditBase = (await allAuditPayloads()).length;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testens svar-JSON er bevisst løst typet
type Json = Record<string, any>;
const call = async (env: Record<string, string>, path: string, body: Record<string, unknown>, token = GRANT): Promise<{ status: number; body: Json; text: string }> => {
  const res = await fetch(`${await serve(env)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: token, ...body }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Json, text };
};
const ENV_ON: Record<string, string> = { JARVIS_SITUATION_SIGNALS: "on" };
const ENV_90: Record<string, string> = { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_LOG_RETENTION_DAYS: "90" };
const setOn = (env: Record<string, string>, body: Record<string, unknown>, token = GRANT) => call(env, "/vision/retention/set", body, token);
const getOn = (env: Record<string, string>, token = GRANT) => call(env, "/vision/retention/get", {}, token);
const CONFIRM = { confirm: true, confirm_memory_space: "home" };
const rowOf = async (): Promise<Json | undefined> => (await db.adminPool.query(`SELECT retention_days, snapshot_retention_days FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = 'home'`, [TENANT_A])).rows[0] as Json | undefined;
/** Revisjonsradene siden testen startet (`audit_events` er append-only: ingenting slettes mellom testene, så hver test teller fra et utgangspunkt). */
let auditBase = 0;
const allAuditPayloads = async (): Promise<Json[]> => (await db.adminPool.query(`SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id`, [TENANT_A])).rows.map((r) => (r as { payload: Json }).payload);
const auditPayloads = async (): Promise<Json[]> => (await allAuditPayloads()).slice(auditBase);

async function seed(id: string, space: string, domain: string, key: string, ageDays: number, status = "resolved"): Promise<void> {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  await db.adminPool.query(
    `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason, status, opened_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'inform', 'normal', 'test', $6, $7, $7)`,
    [id, TENANT_A, space, domain, key, status, at]
  );
  await db.adminPool.query(
    `INSERT INTO situation_feedback (feedback_id, tenant_id, memory_space_id, situation_id, rule_key, verdict, actor_person_id) VALUES ($1,$2,$3,$4,'vision:motion_detected','useful',$5)`,
    [`fb-${id}`, TENANT_A, space, id, OWNER]
  );
}
async function seedDecision(situationId: string): Promise<void> {
  await db.adminPool.query(
    `INSERT INTO decision_log (decision_id, tenant_id, memory_space_id, title, rationale, decision_maker, related_situation_id, owner_person_id, created_by) VALUES ($1,$2,'home','t','r','owner',$3,$4,$4)`,
    [`dec-${situationId}`, TENANT_A, situationId, OWNER]
  );
}
const exists = async (id: string): Promise<boolean> => (await db.adminPool.query(`SELECT 1 FROM situations WHERE situation_id = $1`, [id])).rowCount === 1;
const feedbackExists = async (id: string): Promise<boolean> => (await db.adminPool.query(`SELECT 1 FROM situation_feedback WHERE situation_id = $1`, [id])).rowCount === 1;

const SEEDS: Array<[string, string, string, string, number, string?]> = [
  ["v3", "home", "vision", "vision:motion_detected:camera.a:1", 3],
  ["v10", "home", "vision", "vision:person_present:camera.a:2", 10],
  ["v10open", "home", "vision", "vision:doorbell_event:camera.a:3", 10, "open"],
  ["v15sec", "home", "vision", "vision:security_alert:camera.a:4", 15],
  ["v20pkg", "home", "vision", "vision:package_detected:camera.a:5", 20],
  ["v40", "home", "vision", "vision:motion_detected:camera.a:6", 40],
  ["v15decision", "home", "vision", "vision:motion_detected:camera.a:7", 15],
  ["h15", "home", "home", "home:opening:binary_sensor.d@2026-11-10T00:00:00.000Z", 15],
  ["hl15", "health", "health", "health:resting_heart_rate:above:2026-11-10", 15]
];
async function survivors(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id] of SEEDS) out[id] = `${(await exists(id)) ? "består" : "SLETTET"}${(await feedbackExists(id)) ? "" : " (+feedback kaskade-slettet)"}`;
  return out;
}

describe("A. kjeden rute -> signalsveip (standard grunnvindu 30): hva som slettes, og at kontrakten sier det (F2)", () => {
  it("kontroll: uten rute (standard, ingen rad) slettes kun vision-situasjoner eldre enn 30 døgn", async () => {
    for (const s of SEEDS) await seed(...s);
    await make().runner!.tick();
    const r = await survivors();
    expect(r["v40"]).toContain("SLETTET");
    expect(r["v20pkg"]).toBe("består");
    expect(r["v10"]).toBe("består");
  });

  it("forkorting 30 -> 7 via RUTEN: 409 sier at EKSISTERENDE avledede situasjoner kan slettes, med bekreftelse slettes de eldre enn det nye vinduet (også åpne og `security_alert`, tilbakemeldinger kaskade-slettes); hjem, helse og beslutningsreferert består", async () => {
    for (const s of SEEDS) await seed(...s);
    await seedDecision("v15decision");
    const denied = await setOn(ENV_ON, { retention_days: 7, snapshot_retention_days: null });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: "confirmation_required", reason: "confirm_true_and_confirm_memory_space_required", shortened: ["retention_days"], confirm_memory_space_required: "home", affects_existing: ["signal_situations"] });
    expect(await rowOf()).toBeUndefined();
    await make().runner!.tick();
    expect((await survivors())["v10"]).toBe("består"); // avvist forkorting: ingenting slettet utover standarden
    const ok = await setOn(ENV_ON, { retention_days: 7, snapshot_retention_days: null, ...CONFIRM });
    expect(ok.status).toBe(200);
    expect(ok.body["data"]).toMatchObject({ changed: true, shortened: ["retention_days"], retention: { retention_days: 7, applies_to: "new_records", affects_existing: ["signal_situations"] } });
    const tick = await make().runner!.tick();
    expect(tick).toMatchObject({ status: "ok", retention_failures: 0 });
    const r = await survivors();
    expect(r["v10"]).toContain("SLETTET");
    expect(r["v10open"]).toContain("SLETTET"); // også den ÅPNE
    expect(r["v15sec"]).toContain("SLETTET"); // også sikkerhetsvarselet
    expect(r["v20pkg"]).toContain("SLETTET");
    expect(r["v40"]).toContain("SLETTET");
    expect(r["v3"]).toBe("består");
    expect(r["v15decision"]).toBe("består"); // referert fra en beslutning
    expect(r["h15"]).toBe("består"); // hjem rammes ikke
    expect(r["hl15"]).toBe("består"); // helse rammes ikke
    expect((await auditPayloads()).at(-1)).toMatchObject({ shortened: ["retention_days"], confirmed: true, affects_existing: ["signal_situations"] });
  });

  it("get og set (uten forkorting) oppgir at vinduene også kan påvirke eksisterende avledede situasjoner - ellers (signalbryteren AV) finnes ikke feltet", async () => {
    const read = await getOn(ENV_ON);
    expect(read.body["data"]["retention"]).toMatchObject({ applies_to: "new_records", affects_existing: ["signal_situations"] });
    const written = await setOn(ENV_ON, { retention_days: 45, snapshot_retention_days: null });
    expect(written.status).toBe(200);
    expect(written.body["data"]["retention"]["affects_existing"]).toEqual(["signal_situations"]);
    expect(written.body["data"]["shortened"]).toEqual([]);
    expect((await auditPayloads()).at(-1)).not.toHaveProperty("affects_existing"); // ingen forkorting: ingenting å varsle om i revisjonen
  });

  it("forlengelse (365) gir IKKE lengre levetid for avledede situasjoner: sveipet tar `min` mot grunnvinduet (30) - kontrakten sier `new_records` for tabellene og `affects_existing` for situasjonene", async () => {
    await seed("x40", "home", "vision", "vision:motion_detected:camera.a:1", 40);
    const res = await setOn(ENV_ON, { retention_days: 365, snapshot_retention_days: null });
    expect(res.status).toBe(200);
    expect(res.body["data"]["retention"]).toMatchObject({ retention_days: 365, applies_to: "new_records", affects_existing: ["signal_situations"] });
    await make().runner!.tick();
    expect(await exists("x40")).toBe(false);
  });

  it("en rad satt via en annen space-grant (personal) påvirker ikke hjem-rommets avledede situasjoner (sveipet leser raden for hjem-rommet)", async () => {
    await seed("y10", "home", "vision", "vision:motion_detected:camera.a:1", 10);
    const res = await setOn(ENV_ON, { retention_days: 7, snapshot_retention_days: null, confirm: true, confirm_memory_space: "personal" }, "owner-personal");
    expect(res.status).toBe(200);
    await make().runner!.tick();
    expect(await exists("y10")).toBe(true);
  });

  it("raden består selv om vision-flagget slås av, og driver fortsatt signalsveipet (ingen vision-rute nødvendig)", async () => {
    await seed("z10", "home", "vision", "vision:motion_detected:camera.a:1", 10);
    await vision.setRetentionPolicy(TENANT_A, "home", { retention_days: 7 }); // som om den ble satt mens flagget var på
    await make().runner!.tick(); // wiringen bygges uten noe vision-ruteflagg: kun signalbryteren
    expect(await exists("z10")).toBe(false);
  });
});

describe("B. F1: grunnvinduet (JARVIS_SITUATION_LOG_RETENTION_DAYS) er over rutens standard 30", () => {
  const AGED: Array<[string, string, string, string, number]> = [
    ["w40", "home", "vision", "vision:motion_detected:camera.a:1", 40],
    ["w60", "home", "vision", "vision:person_present:camera.a:2", 60],
    ["w80", "home", "vision", "vision:security_alert:camera.a:3", 80]
  ];
  const left = async (): Promise<boolean[]> => [await exists("w40"), await exists("w60"), await exists("w80")];

  it("S3: grunnvindu 90 og ingen rad: kontroll - uten rutekall overlever alle; å sette 31 uten bekreftelse er en FORKORTING (90 -> 31) -> 409, raden skrives ikke og ingenting slettes", async () => {
    for (const s of AGED) await seed(...s);
    await make(ENV_90).runner!.tick();
    expect(await left()).toEqual([true, true, true]);
    const res = await setOn(ENV_90, { retention_days: 31, snapshot_retention_days: null });
    expect(res.status, res.text).toBe(409);
    expect(res.body).toMatchObject({ error: "confirmation_required", shortened: ["retention_days"], confirm_memory_space_required: "home", affects_existing: ["signal_situations"] });
    expect(await rowOf()).toBeUndefined();
    expect(await auditPayloads()).toHaveLength(0);
    await make(ENV_90).runner!.tick(); // ny løper = ny daglig vurdering
    expect(await left()).toEqual([true, true, true]);
  });

  it("S3 med bekreftelse: eieren velger forkortingen bevisst (200, `shortened: [retention_days]`), og først da slettes 40-, 60- og 80-døgnssituasjonene av neste sveip", async () => {
    for (const s of AGED) await seed(...s);
    const res = await setOn(ENV_90, { retention_days: 31, snapshot_retention_days: null, ...CONFIRM });
    expect(res.status, res.text).toBe(200);
    expect(res.body["data"]).toMatchObject({ changed: true, shortened: ["retention_days"], retention: { retention_days: 31 } });
    expect(await rowOf()).toMatchObject({ retention_days: 31 });
    await make(ENV_90).runner!.tick();
    expect(await left()).toEqual([false, false, false]);
    expect((await auditPayloads()).at(-1)).toMatchObject({ retention_days: 31, shortened: ["retention_days"], confirmed: true, affects_existing: ["signal_situations"] });
  });

  it("grunnvindu 90: en første setting LIK standarden (30, null) er også en forkorting (90 -> 30) og krever bekreftelse; å sette 90 eller 365 uten rad endrer ikke det avledede vinduet og krever ingen", async () => {
    expect((await setOn(ENV_90, { retention_days: 30, snapshot_retention_days: null })).status).toBe(409);
    expect(await rowOf()).toBeUndefined();
    const same = await setOn(ENV_90, { retention_days: 90, snapshot_retention_days: null });
    expect(same.status, same.text).toBe(200);
    expect(same.body["data"]["shortened"]).toEqual([]);
    const longer = await setOn(ENV_90, { retention_days: 365, snapshot_retention_days: null });
    expect(longer.status, longer.text).toBe(200);
    expect(longer.body["data"]["shortened"]).toEqual([]);
  });

  it("grunnvindu 90 og en rad på 40: å heve til 60 forlenger det avledede vinduet (ingen bekreftelse) og sveipet beholder situasjoner opp til 60 døgn; å senke til 20 krever bekreftelse", async () => {
    await vision.setRetentionPolicy(TENANT_A, "home", { retention_days: 40 });
    await seed("e50", "home", "vision", "vision:motion_detected:camera.a:1", 50);
    await seed("e70", "home", "vision", "vision:motion_detected:camera.a:2", 70);
    const up = await setOn(ENV_90, { retention_days: 60, snapshot_retention_days: null });
    expect(up.status, up.text).toBe(200);
    expect(up.body["data"]["shortened"]).toEqual([]);
    await make(ENV_90).runner!.tick();
    expect([await exists("e50"), await exists("e70")]).toEqual([true, false]);
    expect((await setOn(ENV_90, { retention_days: 20, snapshot_retention_days: null })).status).toBe(409);
  });

  it("grunnvindu 90 og en rad på 100 (satt utenom ruten): 95 er kortere enn raden (vanlig bekreftelse), men det avledede vinduet er uendret - 409 uten `affects_existing`", async () => {
    await vision.setRetentionPolicy(TENANT_A, "home", { retention_days: 100 });
    const res = await setOn(ENV_90, { retention_days: 95, snapshot_retention_days: null });
    expect(res.status).toBe(409);
    expect(res.body["shortened"]).toEqual(["retention_days"]);
    expect(res.body).not.toHaveProperty("affects_existing");
  });

  it("kun bildevinduet forkortes (hendelsesvinduet uendret) under grunnvindu 90: bekreftelse for bildene, men ingen avledet advarsel", async () => {
    expect((await setOn(ENV_90, { retention_days: 90, snapshot_retention_days: 30 })).status).toBe(200);
    const res = await setOn(ENV_90, { retention_days: 90, snapshot_retention_days: 3 });
    expect(res.status).toBe(409);
    expect(res.body["shortened"]).toEqual(["snapshot_retention_days"]);
    expect(res.body).not.toHaveProperty("affects_existing");
  });

  it("grunnvinduet parses som sveipet gjør (ugyldig verdi -> standard 30): `abc` og 3 (under minimum 7) gir samme regel som uten verdi", async () => {
    for (const bad of ["abc", "3", "999", ""]) {
      await db.adminPool.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1`, [TENANT_A]);
      const env = { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_LOG_RETENTION_DAYS: bad };
      const res = await setOn(env, { retention_days: 31, snapshot_retention_days: null });
      expect(res.status, `grunnvindu «${bad}»: ${res.text}`).toBe(200); // 30 -> 30: ingen avledet forkorting
      expect(res.body["data"]["shortened"]).toEqual([]);
    }
  });
});

describe("C. signalbryteren AV: ingen avledet regel, ingen nye felt - identisk med før", () => {
  const OFF: Record<string, string> = {};

  it("wiringen gir ingen funksjon uten JARVIS_SITUATION_SIGNALS=on (heller ikke med underflagg), og kjøretiden får ikke feltet", async () => {
    for (const env of [{}, { JARVIS_SITUATION_VISION: "on" }, { JARVIS_SITUATION_LOG_RETENTION_DAYS: "90" }, { JARVIS_SITUATION_SIGNALS: "true" }]) {
      expect(wiringFor(env).visionSituationWindowDays, JSON.stringify(env)).toBeNull();
    }
    expect(make().visionSituationWindowDays).toBeTypeOf("function");
    const runtime = buildVisionRuntime({
      pool: db.appPool, env: { JARVIS_VISION_ENABLED: "on" } as NodeJS.ProcessEnv, vision, gateway: { complete: async () => ({ text: "{}", provider: "local_vision", model: "m" }) },
      memoryEmbedding: new LocalHashEmbedding(), devices: { approverFor: async () => undefined }, ownerTenantId: TENANT_A, secrets: { get: async () => null },
      ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } }
    }) as VisionRuntime;
    try {
      expect("signalSituationWindowDays" in runtime.api).toBe(false);
    } finally {
      runtime.stop();
    }
  });

  it("uten kamerapolicy fra tjenesten (`getRetentionPolicy` utelatt: sveipet leser ikke raden) er det avledede vinduet ALLTID grunnvinduet - raden kan da ikke forkorte noe; med policyen følger vinduet raden", () => {
    const env = { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_LOG_RETENTION_DAYS: "90" };
    const without = wiringFor(env, { getRecentEvents: async () => [] }).visionSituationWindowDays!;
    expect([null, 1, 31, 90, 365].map(without)).toEqual([90, 90, 90, 90, 90]);
    const withPolicy = wiringFor(env).visionSituationWindowDays!;
    expect([null, 1, 31, 90, 365].map(withPolicy)).toEqual([90, 1, 31, 90, 90]);
  });

  it("uten signalregelen er 31 en forlengelse (200, ingen forkorting), ingen svar eller 409 har `affects_existing`, og revisjonen er uten det", async () => {
    const get = await getOn(OFF);
    expect(get.body["data"]["retention"]).not.toHaveProperty("affects_existing");
    const set31 = await setOn(OFF, { retention_days: 31, snapshot_retention_days: null });
    expect(set31.status).toBe(200);
    expect(set31.body["data"]["shortened"]).toEqual([]);
    expect(set31.body["data"]["retention"]).not.toHaveProperty("affects_existing");
    const denied = await setOn(OFF, { retention_days: 7, snapshot_retention_days: null });
    expect(denied.status).toBe(409);
    expect(denied.body).not.toHaveProperty("affects_existing");
    const ok = await setOn(OFF, { retention_days: 7, snapshot_retention_days: null, ...CONFIRM });
    expect(ok.status).toBe(200);
    expect(ok.body["data"]["retention"]).not.toHaveProperty("affects_existing");
    for (const payload of await auditPayloads()) expect(payload).not.toHaveProperty("affects_existing");
  });
});

describe("D. orakel mot det EKTE sveipet: grunnvindu x forrige x ny", () => {
  // Aldre som skiller alle vinduene under (1, 7, 30, 31, 90, 365): en situasjon slettes når alderen er over vinduet.
  const AGES = [0.5, 3, 20, 30.5, 60, 200, 400];
  const ids = AGES.map((a) => `m${a}`);
  const memo = new Map<string, string[]>();
  /** Hvilke av de seedede situasjonene det ekte sveipet (`retireSignalSituations`) sletter med dette grunnvinduet og denne radverdien. */
  async function deletedBy(base: number, visionDays: number | null): Promise<string[]> {
    const key = `${base}:${visionDays}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    await db.adminPool.query(`DELETE FROM situations WHERE tenant_id = $1`, [TENANT_A]);
    for (const a of AGES) await seed(`m${a}`, "home", "vision", `vision:motion_detected:camera.m:${a}`, a);
    await retireSignalSituations(db.appPool, TENANT_A, "home", { retentionDays: base, visionDays });
    const left = new Set((await db.adminPool.query(`SELECT situation_id FROM situations WHERE tenant_id = $1`, [TENANT_A])).rows.map((r) => (r as { situation_id: string }).situation_id));
    const deleted = ids.filter((id) => !left.has(id));
    memo.set(key, deleted);
    return deleted;
  }

  it("sveipet slettet ulike mengder for ulike vinduer (orakelet er ikke tomt): 7 < 30 < 31 < 90 < 365", async () => {
    const sizes = [] as number[];
    for (const days of [7, 30, 31, 90, 365]) sizes.push((await deletedBy(365, days)).length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it("168 overganger (grunnvindu 7/30/90/365 x 7 forrige x 6 nye): uten bekreftelse skrives aldri en endring som lar sveipet slette MER, og bekreftelse kreves aldri uten at et vindu faktisk blir kortere", async () => {
    let combos = 0, refusedCount = 0, passedCount = 0, derivedOnly = 0;
    const understreng: string[] = [];
    const overstreng: string[] = [];
    for (const base of [7, 30, 90, 365]) {
      const derived = make({ JARVIS_SITUATION_LOG_RETENTION_DAYS: String(base) }).visionSituationWindowDays;
      expect(derived, `base ${base}`).toBeTypeOf("function");
      for (const prev of [null, 1, 7, 30, 31, 90, 365]) {
        for (const next of [1, 7, 30, 31, 90, 365]) {
          combos += 1;
          await db.adminPool.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1`, [TENANT_A]);
          if (prev !== null) await vision.setRetentionPolicy(TENANT_A, "home", { retention_days: prev });
          let refused: VisionRetentionConfirmationRequiredError | null = null;
          try {
            await vision.applyRetentionPolicy(TENANT_A, "home", { retention_days: next, snapshot_retention_days: null }, { actor_person_id: OWNER, confirm_shortening: false, derived_window_days: derived! });
          } catch (err) {
            if (!(err instanceof VisionRetentionConfirmationRequiredError)) throw err;
            refused = err;
          }
          const label = JSON.stringify({ base, prev, next });
          const before = await deletedBy(base, prev);
          const after = await deletedBy(base, next);
          const extra = after.filter((id) => !before.includes(id));
          // den VANLIGE regelen (nye rader): hendelsesvinduet eller det effektive bildevinduet (standard 7, klemt til hendelsene) blir kortere
          const plain = next < (prev ?? 30) || Math.min(7, next) < Math.min(7, prev ?? 30);
          if (refused !== null) {
            refusedCount += 1;
            expect(await rowOf(), `avvist forespørsel skriver ikke ${label}`).toEqual(prev === null ? undefined : { retention_days: prev, snapshot_retention_days: null });
            if (!plain && extra.length === 0) overstreng.push(label);
            if (!plain && extra.length > 0) derivedOnly += 1;
            // `affects_existing` er NØYAKTIG det sveipet gjør: satt hvis og bare hvis den ville slettet mer etter endringen (ikke ved en vanlig forkorting som ikke berører det avledede vinduet)
            expect(refused.affectsExisting.length > 0, `affects_existing ${label}`).toBe(extra.length > 0);
          } else {
            passedCount += 1;
            expect(await rowOf(), `gjennomført forespørsel er skrevet ${label}`).toMatchObject({ retention_days: next });
            if (extra.length > 0) understreng.push(`${label} -> sletter også ${extra.join(",")}`);
          }
        }
      }
    }
    expect(combos).toBe(168);
    expect(refusedCount + passedCount).toBe(168);
    expect(understreng, "sveipet sletter mer etter en endring som ikke ba om bekreftelse").toEqual([]);
    expect(overstreng, "bekreftelse krevd uten at noe vindu ble kortere").toEqual([]);
    expect(refusedCount).toBeGreaterThan(0);
    expect(passedCount).toBeGreaterThan(0);
    expect(derivedOnly, "orakelet treffer tilfeller der KUN den avledede regelen krever bekreftelse (F1)").toBeGreaterThan(0);
  }, 300_000);
});

describe("F. signalSituationWindowDays: min(grunnvindu, kildens egen oppbevaring), klemt 1-365 som sveipet alltid har gjort", () => {
  const cases: Array<[string, number | undefined, number | null | undefined, number]> = [
    ["ingenting oppgitt: standard 30", undefined, undefined, 30],
    ["uten kildepolicy gjelder grunnvinduet", 90, null, 90],
    ["kilden kortere enn grunnvinduet vinner", 90, 31, 31],
    ["grunnvinduet kortere enn kilden vinner (en lengre kameraoppbevaring forlenger ikke de avledede situasjonene)", 90, 365, 90],
    ["minimum 7 i miljøet, kilde 30", 7, 30, 7],
    ["kilde 0 klemmes til 1", 365, 0, 1],
    ["grunnvindu over 365 klemmes til 365", 400, null, 365],
    ["ikke-endelig kilde (NaN) gir grunnvinduet", 90, Number.NaN, 90],
    ["desimaler rundes ned", 30.9, 7.9, 7]
  ];
  for (const [name, base, source, expected] of cases) {
    it(name, () => {
      expect(signalSituationWindowDays(base, source)).toBe(expected);
    });
  }
});

describe("E. kildevakter: én definisjon av regelen, og verdien kommer fra den allerede parsede wiringen", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const code = (path: string): string => strip(readFileSync(`${ROOT}${path}`, "utf8"));

  it("`signalSituationWindowDays` er definert ÉN gang (signal-retention.ts) og sveipet bruker den selv for både kamera og helse - regelen ligger ikke i en annen kopi", () => {
    const retention = code("modules/situations/src/signal-retention.ts");
    expect(retention.match(/export function signalSituationWindowDays\(/g)).toHaveLength(1);
    expect(retention).toMatch(/vision: signalSituationWindowDays\(options\.retentionDays, options\.visionDays\)/);
    expect(retention).toMatch(/health: signalSituationWindowDays\(options\.retentionDays, options\.healthDays\)/);
    expect(retention).not.toMatch(/Math\.min\(base, clampDays\(options\./); // den gamle innebygde regelen er borte
    const wiring = code("apps/api/src/situation-signals-wiring.ts");
    expect(wiring).toMatch(/signalSituationWindowDays\(retentionDays, visionRetentionDays\)/);
    expect(wiring).not.toMatch(/export function signalSituationWindowDays/);
    expect(code("apps/api/src/vision-routes.ts")).not.toMatch(/Math\.min\(/); // ruten dupliserer ikke regelen
  });

  it("main.ts: kjøretiden får funksjonen fra den ferdig parsede wiringen KUN når den finnes, og koblingen leser ikke miljøet selv (ingen ny `process.env`)", () => {
    const main = code("apps/api/src/main.ts");
    const start = main.indexOf("const visionRuntime = buildVisionRuntime(");
    const end = main.indexOf("visionControlRef.runtime = visionRuntime;");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(main.indexOf("const situationSignals = createSituationSignalsWiring(")).toBeGreaterThan(0);
    expect(main.indexOf("const situationSignals = createSituationSignalsWiring(")).toBeLessThan(start); // wiringen er bygd FØR kjøretiden
    const call = main.slice(start, end);
    expect(call).toMatch(/\.\.\.\(situationSignals\.visionSituationWindowDays !== null \? \{ signalSituationWindowDays: situationSignals\.visionSituationWindowDays \} : \{\}\)/);
    expect(call.match(/process\.env/g)).toHaveLength(1); // kun den eksisterende `env: process.env`
    expect(main.match(/JARVIS_SITUATION_LOG_RETENTION_DAYS/g)).toBeNull(); // parseren (wiringen) er eneste sted som kjenner variabelen
  });

  it("vision-runtime.ts og vision-routes.ts: funksjonen går fra kjøretiden til ruten og videre til `applyRetentionPolicy` som `derived_window_days`, uten å bli lest fra miljøet", () => {
    const runtime = code("apps/api/src/vision-runtime.ts");
    expect(runtime).toMatch(/\.\.\.\(deps\.signalSituationWindowDays !== undefined \? \{ signalSituationWindowDays: deps\.signalSituationWindowDays \} : \{\}\)/);
    expect(runtime).not.toMatch(/JARVIS_SITUATION/);
    const routes = code("apps/api/src/vision-routes.ts");
    expect(routes).toMatch(/derived_window_days: deps\.signalSituationWindowDays/);
    expect(routes).not.toMatch(/process\.env|JARVIS_SITUATION/);
  });
});
