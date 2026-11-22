import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthService } from "@jarvis/health";
import { DomainPauseRegistry, SituationEngine, SituationSignalBus, SubscriptionRegistry } from "@jarvis/situations";
import { aggregateDaily, createHealthReader, num } from "../src/situation-signals-wiring.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, B-HIGH-2 (reviewer B): helsekilden leverte ingenting mot en ekte database. `health_metric_observations.value` er `numeric`, og node-postgres leverer `numeric` som STRENG; leseren hadde
 * `Number.isFinite(row.value)` (false for en streng), så ALLE rader ble droppet - tom serie, ingen signal, ingen feil - og enhetstestene (som matet tall) så det aldri. Dette er DB-nær testen: den EKTE `HealthService` mot en ekte
 * Postgres -> den ekte leseren -> bussen -> motoren. (Enhetstestene i `wpg4-signals-wiring.test.ts` mater fortsatt tall; denne dekker typen pg faktisk gir.)
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let health: HealthService;
let engine: SituationEngine;
let domainPauses: DomainPauseRegistry;
let registry: SubscriptionRegistry;

const TENANT = "t-g4-hlt";
const OWNER = "p-g4-hlt";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const actor = { person_id: OWNER, session_id: "s-g4-hlt" };
const dayIso = (daysAgo: number): string => `${new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10)}T06:00:00.000Z`;
let seq = 0;
const insert = (metric: string, value: number, unit: string, iso: string) =>
  admin.query(
    `INSERT INTO health_metric_observations (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, observed_at) VALUES ($1, $2, $3, $4, $5, $6, 'test', $7)`,
    [`g4h-${seq++}`, TENANT, OWNER, metric, value, unit, iso]
  );

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g4-health-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g4_hlt_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g4_hlt_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','G4 health','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g4_hlt_test", password: "pw2" });
  health = new HealthService(app);
  domainPauses = new DomainPauseRegistry(app, { owner_person_id: OWNER });
  await domainPauses.restore();
  engine = new SituationEngine(app, domainPauses, { owner_person_id: OWNER });
  registry = new SubscriptionRegistry(app, { owner_person_id: OWNER });
  // 28 rolige døgn (dag 31..4 tilbake, hvilepuls 60-62, to prøver per døgn) og 3 avvikende døgn (dag 3..1: 95)
  for (let i = 31; i >= 4; i -= 1) {
    await insert("resting_heart_rate", 60 + (i % 3), "bpm", dayIso(i));
    await insert("resting_heart_rate", 60 + (i % 3), "bpm", dayIso(i).replace("T06", "T18"));
  }
  for (let i = 3; i >= 1; i -= 1) await insert("resting_heart_rate", 95, "bpm", dayIso(i));
  // søvn (sum per døgn): 28 døgn à 420 min (to prøver 400 + 20) og 3 korte døgn à 200 min
  for (let i = 31; i >= 4; i -= 1) {
    await insert("sleep_duration_minutes", 400, "min", dayIso(i));
    await insert("sleep_duration_minutes", 20, "min", dayIso(i).replace("T06", "T07"));
  }
  for (let i = 3; i >= 1; i -= 1) await insert("sleep_duration_minutes", 200, "min", dayIso(i));
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("num(): tall og tallstrenger fra pg, ellers ugyldig", () => {
  it("godtar endelige tall og desimalstrenger (slik pg leverer `numeric`); avviser alt annet", () => {
    expect(num(95)).toBe(95);
    expect(num(0)).toBe(0);
    expect(num("95")).toBe(95);
    expect(num("95.50000000")).toBe(95.5);
    expect(num("-3.25")).toBe(-3.25);
    expect(num(" 7 ")).toBe(7);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "", " ", "NaN", "Infinity", "1e3", "0x10", "12abc", "1,5", "+5", "5.", ".5", null, undefined, {}, [], [1], true]) {
      expect(num(bad as never), String(bad)).toBeNull();
    }
  });

  it("aggregateDaily summerer/gjennomsnittsberegner tallstrenger (pg-form) som tall, og ignorerer fortsatt ugyldige verdier", () => {
    expect(aggregateDaily("steps", [{ value: "1000.00000000", observed_at: "2026-11-18T10:00:00Z" }, { value: "2500", observed_at: "2026-11-18T18:00:00Z" }, { value: "abc", observed_at: "2026-11-18T19:00:00Z" }])).toEqual([
      { day: "2026-11-18", value: 3500, samples: 2 }
    ]);
    expect(aggregateDaily("resting_heart_rate", [{ value: "60", observed_at: "2026-11-18T06:00:00Z" }, { value: "62.00", observed_at: "2026-11-18T18:00:00Z" }])).toEqual([{ day: "2026-11-18", value: 61, samples: 2 }]);
  });
});

describe("DB-nær: den ekte HealthService -> leseren -> bussen -> motoren", () => {
  it("pg leverer `numeric` som streng (årsaken), og den ekte leseren gir likevel en hel serie (31 døgn) med riktige aggregater", async () => {
    const raw = await health.getRecentMetrics(TENANT, OWNER, "resting_heart_rate", NOW - 35 * DAY);
    expect(raw.length).toBe(28 * 2 + 3);
    expect(typeof (raw[0] as unknown as { value: unknown }).value).toBe("string"); // dokumenterer hvorfor `Number.isFinite(row.value)` droppet alt
    const read = createHealthReader({ health: health as never, ownerPersonId: OWNER });
    const [hr, sleep] = await read({ tenant_id: TENANT, memory_space: "health", now: NOW }, OWNER, ["resting_heart_rate", "sleep_duration_minutes"]);
    expect(hr?.series).toHaveLength(31);
    expect(hr?.series.slice(-3).map((p) => p.value)).toEqual([95, 95, 95]);
    expect(hr?.series[0]?.samples).toBe(2);
    expect(sleep?.series).toHaveLength(31);
    expect(sleep?.series.slice(0, 28).every((p) => p.value === 420)).toBe(true); // søvn = SUM per døgn (400 + 20)
    expect(sleep?.series.slice(-3).map((p) => p.value)).toEqual([200, 200, 200]);
    expect(await read({ tenant_id: TENANT, memory_space: "health", now: NOW }, "someone-else", ["resting_heart_rate"])).toEqual([]); // kun egen helse
  });

  it("tre avvikende døgn gir ÉN innholdsfri helsesituasjon (inform) via bussen, og samme observasjon på nytt gir `duplicate` (ingen ny situasjon)", async () => {
    const read = createHealthReader({ health: health as never, ownerPersonId: OWNER });
    const observations = await read({ tenant_id: TENANT, memory_space: "health", now: NOW }, OWNER, ["resting_heart_rate"]);
    await registry.subscribe(TENANT, "health", { source: "health", event_type: "resting_heart_rate_deviation", filter: { person_id: OWNER } }, actor);
    const bus = new SituationSignalBus({ pool: app, engine, domainPauses, subscriptions: (t, s) => registry.listEnabled(t, s), now: () => NOW });
    const first = await bus.publishBatch(TENANT, "health", observations);
    expect(first).toMatchObject({ received: 1, evaluated: 1, created: 1, newly_actionable: 1, failed: 0 });
    const queue = await engine.getQueue(TENANT, "health", { statusOpenOnly: false });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ domain: "health", stage: "inform" });
    expect(queue[0]?.reason).not.toMatch(/\d/); // ingen måleverdi, ingen baseline i teksten
    const second = await bus.publishBatch(TENANT, "health", observations);
    expect(second.ignored.duplicate).toBe(1);
    expect(await engine.getQueue(TENANT, "health", { statusOpenOnly: false })).toHaveLength(1);
  });
});
