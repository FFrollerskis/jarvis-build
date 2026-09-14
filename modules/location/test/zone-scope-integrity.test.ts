import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
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
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: LocationService;

const TENANT_A = "tenant-loc-scope-a";
const TENANT_B = "tenant-loc-scope-b";
const PERSON_A = "person-loc-scope-a";
const PERSON_B = "person-loc-scope-b";
// MERGE BLOCKER B: en TREDJE person, EKTE medlem av TENANT_A (SAMME tenant
// som PERSON_A) - trengs for å bevise at et cross-PERSON (ikke bare
// cross-tenant/cross-space) referansemål avvises selv når BEGGE personene
// faktisk er medlemmer av den SAMME tenanten (se testblokk "I" under).
const PERSON_C = "person-loc-scope-c";
const LAT = 59.9139;
const LON = 10.7522;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-loc-scope-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_loc_scope_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_loc_scope_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Loc Scope A','person'), ('${TENANT_B}','Loc Scope B','person')`
  );
  await adminPool.query(
    `INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}','Scope Person A'), ('${PERSON_B}','Scope Person B'), ('${PERSON_C}','Scope Person C')`
  );
  // MERGE BLOCKER B (arkitekt-review, PR #79): `location_zones`/
  // `location_observations`/`location_zone_visits.person_id` er nå en
  // sammensatt FK mot `person_tenants (person_id, tenant_id)`, IKKE en
  // enkel `people`-FK - hver person MÅ være et EKTE registrert medlem av
  // tenanten en `LocationService`-rad settes inn for, ellers 23503. PERSON_A
  // og PERSON_C er BEGGE medlemmer av TENANT_A (kreves av testblokk "I"
  // under: cross-PERSON, SAMME tenant); PERSON_B er KUN medlem av TENANT_B
  // (kreves av testblokk "H" under: en ikke-medlem skal avvises).
  await adminPool.query(
    `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}','${TENANT_A}'), ('${PERSON_C}','${TENANT_A}'), ('${PERSON_B}','${TENANT_B}')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_loc_scope_test", password: "pw2" });
  service = new LocationService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
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

describe("H: MERGE BLOCKER B - person_id er en sammensatt FK mot person_tenants (bevis: medlemskap, ikke bare eksistens)", () => {
  it("en person som IKKE er medlem av tenanten kan IKKE få en location_zones-rad for den tenanten (rå FK-brudd, 23503)", async () => {
    // PERSON_B er KUN medlem av TENANT_B (se beforeAll) - strukturelt
    // umulig å attribuere en TENANT_A-sone til PERSON_B, selv om PERSON_B
    // finnes GLOBALT i `people`.
    await expect(
      rawInsert(
        TENANT_A, "personal",
        `INSERT INTO location_zones (zone_id, tenant_id, memory_space_id, person_id, name, center_lat, center_lon, radius_meters)
         VALUES ('loc-zn-nonmember-attempt', $1, 'personal', $2, 'Nonmember zone', $3, $4, 100)`,
        [TENANT_A, PERSON_B, LAT, LON]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zones WHERE zone_id = 'loc-zn-nonmember-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("en person som IKKE er medlem av tenanten kan IKKE få en location_observations-rad for den tenanten (rå FK-brudd, 23503)", async () => {
    await expect(
      rawInsert(
        TENANT_A, "personal",
        `INSERT INTO location_observations (observation_id, tenant_id, memory_space_id, person_id, source_type, lat, lon, observed_at)
         VALUES ('loc-ob-nonmember-attempt', $1, 'personal', $2, 'device', $3, $4, now())`,
        [TENANT_A, PERSON_B, LAT, LON]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_observations WHERE observation_id = 'loc-ob-nonmember-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("en person som IKKE er medlem av tenanten kan IKKE få en location_zone_visits-rad for den tenanten (rå FK-brudd, 23503)", async () => {
    const zone = await service.createZone(TENANT_A, "shared", {
      person_id: PERSON_A, name: "Nonmember visit zone", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obs = await service.ingestObservation(TENANT_A, "shared", {
      person_id: PERSON_A, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-05T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_A, "shared",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-nonmember-attempt', $1, 'shared', $2, $3, now(), $4)`,
        [TENANT_A, PERSON_B, zone.zone_id, obs.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-nonmember-attempt'`);
    expect(rows).toHaveLength(0);
  });
});

describe("I: MERGE BLOCKER B - location_zone_visits kan IKKE krysse-referere en ANNEN persons sone/observasjon, selv i SAMME tenant+space", () => {
  it("en visit for PERSON_C kan IKKE bruke en zone_id som tilhører PERSON_A, selv om BEGGE er medlemmer av SAMME tenant (rå FK-brudd, 23503)", async () => {
    const zoneOfA = await service.createZone(TENANT_A, "shared", {
      person_id: PERSON_A, name: "Cross-person zone owner A", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obsOfC = await service.ingestObservation(TENANT_A, "shared", {
      person_id: PERSON_C, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-06T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_A, "shared",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-cross-person-zone-attempt', $1, 'shared', $2, $3, now(), $4)`,
        [TENANT_A, PERSON_C, zoneOfA.zone_id, obsOfC.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-cross-person-zone-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("en visit for PERSON_A kan IKKE bruke en source_observation_id som tilhører PERSON_C, selv i SAMME tenant+space (rå FK-brudd, 23503)", async () => {
    const zoneOfA = await service.createZone(TENANT_A, "project", {
      person_id: PERSON_A, name: "Cross-person obs zone owner A", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obsOfC = await service.ingestObservation(TENANT_A, "project", {
      person_id: PERSON_C, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-07T00:00:00.000Z"
    });

    await expect(
      rawInsert(
        TENANT_A, "project",
        `INSERT INTO location_zone_visits (visit_id, tenant_id, memory_space_id, person_id, zone_id, entered_at, source_observation_id)
         VALUES ('loc-vi-cross-person-obs-attempt', $1, 'project', $2, $3, now(), $4)`,
        [TENANT_A, PERSON_A, zoneOfA.zone_id, obsOfC.observation_id]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM location_zone_visits WHERE visit_id = 'loc-vi-cross-person-obs-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("positiv kontroll: en SAME-tenant/SAME-space/SAME-person visit fortsatt lykkes for PERSON_C (beviser at I ikke bare feiler alt)", async () => {
    const zone = await service.createZone(TENANT_A, "home", {
      person_id: PERSON_C, name: "Valid same-person zone", center_lat: LAT, center_lon: LON, radius_meters: 100
    });
    const obs = await service.ingestObservation(TENANT_A, "home", {
      person_id: PERSON_C, source_type: "device", lat: LAT, lon: LON, observed_at: "2026-05-08T00:00:00.000Z"
    });
    const visits = await service.listZoneVisits(TENANT_A, "home", PERSON_C, { zone_id: zone.zone_id });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.source_observation_id).toBe(obs.observation_id);
  });
});
