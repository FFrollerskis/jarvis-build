import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { OWNER, startG4Db, TENANT_A, type G4Db } from "../../../modules/situations/test/support/wpg4-db.ts";
import { createSituationSignalsWiring, type SituationSignalsWiringDeps } from "../src/situation-signals-wiring.ts";

/**
 * WP-G4 delta-runde (D-466, delta-review B: D-LOW-3 og D-LOW-4): retensjonskoblingen gjennom den EKTE komposisjonen `createSituationSignalsWiring` -> løper -> `retireSignalSituations` mot en ekte Postgres.
 * Funksjonen `retireSignalSituations` var testet alene, men koblingen G2/G3-policy -> wiring -> løper -> sveip var det ikke: fire mutanter (reviewer B: N22 løperen leser ikke helsepolicyen, N56/N57 wiringen injiserer ikke
 * helse-/kamerapolicyen, N58 løperen sender ikke `JARVIS_SITUATION_LOG_RETENTION_DAYS` til situasjonssveipet) overlevde hele G4-suiten og ville gitt stille 30 dager i stedet for G2/G3-vinduet.
 * D-LOW-3: oppryddingen dekker alle rom en kilde kan bo i så lenge hovedbryteren er på, også når enkeltkilder er av; er hovedbryteren AV finnes ingen løper og ingenting kjører (erasure er veien da).
 */
let db: G4Db;
const DAY = 86_400_000;
beforeAll(async () => { db = await startG4Db("g4retwire"); }, 240_000);
beforeEach(async () => { await db.reset(); });
afterAll(async () => { await db?.stop(); }, 120_000);

const ownerIdentity = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "home", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as IdentityContext;

function make(env: Record<string, string>, over: Partial<SituationSignalsWiringDeps> = {}) {
  return createSituationSignalsWiring({
    env: env as NodeJS.ProcessEnv,
    pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses,
    gateway: { execute: async () => ({ ok: false, reason: "unused" }), register: () => undefined, get: () => undefined } as never,
    modelGateway: { complete: async () => { throw new Error("unused"); } } as never,
    ownerIdentity, ownerTenant: TENANT_A, ownerPersonId: OWNER,
    incidents: { listIncidents: async () => [] },
    vision: { getRecentEvents: async () => [] },
    health: { getRecentMetrics: async () => [] },
    haTransport: { invoke: async () => ({}) } as never,
    killSwitch: { isActiveDurable: async () => false },
    ...over
  });
}

/** Rad direkte i databasen, `ageDays` gammel (både opprettet og sist sett). */
async function seed(id: string, space: string, domain: string, key: string, ageDays: number): Promise<void> {
  const at = new Date(Date.now() - ageDays * DAY).toISOString();
  await db.adminPool.query(
    `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason, status, opened_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'remember', 'normal', 'probe', 'resolved', $6, $6)`,
    [id, TENANT_A, space, domain, key, at]
  );
}
const exists = async (id: string): Promise<boolean> => (await db.adminPool.query(`SELECT 1 FROM situations WHERE situation_id = $1`, [id])).rowCount === 1;

describe("D-LOW-4: kildenes EGEN oppbevaring (G2 helse, G3 kamera) og `JARVIS_SITUATION_LOG_RETENTION_DAYS` gjelder gjennom den ekte komposisjonen", () => {
  it("helse 7 d og kamera 5 d (injisert fra tjenestene) slår inn i løperens daglige opprydding; hjem bruker standard 30 d (N22, N56, N57)", async () => {
    const wiring = make(
      { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_VISION: "on" },
      { vision: { getRecentEvents: async () => [], getRetentionPolicy: async () => ({ retention_days: 5 }) }, health: { getRecentMetrics: async () => [], getRetentionPolicy: async () => ({ retention_days: 7 }) } }
    );
    expect(wiring.runner).not.toBeNull();
    await seed("h10", "health", "health", "health:resting_heart_rate:above:2026-10-01", 10);
    await seed("h5", "health", "health", "health:resting_heart_rate:above:2026-10-06", 5);
    await seed("v6", "home", "vision", "vision:motion_detected:camera.x:1", 6);
    await seed("v4", "home", "vision", "vision:motion_detected:camera.x:2", 4);
    await seed("home10", "home", "home", "home:opening:binary_sensor.d@2026-11-01T00:00:00.000Z", 10);
    const tick = await wiring.runner!.tick();
    expect(tick).toMatchObject({ status: "ok", retention_failures: 0 });
    expect({ h10: await exists("h10"), h5: await exists("h5"), v6: await exists("v6"), v4: await exists("v4"), home10: await exists("home10") }).toEqual({ h10: false, h5: true, v6: false, v4: true, home10: true });
  });

  it("uten policy fra tjenestene (eller med en feilende helsepolicy) gjelder standard 30 d - ingen stille kortere eller lengre levetid", async () => {
    const wiring = make(
      { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_HEALTH: "on", JARVIS_SITUATION_VISION: "on" },
      { health: { getRecentMetrics: async () => [], getRetentionPolicy: async () => { throw new Error("helse nede"); } } }
    );
    await seed("h40", "health", "health", "health:resting_heart_rate:above:2026-09-01", 40);
    await seed("h20", "health", "health", "health:resting_heart_rate:above:2026-10-20", 20);
    await seed("v40", "home", "vision", "vision:motion_detected:camera.x:1", 40);
    await seed("v20", "home", "vision", "vision:motion_detected:camera.x:2", 20);
    expect(await wiring.runner!.tick()).toMatchObject({ status: "ok", retention_failures: 0 });
    expect({ h40: await exists("h40"), h20: await exists("h20"), v40: await exists("v40"), v20: await exists("v20") }).toEqual({ h40: false, h20: true, v40: false, v20: true });
  });

  it("`JARVIS_SITUATION_LOG_RETENTION_DAYS` = 7 gjelder også signalsituasjonene (ikke bare loggen): en 10 d gammel hjem-situasjon slettes, en 5 d gammel består (N58)", async () => {
    const wiring = make({ JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_VISION: "on", JARVIS_SITUATION_LOG_RETENTION_DAYS: "7" });
    await seed("hh10", "home", "home", "home:opening:binary_sensor.d@2026-11-01T00:00:00.000Z", 10);
    await seed("hh5", "home", "home", "home:opening:binary_sensor.e@2026-11-02T00:00:00.000Z", 5);
    await wiring.runner!.tick();
    expect({ hh10: await exists("hh10"), hh5: await exists("hh5") }).toEqual({ hh10: false, hh5: true });
  });
});

describe("D-LOW-3: oppryddingen dekker alle rom en kilde kan bo i så lenge hovedbryteren er på - også når enkeltkilder er av", () => {
  it("hovedbryteren ALENE (ingen kilde på): løperen finnes og rydder gamle signalsituasjoner i hjem- og helserommet etter standard 30 d, uten å lese eller levere noe; `describe()` viser retensjonsrommene", async () => {
    const wiring = make({ JARVIS_SITUATION_SIGNALS: "on" });
    expect(wiring.runner).not.toBeNull();
    const described = wiring.describe() as { spaces: string[]; retention_spaces: string[]; sources: Record<string, boolean> };
    expect(described.spaces).toEqual([]); // ingen kilde, ingen leserom
    expect([...described.retention_spaces].sort()).toEqual(["business", "health", "home"]); // men alle rom en kilde kan bo i ryddes
    expect(Object.values(described.sources)).toEqual([false, false, false, false]);
    await seed("home40", "home", "home", "home:opening:binary_sensor.d@2026-10-01T00:00:00.000Z", 40);
    await seed("vis40", "home", "vision", "vision:motion_detected:camera.x:1", 40);
    await seed("health40", "health", "health", "health:resting_heart_rate:above:2026-10-01", 40);
    await seed("home10", "home", "home", "home:opening:binary_sensor.e@2026-11-09T00:00:00.000Z", 10);
    const tick = await wiring.runner!.tick();
    expect(tick).toMatchObject({ status: "ok", spaces: 0, sources_read: 0, delivered: 0, auto_act_attempted: 0, retention_failures: 0, errors: [] });
    expect({ home40: await exists("home40"), vis40: await exists("vis40"), health40: await exists("health40"), home10: await exists("home10") }).toEqual({ home40: false, vis40: false, health40: false, home10: true });
  });

  it("kilden er AV, men et annet rom er på: det avslåtte kameraets/helsens gamle rader ryddes fortsatt etter kildens oppbevaring", async () => {
    const wiring = make(
      { JARVIS_SITUATION_SIGNALS: "on", JARVIS_SITUATION_INCIDENTS: "on" },
      { health: { getRecentMetrics: async () => [], getRetentionPolicy: async () => ({ retention_days: 7 }) }, vision: { getRecentEvents: async () => [], getRetentionPolicy: async () => ({ retention_days: 5 }) } }
    );
    expect(wiring.flags).toMatchObject({ signals: true, health: false, vision: false, incidents: true });
    await seed("h10", "health", "health", "health:resting_heart_rate:above:2026-10-01", 10);
    await seed("v6", "home", "vision", "vision:motion_detected:camera.x:1", 6);
    await seed("v4", "home", "vision", "vision:motion_detected:camera.x:2", 4);
    await wiring.runner!.tick();
    expect({ h10: await exists("h10"), v6: await exists("v6"), v4: await exists("v4") }).toEqual({ h10: false, v6: false, v4: true });
  });

  it("kill switch stanser også oppryddingen (ingen sletting, status `blocked`)", async () => {
    const wiring = make({ JARVIS_SITUATION_SIGNALS: "on" }, { killSwitch: { isActiveDurable: async () => true } });
    await seed("home40", "home", "home", "home:opening:binary_sensor.d@2026-10-01T00:00:00.000Z", 40);
    expect(await wiring.runner!.tick()).toMatchObject({ status: "blocked", reason: "kill_switch_active" });
    expect(await exists("home40")).toBe(true);
  });

  it("hovedbryteren AV: ingen løper og ingenting kjøres (radene består; erasure er veien da), og `describe()` er null", async () => {
    const wiring = make({ JARVIS_SITUATION_HOME: "on", JARVIS_SITUATION_HEALTH: "on" }); // underflagg uten hovedbryter = alt av
    expect(wiring.runner).toBeNull();
    expect(wiring.describe()).toBeNull();
    await seed("home40", "home", "home", "home:opening:binary_sensor.d@2026-10-01T00:00:00.000Z", 40);
    wiring.start(); // ingen effekt
    expect(await exists("home40")).toBe(true);
  });
});
