import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { DEFAULT_RETENTION_DAYS, LocationService } from "../src/service.ts";

/**
 * UA-8 Personal Digital Twin - Native Jarvis Location/Geofencing Core:
 * ekte Postgres/RLS-integrasjonsbevis for `LocationService` mot en EKTE
 * NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * modules/operations/test/service-rls.test.ts) - IKKE en mock-pool.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: LocationService;

const TENANT_A = "tenant-loc-svc-a";
const TENANT_B = "tenant-loc-svc-b";
const PERSON_A = "person-loc-a";
const PERSON_B = "person-loc-b";

// Oslo-ish testkoordinater. 1 grad breddegrad ~= 111 320 m.
const HOME_LAT = 59.9139;
const HOME_LON = 10.7522;
// ~5.5 km unna langs breddegrad - UTENFOR en 200m-radius hjemmesone.
const AWAY_LAT = 59.9639;
const AWAY_LON = 10.7522;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-location-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_loc_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_loc_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Location Svc A', 'person'), ('${TENANT_B}', 'Location Svc B', 'person')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}', 'Person A'), ('${PERSON_B}', 'Person B')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_loc_svc_test", password: "pw2" });
  service = new LocationService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: retensjon - ingestObservation setter en korrekt retention_expires_at", () => {
  it("uten eier-konfigurert policy brukes DEFAULT_RETENTION_DAYS (90 dager)", async () => {
    const observedAt = "2026-01-01T12:00:00.000Z";
    const obs = await service.ingestObservation(TENANT_A, "personal", {
      person_id: PERSON_A, source_type: "device", source_instance_id: "dev-1",
      lat: HOME_LAT, lon: HOME_LON, observed_at: observedAt
    });
    expect(obs.retention_expires_at).not.toBeNull();
    const expected = new Date(observedAt).getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(new Date(obs.retention_expires_at!).getTime()).toBe(expected);
  });

  it("med en eksplisitt eier-konfigurert policy brukes DET vinduet, ikke standarden", async () => {
    await service.setRetentionPolicy(TENANT_A, "business", { retention_days: 30, actor_person_id: PERSON_A });
    const policy = await service.getRetentionPolicy(TENANT_A, "business");
    expect(policy?.retention_days).toBe(30);

    const observedAt = "2026-02-01T00:00:00.000Z";
    const obs = await service.ingestObservation(TENANT_A, "business", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: observedAt
    });
    const expected = new Date(observedAt).getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(new Date(obs.retention_expires_at!).getTime()).toBe(expected);
  });

  it("setRetentionPolicy er en UPSERT - gjentatt kall med ny verdi ERSTATTER, oppretter ALDRI en ny rad", async () => {
    await service.setRetentionPolicy(TENANT_A, "project", { retention_days: 10 });
    await service.setRetentionPolicy(TENANT_A, "project", { retention_days: 45 });
    const policy = await service.getRetentionPolicy(TENANT_A, "project");
    expect(policy?.retention_days).toBe(45);
  });
});

describe("B: purgeExpiredObservations - faktisk håndhevings-SLETTING", () => {
  it("sletter KUN rader forbi retention_expires_at, lar ikke-utløpte rader stå urørt", async () => {
    await service.setRetentionPolicy(TENANT_A, "guest", { retention_days: 1 });

    // Forfalt: observert for 10 dager siden, 1 dags retensjon -> lenge utløpt.
    const expired = await service.ingestObservation(TENANT_A, "guest", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON,
      observed_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    });
    // Ikke utløpt: observert nå, 1 dags retensjon -> utløper i morgen.
    const fresh = await service.ingestObservation(TENANT_A, "guest", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON,
      observed_at: new Date().toISOString()
    });

    const deletedCount = await service.purgeExpiredObservations(TENANT_A, "guest");
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const stillPresent = await service.getPersonLocation(TENANT_A, "guest", PERSON_A);
    expect(stillPresent?.observation_id).toBe(fresh.observation_id);

    // Direkte admin-sjekk (utenfor RLS) at den utløpte raden faktisk er borte.
    const { rows } = await adminPool.query(`SELECT 1 FROM location_observations WHERE observation_id = $1`, [expired.observation_id]);
    expect(rows).toHaveLength(0);
  });

  it("gjentatt kall uten nye utløpte rader er en EKTE no-op (0 slettet)", async () => {
    await service.purgeExpiredObservations(TENANT_A, "guest");
    const second = await service.purgeExpiredObservations(TENANT_A, "guest");
    expect(second).toBe(0);
  });
});

describe("C/D: sone-inn/ut (evaluateZoneTransitions via ingestObservation)", () => {
  it("C: en observasjon INNENFOR en konfigurert sone oppretter en location_zone_visits-rad (entered_at satt, left_at null)", async () => {
    const zone = await service.createZone(TENANT_A, "personal", {
      person_id: PERSON_A, name: "Hjemme", center_lat: HOME_LAT, center_lon: HOME_LON, radius_meters: 200
    });
    const observedAt = "2026-03-01T08:00:00.000Z";
    await service.ingestObservation(TENANT_A, "personal", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: observedAt
    });
    const visits = await service.listZoneVisits(TENANT_A, "personal", PERSON_A, { zone_id: zone.zone_id });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.left_at).toBeNull();
    expect(new Date(visits[0]!.entered_at).toISOString()).toBe(observedAt);
  });

  it("D: en PÅFØLGENDE observasjon UTENFOR sonen lukker besøket (left_at satt)", async () => {
    const zone = await service.createZone(TENANT_A, "home", {
      person_id: PERSON_A, name: "Hjemme D", center_lat: HOME_LAT, center_lon: HOME_LON, radius_meters: 200
    });
    await service.ingestObservation(TENANT_A, "home", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: "2026-03-02T08:00:00.000Z"
    });
    const openBefore = await service.listZoneVisits(TENANT_A, "home", PERSON_A, { zone_id: zone.zone_id, open_only: true });
    expect(openBefore).toHaveLength(1);

    const leftAt = "2026-03-02T09:00:00.000Z";
    await service.ingestObservation(TENANT_A, "home", {
      person_id: PERSON_A, source_type: "device", lat: AWAY_LAT, lon: AWAY_LON, observed_at: leftAt
    });
    const visits = await service.listZoneVisits(TENANT_A, "home", PERSON_A, { zone_id: zone.zone_id });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.left_at).not.toBeNull();
    expect(new Date(visits[0]!.left_at!).toISOString()).toBe(leftAt);

    const openAfter = await service.listZoneVisits(TENANT_A, "home", PERSON_A, { zone_id: zone.zone_id, open_only: true });
    expect(openAfter).toHaveLength(0);
  });

  it("gjentatt observasjon FORTSATT innenfor sonen er en EKTE no-op (ingen ny visit-rad)", async () => {
    const zone = await service.createZone(TENANT_A, "shared", {
      person_id: PERSON_A, name: "Stabil sone", center_lat: HOME_LAT, center_lon: HOME_LON, radius_meters: 200
    });
    await service.ingestObservation(TENANT_A, "shared", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: "2026-03-03T08:00:00.000Z"
    });
    await service.ingestObservation(TENANT_A, "shared", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: "2026-03-03T08:30:00.000Z"
    });
    const visits = await service.listZoneVisits(TENANT_A, "shared", PERSON_A, { zone_id: zone.zone_id });
    expect(visits).toHaveLength(1);
  });
});

describe("E/F: tenant-/memory-space-isolasjon (RLS)", () => {
  it("E: TENANT_B ser ALDRI TENANT_A sin posisjonsdata/soner/besøk", async () => {
    const zone = await service.createZone(TENANT_A, "personal", {
      person_id: PERSON_A, name: "Isolasjonssone", center_lat: HOME_LAT, center_lon: HOME_LON, radius_meters: 200
    });
    await service.ingestObservation(TENANT_A, "personal", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: "2026-04-01T08:00:00.000Z"
    });

    expect(await service.getZone(TENANT_B, "personal", zone.zone_id)).toBeNull();
    expect(await service.getPersonLocation(TENANT_B, "personal", PERSON_A)).toBeNull();
    expect(await service.listZones(TENANT_B, "personal", PERSON_A)).toHaveLength(0);
    expect(await service.listZoneVisits(TENANT_B, "personal", PERSON_A)).toHaveLength(0);
  });

  it("F: en 'personal'-space-observasjon er usynlig fra en økt som KUN har 'business'-space (samme tenant)", async () => {
    await service.ingestObservation(TENANT_A, "personal", {
      person_id: PERSON_A, source_type: "device", lat: HOME_LAT, lon: HOME_LON, observed_at: "2026-04-02T08:00:00.000Z"
    });

    // Ekte RLS-økt-sjekk: sett konteksten selv (ikke via LocationService,
    // som alltid setter (tenant, ÉN space) sammen) for å bevise at
    // 'business'-space alene ALDRI ser 'personal'-rader, direkte mot samme
    // NOSUPERUSER/NOBYPASSRLS-rolle som resten av denne testfilen.
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [TENANT_A, "business"]);
      const { rows } = await client.query(
        `SELECT * FROM location_observations WHERE tenant_id = $1 AND person_id = $2 AND memory_space_id = 'personal'`,
        [TENANT_A, PERSON_A]
      );
      expect(rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
