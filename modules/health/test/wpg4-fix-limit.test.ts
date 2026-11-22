import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { HealthService } from "../src/service.ts";
import type { HealthObservationInput } from "../src/types.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, B-LOW-6: `HealthService.getRecentMetrics` er `SELECT *` uten LIMIT, og situasjonsløperen leste 35 døgn x 3 metrikker uten tak. Ny VALGFRI `limit` (de NYESTE radene): uten den er oppførselen
 * identisk for alle eksisterende kallere (ingen LIMIT). Målt mot en ekte Postgres (NOSUPERUSER/NOBYPASSRLS).
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: HealthService;
const TENANT = "tenant-hlt-limit";
const PERSON = "person-hlt-limit";

const steps = (day: number): HealthObservationInput => ({
  metric_type: "steps", value: 1000 + day, unit: "count", observed_at: `2026-06-${String(day).padStart(2, "0")}T08:00:00.000Z`, source_type: "fake", source_instance_id: "device-limit"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-health-limit-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_hlt_limit_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_hlt_limit_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Health Limit', 'person')`);
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'Person')`);
  await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_hlt_limit_test", password: "pw2" });
  service = new HealthService(appPool);
  await service.setRetentionPolicy(TENANT, { retention_days: 3650 });
  for (let day = 1; day <= 6; day += 1) await service.ingestObservation(TENANT, PERSON, steps(day));
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const days = (rows: Array<{ observed_at: string | Date }>): number[] => rows.map((r) => new Date(r.observed_at).getUTCDate());

describe("B-LOW-6: getRecentMetrics har en valgfri `limit` (de nyeste radene)", () => {
  it("uten `limit` er oppførselen uendret: ALLE rader, nyeste først", async () => {
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps"))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", Date.parse("2026-06-02T00:00:00.000Z")))).toEqual([6, 5, 4, 3, 2]);
  });

  it("med `limit` kommer kun de NYESTE radene, i samme rekkefølge, også kombinert med `sinceMs`", async () => {
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, 3))).toEqual([6, 5, 4]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, 1))).toEqual([6]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", Date.parse("2026-06-03T00:00:00.000Z"), 2))).toEqual([6, 5]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, 100))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("en ugyldig `limit` gir aldri en SQL-feil: 0/negativ klemmes til 1, brøk rundes ned, NaN/uendelig ignoreres (ingen LIMIT)", async () => {
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, 0))).toEqual([6]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, -5))).toEqual([6]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, 2.9))).toEqual([6, 5]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, Number.NaN))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(days(await service.getRecentMetrics(TENANT, PERSON, "steps", undefined, Number.POSITIVE_INFINITY))).toEqual([6, 5, 4, 3, 2, 1]);
  });
});
