import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { LocationService } from "../src/service.ts";

/**
 * D-129-lærdom (se 050_location.sql sitt filhode og
 * modules/operations/test/scope-integrity.test.ts sitt søster-mønster): en
 * enkel `zone_id text PRIMARY KEY`-FK er IKKE en tenant/space-
 * autorisasjonsgrense - Postgres sin FK-sjekk kjører med forhøyet
 * privilegium og OMGÅR RLS. Denne testfilen beviser at
 * `location_zone_visits` sine SAMMENSATTE `(tenant_id, memory_space_id, ...)`-
 * fremmednøkler (`050_location.sql`) FAKTISK blokkerer et cross-tenant/
 * cross-space referansemål - med et RÅTT, DIREKTE `INSERT` mot
 * `location_zone_visits` (BEVISST UTENOM `LocationService`, som uansett
 * aldri selv konstruerer en cross-scope-referanse fra egen applikasjonslogikk
 * - denne testen beviser DATABASENS EGEN håndheving, ikke tillit til at
 * `zone-scope-integrity`-koden ble skrevet riktig).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: LocationService;

const TENANT_A = "tenant-loc-scope-a";
const TENANT_B = "tenant-loc-scope-b";
const PERSON_A = "person-loc-scope-a";
const PERSON_B = "person-loc-scope-b";
const LAT = 59.9139;
const LON = 10.7522;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-loc-scope-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_loc_scope_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_loc_scope_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Loc Scope A','person'), ('${TENANT_B}','Loc Scope B','person')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}','Scope Person A'), ('${PERSON_B}','Scope Person B')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_loc_scope_test", password: "pw2" });
  service = new LocationService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/** Kjør `fn` i en RÅ transaksjon mot `appPool` (samme NOSUPERUSER/NOBYPASSRLS-rolle) med RLS-konteksten satt eksplisitt - UTENOM `LocationService`. */
async function rawInsert(tenantId: string, spaces: string, sql: string, params: unknown[]): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [tenantId, spaces]);
    try {
      await client.query(sql, params);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

describe("G: sammensatt FK på location_zone_visits.zone_id blokkerer STRUKTURELT et cross-scope sonemål", () => {
  it("cross-tenant: en visit i TENANT_B kan IKKE bruke en zone_id fra TENANT_A (rå FK-brudd, 23503)", async () => {
    const zoneA = await service.createZone(TENANT_A, "personal", {
      person_id: PERSON_A, name: "Scope zone A", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obsB = await service.ingestObservation(TENANT_B, "personal", {
      person_id: PERSON_B, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-01T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_B, "personal",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-cross-tenant-attempt', $1, 'personal', $2, $3, now(), $4)`,
        [TENANT_B, PERSON_B, zoneA.zone_id, obsB.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    // Bevis: ingen delvis rad ble stående (transaksjonen rullet tilbake i sin helhet).
    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-cross-tenant-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("cross-space (samme tenant): en visit i 'business' kan IKKE bruke en zone_id fra 'personal' (rå FK-brudd, 23503)", async () => {
    const zonePersonal = await service.createZone(TENANT_A, "personal", {
      person_id: PERSON_A, name: "Scope zone A personal", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obsBusiness = await service.ingestObservation(TENANT_A, "business", {
      person_id: PERSON_A, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-02T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_A, "business",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-cross-space-attempt', $1, 'business', $2, $3, now(), $4)`,
        [TENANT_A, PERSON_A, zonePersonal.zone_id, obsBusiness.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-cross-space-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("cross-scope source_observation_id avvises like strukturelt (rå FK-brudd, 23503)", async () => {
    const zone = await service.createZone(TENANT_A, "project", {
      person_id: PERSON_A, name: "Scope zone project", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obsOtherTenant = await service.ingestObservation(TENANT_B, "project", {
      person_id: PERSON_B, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-03T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_A, "project",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-cross-obs-attempt', $1, 'project', $2, $3, now(), $4)`,
        [TENANT_A, PERSON_A, zone.zone_id, obsOtherTenant.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-cross-obs-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("positiv kontroll: en SAME-tenant/SAME-space visit lykkes (beviser at G ikke bare feiler alt)", async () => {
    const zone = await service.createZone(TENANT_A, "guest", {
      person_id: PERSON_A, name: "Valid scope zone", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obs = await service.ingestObservation(TENANT_A, "guest", {
      person_id: PERSON_A, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-04T00:00:00.000Z"
    });
    const visits = await service.listZoneVisits(TENANT_A, "guest", PERSON_A, { zone_id: zone.zone_id });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.source_observation_id).toBe(obs.observation_id);
  });
});
