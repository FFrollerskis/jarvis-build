import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relative imports (IKKE nye @jarvis/erasure -> @jarvis/context/@jarvis/location/
// @jarvis/health pakkeavhengigheter kun for en testfil) - SAMME presedens som
// consent-erasure.test.ts/operations-erasure.test.ts sine relative imports av
// ConsentService/OperationsService.
import { ContextEngine } from "../../context/src/service.ts";
import { LocationService } from "../../location/src/service.ts";
import { HealthService } from "../../health/src/service.ts";

/**
 * ARKITEKT-REVIEW MERGE BLOCKER-fiks (ekte review av PR #79, D-130 "UA-8
 * Personal Digital Twin"): `planPerson()` lot TIDLIGERE `location_zone_visits`/
 * `location_observations`/`location_zones`/`health_metric_observations` stå
 * HELT UBERØRT ved en person-scope erasure - en person-scope Q-20-erasure
 * fjernet dermed IKKE personens faktiske Personal Digital Twin-data
 * (posisjonshistorikk, helsedata). Dette er end-to-end-beviset mot en EKTE
 * embedded Postgres, via den EKTE `ErasureService.executeErasure()`-APIen -
 * IKKE kun en `plan.ts`-kode-lesning - at fiksen faktisk fjerner ALT av
 * person A sitt Digital Twin-innhold, UTEN å røre person B (samme tenant,
 * samme spaces) sitt tilsvarende innhold, og UTEN å røre tenantens
 * retensjons-POLICY-konfigurasjon (`location_retention_policies`/
 * `health_retention_policies` - dette er space-nivå konfigurasjon, ikke
 * person-eid data).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let contextEngine: ContextEngine;
let location: LocationService;
let health: HealthService;

const TENANT_A = "tenant-pdt-erase-a";
const OWNER = "person-tobias";
const PERSON_A = "person-pdt-a";
const PERSON_B = "person-pdt-b";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER, tenant_id: tenantId, memory_space_id: "personal",
    session_id: `sess-${tenantId}`, device_id: "dev-pdt-erase", channel: "api", auth_strength: "active"
  };
}

interface SeededTwin {
  observation_id: string;
  zone_id: string;
  location_observation_id: string;
  visit_id: string;
  health_observation_id: string;
}

/** Seeder EN person sitt fulle Digital Twin-avtrykk (kontekst + en ekte sone/observasjon/avledet besøk + helse) via de EKTE tjenestene - ikke rå innsettinger. */
async function seedTwin(personId: string, sentinel: string): Promise<SeededTwin> {
  const ctx = await contextEngine.recordObservation({
    tenant_id: TENANT_A, person_id: personId, memory_space: "personal", dimension: "place",
    value: { label: `${sentinel}-home` }, basis: "deterministic", source_type: "test"
  });

  const zone = await location.createZone(TENANT_A, "personal", {
    person_id: personId, name: `${sentinel}-zone`, center_lat: 59.9, center_lon: 10.7, radius_meters: 100
  });
  // Observert PRESIST i sonens senter -> `evaluateZoneTransitionsInTransaction`
  // avleder ekte ETT `location_zone_visits`-innreise-besøk i SAMME transaksjon
  // som observasjonen ingesteres (ingen egen manuell besøksrad skrevet).
  const observation = await location.ingestObservation(TENANT_A, "personal", {
    person_id: personId, source_type: "test", lat: 59.9, lon: 10.7, observed_at: new Date().toISOString()
  });
  const visits = await location.listZoneVisits(TENANT_A, "personal", personId, { zone_id: zone.zone_id });
  expect(visits).toHaveLength(1); // Beviser at et EKTE avledet besøk faktisk ble skrevet, ikke bare en rå rad.

  const healthObs = await health.ingestObservation(TENANT_A, personId, {
    metric_type: "heart_rate", value: 66, unit: "bpm", observed_at: new Date().toISOString(), source_type: "test"
  });

  return {
    observation_id: ctx.observation.observation_id,
    zone_id: zone.zone_id,
    location_observation_id: observation.observation_id,
    visit_id: visits[0]!.visit_id,
    health_observation_id: healthObs.observation_id
  };
}

async function countFor(table: string, personId: string): Promise<number> {
  const r = await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND person_id = $2`, [TENANT_A, personId]);
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-pdt-erasure-"));
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
  // Garantert non-bypass rolle - beviser samtidig at 050_location.sql/
  // 051_health.sql sine GRANT DELETE faktisk holder for denne EKSAKTE
  // rollekonstruksjonen (samme presedens som consent-/ops-erasure-testene).
  await adminPool.query("CREATE ROLE jarvis_pdt_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_pdt_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','PDT Erasure Test','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${PERSON_A}','Person A'), ('${PERSON_B}','Person B');
    -- Ekte person_tenants-medlemskap for ALLE tre personene FØR noen
    -- lokasjons-/kontekst-/helse-rad settes inn - respekterer samtidige
    -- agenters person_tenants-baserte FK-utvidelser av disse tabellene.
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${PERSON_A}','${TENANT_A}'), ('${PERSON_B}','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-pdt-erase-personal','${TENANT_A}','personal'), ('ms-pdt-erase-health','${TENANT_A}','health');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_pdt_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] }
  });
  contextEngine = new ContextEngine(appPool);
  location = new LocationService(appPool);
  health = new HealthService(appPool);

  // Eier-konfigurerte space-nivå retensjonspolicyer (Q-20 må ALDRI fjerne
  // disse ved en person-scope erasure - de gjelder resten av tenanten).
  await location.setRetentionPolicy(TENANT_A, "personal", { retention_days: 45, actor_person_id: OWNER });
  await health.setRetentionPolicy(TENANT_A, { retention_days: 200, actor_person_id: OWNER }); // D-396 (JARVIS-093): helse-inntak er fail-closed uten policy - satt FØR seed-observasjonene under
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A-D: en person-scope erasure fjerner FULLSTENDIG person A sitt Digital Twin-avtrykk (context/location/health) uten å røre person B eller retensjonspolicyene", () => {
  it("executeErasure sletter context_observations + location_zone_visits + location_observations + location_zones + health_metric_observations for person A, lar person B og policy-radene stå urørt, uten FK-brudd", async () => {
    const sentinelA = `SentinelPdtEraseA${randomUUID().replace(/-/g, "")}`;
    const sentinelB = `SentinelPdtEraseB${randomUUID().replace(/-/g, "")}`;
    const twinA = await seedTwin(PERSON_A, sentinelA);
    const twinB = await seedTwin(PERSON_B, sentinelB);

    const tablesUnderTest = ["context_observations", "location_zone_visits", "location_observations", "location_zones", "health_metric_observations"];
    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_A)).toBe(1);
      expect(await countFor(table, PERSON_B)).toBe(1);
    }

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "person", tenant_id: TENANT_A, person_id: PERSON_A },
      requestId: `req-pdt-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    // §5: ville rapportert "failed" ved en FK-brudd-regresjon (feil
    // slettingsrekkefølge mot de sammensatte `location_zone_visits`-FK-ene).
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();

    // §3: person A er FAKTISK borte i alle fem tabeller.
    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_A)).toBe(0);
    }
    const goneById = await adminPool.query(
      `SELECT
         (SELECT count(*)::int FROM context_observations WHERE observation_id = $1) AS ctx,
         (SELECT count(*)::int FROM location_zones WHERE zone_id = $2) AS zone,
         (SELECT count(*)::int FROM location_observations WHERE observation_id = $3) AS locobs,
         (SELECT count(*)::int FROM location_zone_visits WHERE visit_id = $4) AS visit,
         (SELECT count(*)::int FROM health_metric_observations WHERE observation_id = $5) AS health`,
      [twinA.observation_id, twinA.zone_id, twinA.location_observation_id, twinA.visit_id, twinA.health_observation_id]
    );
    const row = goneById.rows[0] as Record<string, number>;
    for (const key of Object.keys(row)) expect(row[key]).toBe(0);

    // §4: person B (SAMME tenant/spaces) er UPÅVIRKET - ingen over-sletting/cross-person-lekkasje.
    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_B)).toBe(1);
    }
    const stillThereB = await adminPool.query(
      `SELECT
         (SELECT count(*)::int FROM context_observations WHERE observation_id = $1) AS ctx,
         (SELECT count(*)::int FROM location_zones WHERE zone_id = $2) AS zone,
         (SELECT count(*)::int FROM location_observations WHERE observation_id = $3) AS locobs,
         (SELECT count(*)::int FROM location_zone_visits WHERE visit_id = $4) AS visit,
         (SELECT count(*)::int FROM health_metric_observations WHERE observation_id = $5) AS health`,
      [twinB.observation_id, twinB.zone_id, twinB.location_observation_id, twinB.visit_id, twinB.health_observation_id]
    );
    const rowB = stillThereB.rows[0] as Record<string, number>;
    for (const key of Object.keys(rowB)) expect(rowB[key]).toBe(1);

    // §7: tenant-/space-nivå retensjonspolicyene overlever en person-scope erasure uendret - policy-config, ikke person-eid data.
    const locationPolicy = await location.getRetentionPolicy(TENANT_A, "personal");
    expect(locationPolicy?.retention_days).toBe(45);
    const healthPolicy = await health.getRetentionPolicy(TENANT_A);
    expect(healthPolicy?.retention_days).toBe(200);

    // Record-counts fra selve resultatet dekker de fem tabellene med presist forventet antall (kun person A).
    expect(result.record_counts["context_observations"]).toBe(1);
    expect(result.record_counts["location_zone_visits"]).toBe(1);
    expect(result.record_counts["location_observations"]).toBe(1);
    expect(result.record_counts["location_zones"]).toBe(1);
    expect(result.record_counts["health_metric_observations"]).toBe(1);
  });
});

describe("E: ingen resurrection - de faktiske live-lesevegene for person A returnerer tomt/null etter erasure, urørt for person B", () => {
  it("getPersonLocation/getCurrentContext/getRecentMetrics/listZones for person A er tomme etter erasure, person B sine er uendret", async () => {
    const sentinelA = `SentinelPdtResurrectA${randomUUID().replace(/-/g, "")}`;
    const sentinelB = `SentinelPdtResurrectB${randomUUID().replace(/-/g, "")}`;
    await seedTwin(PERSON_A, sentinelA);
    const twinB = await seedTwin(PERSON_B, sentinelB);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "person", tenant_id: TENANT_A, person_id: PERSON_A },
      requestId: `req-pdt-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    // Person A: alle EKTE lese-veier (ikke bare en tabell-telling) bekrefter tomt/null.
    expect(await location.getPersonLocation(TENANT_A, "personal", PERSON_A)).toBeNull();
    expect(await location.listZones(TENANT_A, "personal", PERSON_A)).toHaveLength(0);
    expect(await location.listZoneVisits(TENANT_A, "personal", PERSON_A)).toHaveLength(0);
    expect(await health.getRecentMetrics(TENANT_A, PERSON_A)).toHaveLength(0);
    const ctxA = await contextEngine.getCurrentContext(TENANT_A, PERSON_A, "personal");
    for (const dimension of ["place", "device", "meeting", "activity"] as const) {
      expect(ctxA.dimensions[dimension]).toBeNull();
    }

    // Person B: SAMME live-leseveier viser fortsatt det ekte, uendrede avtrykket
    // (person B akkumulerer BEVISST på tvers av `it`-blokker i denne filen -
    // §A-D sitt tidligere avtrykk for person B ble ALDRI erasert, så her
    // sjekkes tilstedeværelse av DENNE testens spesifikke rader, ikke et
    // eksakt totalantall).
    expect(await location.getPersonLocation(TENANT_A, "personal", PERSON_B)).not.toBeNull();
    const zonesB = await location.listZones(TENANT_A, "personal", PERSON_B);
    expect(zonesB.some((z) => z.zone_id === twinB.zone_id)).toBe(true);
    const metricsB = await health.getRecentMetrics(TENANT_A, PERSON_B);
    expect(metricsB.some((m) => m.observation_id === twinB.health_observation_id)).toBe(true);
    const ctxB = await contextEngine.getCurrentContext(TENANT_A, PERSON_B, "personal");
    expect(ctxB.dimensions.place?.value["label"]).toBe(`${sentinelB}-home`);

    // Fersk data for SAMME person etter erasure får en HELT NY id, aldri en gjenbruk av en slettet - samme presedens som operations-erasure.test.ts sin §E.
    const freshZone = await location.createZone(TENANT_A, "personal", {
      person_id: PERSON_A, name: `${sentinelA}-fresh-zone`, center_lat: 10, center_lon: 10, radius_meters: 50
    });
    expect(freshZone.zone_id).not.toBe(twinB.zone_id);
    expect(await location.listZones(TENANT_A, "personal", PERSON_A)).toHaveLength(1); // KUN den ferske sonen - ingen gjenoppstått gammel rad.
  });
});

describe("F: idempotens - samme request_id kjørt to ganger på en person-scoped erasure gir samme resultat, ingen dobbel sletting", () => {
  it("andre kjøring er en idempotent replay med identiske record_counts", async () => {
    const sentinel = `SentinelPdtEraseIdem${randomUUID().replace(/-/g, "")}`;
    await seedTwin(PERSON_A, sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-pdt-erase-idem-${randomUUID()}`;
    const scope = { type: "person", tenant_id: TENANT_A, person_id: PERSON_A } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);

    // §7 (gjentatt for idempotent-replayen): policy-radene ble IKKE rørt av noen av de to kjøringene.
    const locationPolicy = await location.getRetentionPolicy(TENANT_A, "personal");
    expect(locationPolicy?.retention_days).toBe(45);
    const healthPolicy = await health.getRetentionPolicy(TENANT_A);
    expect(healthPolicy?.retention_days).toBe(200);
  });
});
