import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { FakeHealthMetricSource } from "../src/fake-source.ts";
import { HealthObservationValidationError, HealthService } from "../src/service.ts";
import type { HealthObservationInput } from "../src/types.ts";

/**
 * UA-8 Personal Digital Twin: ekte Postgres/RLS-integrasjonsbevis for
 * `HealthService` - health-space-segregering (BÅDE strukturell CHECK OG
 * RLS, bevist UAVHENGIG av hverandre - se testblokk E/F), tenant-isolasjon,
 * retention-beregning/-håndhevelse, og `HealthMetricSource`-adapter-
 * komposisjon - mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster
 * som `modules/consent/test/service-rls.test.ts`/`modules/operations/test/
 * service-rls.test.ts`, IKKE en `fakePool()`-mock).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: HealthService;

const TENANT_A = "tenant-hlt-svc-a";
const TENANT_B = "tenant-hlt-svc-b";
const PERSON_A = "person-hlt-a";
const PERSON_B = "person-hlt-b";

function validHeartRate(overrides: Partial<HealthObservationInput> = {}): HealthObservationInput {
  return {
    metric_type: "heart_rate",
    value: 72,
    unit: "bpm",
    observed_at: "2026-06-01T08:00:00.000Z",
    source_type: "fake",
    source_instance_id: "device-1",
    ...overrides
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-health-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_hlt_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_hlt_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Health Svc A', 'person'), ('${TENANT_B}', 'Health Svc B', 'person')`
  );
  await adminPool.query(
    `INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}', 'Person A'), ('${PERSON_B}', 'Person B')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_hlt_svc_test", password: "pw2" });
  service = new HealthService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: gyldig observasjon skrives OG er lesbar via getRecentMetrics", () => {
  it("ingestObservation lagrer en gyldig heart_rate-måling, health-space-scoped", async () => {
    const row = await service.ingestObservation(TENANT_A, PERSON_A, validHeartRate());
    expect(row.observation_id).toMatch(/^health-obs-/);
    expect(row.memory_space_id).toBe("health");
    expect(row.metric_type).toBe("heart_rate");
    expect(row.value).toBe("72"); // numeric-kolonne kommer tilbake som streng fra pg som standard.
    expect(row.unit).toBe("bpm");

    const recent = await service.getRecentMetrics(TENANT_A, PERSON_A, "heart_rate");
    expect(recent.map((r) => r.observation_id)).toContain(row.observation_id);
  });

  it("getRecentMetrics filtrerer korrekt på metric_type OG sinceMs uavhengig av hverandre", async () => {
    await service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ observed_at: "2026-06-02T08:00:00.000Z" }));
    await service.ingestObservation(
      TENANT_A,
      PERSON_A,
      validHeartRate({ metric_type: "steps", value: 5000, unit: "count", observed_at: "2026-06-02T09:00:00.000Z" })
    );
    const onlySteps = await service.getRecentMetrics(TENANT_A, PERSON_A, "steps");
    expect(onlySteps.every((r) => r.metric_type === "steps")).toBe(true);
    expect(onlySteps.length).toBeGreaterThanOrEqual(1);

    const sinceLater = await service.getRecentMetrics(TENANT_A, PERSON_A, undefined, Date.parse("2026-06-02T08:30:00.000Z"));
    expect(sinceLater.every((r) => new Date(r.observed_at).getTime() >= Date.parse("2026-06-02T08:30:00.000Z"))).toBe(true);
  });
});

describe("B: ugyldig verdi/metric_type avvises deterministisk - INGEN rad skrevet", () => {
  it("negativ hjertefrekvens kastes som HealthObservationValidationError", async () => {
    const before = await service.getRecentMetrics(TENANT_A, PERSON_A, "heart_rate");
    await expect(service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ value: -5 }))).rejects.toThrow(HealthObservationValidationError);
    const after = await service.getRecentMetrics(TENANT_A, PERSON_A, "heart_rate");
    expect(after.length).toBe(before.length); // uendret - ingen rad skrevet.
  });

  it("en metric_type UTENFOR det lukkede MVP-settet kastes (zod-avvist FØR databasen i det hele tatt nås)", async () => {
    const bad = { ...validHeartRate(), metric_type: "blood_pressure" } as unknown as HealthObservationInput;
    await expect(service.ingestObservation(TENANT_A, PERSON_A, bad)).rejects.toThrow(HealthObservationValidationError);
  });

  it("feil enhet for gitt metric_type (v1 støtter INGEN konvertering) kastes", async () => {
    await expect(service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ unit: "kg" }))).rejects.toThrow(HealthObservationValidationError);
  });

  it("en verdi over den plausible øvre grensen for metric_type kastes", async () => {
    await expect(service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ value: 9999 }))).rejects.toThrow(HealthObservationValidationError);
  });
});

describe("C: retention_expires_at beregnes korrekt fra det konfigurerte vinduet", () => {
  it("fravær av en konfigurert policy gir retention_expires_at = NULL (aldri automatisk purget)", async () => {
    const tenantNoPolicy = "tenant-hlt-svc-nopolicy";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantNoPolicy}', 'No Policy', 'person')`);
    const row = await service.ingestObservation(tenantNoPolicy, PERSON_A, validHeartRate());
    expect(row.retention_expires_at).toBeNull();
  });

  it("en konfigurert policy på N dager gir retention_expires_at = observed_at + N dager, eksakt", async () => {
    const tenantId = "tenant-hlt-svc-retention";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Retention', 'person')`);
    const policy = await service.setRetentionPolicy(tenantId, { retention_days: 30 });
    expect(policy.retention_days).toBe(30);

    const observedAt = "2026-01-01T00:00:00.000Z";
    const row = await service.ingestObservation(tenantId, PERSON_A, validHeartRate({ observed_at: observedAt }));
    expect(row.retention_expires_at).not.toBeNull();
    const expectedMs = Date.parse(observedAt) + 30 * 24 * 60 * 60 * 1000;
    expect(new Date(row.retention_expires_at as string).getTime()).toBe(expectedMs);
  });

  it("getRetentionPolicy returnerer null når ingen policy er konfigurert, ellers den registrerte raden", async () => {
    const tenantId = "tenant-hlt-svc-getpolicy";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'GetPolicy', 'person')`);
    expect(await service.getRetentionPolicy(tenantId)).toBeNull();
    await service.setRetentionPolicy(tenantId, { retention_days: 7 });
    const policy = await service.getRetentionPolicy(tenantId);
    expect(policy?.retention_days).toBe(7);
  });
});

describe("D: purgeExpiredObservations sletter KUN rader forbi utløp", () => {
  it("en utløpt rad slettes; en ikke-utløpt OG en uten konfigurert retention (NULL) forblir urørt", async () => {
    const tenantId = "tenant-hlt-svc-purge";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Purge', 'person')`);

    const expiredId = "health-obs-purge-expired";
    const futureId = "health-obs-purge-future";
    const noRetentionId = "health-obs-purge-noretention";
    await adminPool.query(
      `INSERT INTO health_metric_observations
         (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, observed_at, retention_expires_at)
       VALUES
         ($1, $4, $5, 'heart_rate', 70, 'bpm', 'fake', now() - interval '10 days', now() - interval '1 day'),
         ($2, $4, $5, 'heart_rate', 71, 'bpm', 'fake', now() - interval '10 days', now() + interval '10 years'),
         ($3, $4, $5, 'heart_rate', 72, 'bpm', 'fake', now() - interval '10 days', NULL)`,
      [expiredId, futureId, noRetentionId, tenantId, PERSON_A]
    );

    const deletedCount = await service.purgeExpiredObservations(tenantId);
    expect(deletedCount).toBe(1);

    const remaining = await service.getRecentMetrics(tenantId, PERSON_A);
    const remainingIds = remaining.map((r) => r.observation_id);
    expect(remainingIds).not.toContain(expiredId);
    expect(remainingIds).toContain(futureId);
    expect(remainingIds).toContain(noRetentionId);
  });
});

describe("E: strukturelt CHECK-bevis - memory_space_id != 'health' er UMULIG, selv med et direkte INSERT-forsøk", () => {
  it("databasens CHECK-constraint avviser en rad med memory_space_id = 'personal'", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO health_metric_observations
           (observation_id, tenant_id, memory_space_id, person_id, metric_type, value, unit, source_type, observed_at)
         VALUES ('health-obs-bad-space', $1, 'personal', $2, 'heart_rate', 70, 'bpm', 'fake', now())`,
        [TENANT_A, PERSON_A]
      )
    ).rejects.toThrow(/check/i);
  });

  it("databasens CHECK-constraint avviser en metric_type utenfor det lukkede settet", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO health_metric_observations
           (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, observed_at)
         VALUES ('health-obs-bad-metric', $1, $2, 'blood_pressure', 70, 'mmHg', 'fake', now())`,
        [TENANT_A, PERSON_A]
      )
    ).rejects.toThrow(/check/i);
  });

  it("databasens CHECK-constraint avviser en negativ value direkte (uavhengig av tjenestelagets egen validering)", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO health_metric_observations
           (observation_id, tenant_id, person_id, metric_type, value, unit, source_type, observed_at)
         VALUES ('health-obs-bad-value', $1, $2, 'heart_rate', -1, 'bpm', 'fake', now())`,
        [TENANT_A, PERSON_A]
      )
    ).rejects.toThrow(/check/i);
  });
});

describe("F: memory-space-RLS (UAVHENGIG av CHECK-en i E) - en sesjon uten 'health' i jarvis.memory_spaces ser INGENTING", () => {
  it("en sesjon scopet til KUN 'personal'/'business' ser null helse-rader for samme tenant, selv om rader faktisk finnes", async () => {
    await service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ observed_at: "2026-07-01T00:00:00.000Z" }));

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal,business', true)", [
        TENANT_A
      ]);
      const visible = await client.query("SELECT observation_id FROM health_metric_observations WHERE tenant_id = $1", [TENANT_A]);
      expect(visible.rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("samme sesjon MED 'health' i jarvis.memory_spaces ser radene igjen (kontrollerer at testen over faktisk beviser noe)", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'health', true)", [TENANT_A]);
      const visible = await client.query("SELECT observation_id FROM health_metric_observations WHERE tenant_id = $1", [TENANT_A]);
      expect(visible.rows.length).toBeGreaterThan(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

describe("G: tenant-isolasjon (RLS) - TENANT_B ser ALDRI TENANT_A sine helse-observasjoner", () => {
  it("getRecentMetrics for TENANT_B returnerer tomt for en person hvis data KUN finnes under TENANT_A", async () => {
    await service.ingestObservation(TENANT_A, PERSON_A, validHeartRate({ observed_at: "2026-08-01T00:00:00.000Z" }));
    const fromB = await service.getRecentMetrics(TENANT_B, PERSON_A);
    expect(fromB).toHaveLength(0);
  });
});

describe("H: HealthMetricSource-adapterkontrakten komponerer ende-til-ende via ingestFromSource", () => {
  it("FakeHealthMetricSource -> ingestFromSource() validerer OG skriver alle produserte observasjoner", async () => {
    const tenantId = "tenant-hlt-svc-source";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Source', 'person')`);

    const source = new FakeHealthMetricSource([
      validHeartRate({ observed_at: "2026-09-01T06:00:00.000Z" }),
      { metric_type: "steps", value: 8000, unit: "count", observed_at: "2026-09-01T20:00:00.000Z", source_type: "fake" }
    ]);

    const written = await service.ingestFromSource(tenantId, PERSON_B, source);
    expect(written).toHaveLength(2);
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.personId).toBe(PERSON_B);

    const recent = await service.getRecentMetrics(tenantId, PERSON_B);
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => r.metric_type).sort()).toEqual(["heart_rate", "steps"]);
  });

  it("sinceMs filtreres av kilden selv - HealthService pålegger INGEN egen filtrering utover det kilden returnerer", async () => {
    const tenantId = "tenant-hlt-svc-source-since";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'SourceSince', 'person')`);
    const source = new FakeHealthMetricSource([
      validHeartRate({ observed_at: "2026-01-01T00:00:00.000Z" }),
      validHeartRate({ observed_at: "2026-05-01T00:00:00.000Z" })
    ]);
    const written = await service.ingestFromSource(tenantId, PERSON_B, source, { sinceMs: Date.parse("2026-03-01T00:00:00.000Z") });
    expect(written).toHaveLength(1);
    expect(source.calls[0]?.sinceMs).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
  });
});
