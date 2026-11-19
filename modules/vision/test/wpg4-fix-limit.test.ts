import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { VisionService } from "../src/service.ts";
import type { VisionObservationInput } from "../src/types.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, B-LOW-6: `VisionService.getRecentEvents` er `SELECT *` uten LIMIT. Ny VALGFRI `filter.limit` (de NYESTE radene): uten den er oppførselen identisk for alle eksisterende kallere (ingen LIMIT).
 * Målt mot en ekte Postgres (NOSUPERUSER/NOBYPASSRLS).
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: VisionService;
const TENANT = "tenant-vis-limit";
const PERSON = "person-vis-limit";

const motion = (minute: number): VisionObservationInput => ({
  event_type: "motion_detected", observed_at: `2026-06-01T08:${String(minute).padStart(2, "0")}:00.000Z`, source_type: "fake", source_instance_id: "camera-limit", source_event_id: `evt-limit-${minute}`
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vision-limit-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_vis_limit_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_vis_limit_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Vision Limit', 'person')`);
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'Person')`);
  await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_vis_limit_test", password: "pw2" });
  service = new VisionService(appPool);
  for (let minute = 1; minute <= 6; minute += 1) await service.ingestObservation(TENANT, "personal", PERSON, motion(minute));
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const minutes = (rows: Array<{ observed_at: string | Date }>): number[] => rows.map((r) => new Date(r.observed_at).getUTCMinutes());

describe("B-LOW-6: getRecentEvents har en valgfri `filter.limit` (de nyeste radene)", () => {
  it("uten `limit` er oppførselen uendret: ALLE rader, nyeste først", async () => {
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { sinceMs: Date.parse("2026-06-01T08:03:00.000Z") }))).toEqual([6, 5, 4, 3]);
  });

  it("med `limit` kommer kun de NYESTE radene, i samme rekkefølge, også kombinert med andre filtre", async () => {
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: 3 }))).toEqual([6, 5, 4]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: 1 }))).toEqual([6]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { eventType: "motion_detected", sinceMs: Date.parse("2026-06-01T08:02:00.000Z"), limit: 2 }))).toEqual([6, 5]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: 100 }))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("en ugyldig `limit` gir aldri en SQL-feil: 0/negativ klemmes til 1, brøk rundes ned, NaN/uendelig ignoreres (ingen LIMIT)", async () => {
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: 0 }))).toEqual([6]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: -5 }))).toEqual([6]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: 2.9 }))).toEqual([6, 5]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: Number.NaN }))).toEqual([6, 5, 4, 3, 2, 1]);
    expect(minutes(await service.getRecentEvents(TENANT, "personal", PERSON, { limit: Number.POSITIVE_INFINITY }))).toEqual([6, 5, 4, 3, 2, 1]);
  });
});
