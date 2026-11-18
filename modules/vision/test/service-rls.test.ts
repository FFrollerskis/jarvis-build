import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FakeVisionEventSource } from "../src/fake-source.ts";
import { VisionObservationValidationError, VisionReplayConflictError, VisionService } from "../src/service.ts";
import { runVisionRetentionSweepForAllTenants } from "../src/sweep.ts";
import type { VisionObservationInput } from "../src/types.ts";

/**
 * UA-9 Vision & Physical World: ekte Postgres/RLS-integrasjonsbevis for
 * `VisionService` - multi-space-segregering (RESTRICTIVE RLS, D-153, IKKE
 * health-stil enkelt-låst CHECK - se 055_vision.sql sitt filhode), tenant-
 * isolasjon, retention-beregning/-håndhevelse, "last seen"-spørring
 * (akseptansekriterium 1) og `VisionEventSource`-adapter-komposisjon - mot
 * en EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * `modules/health/test/service-rls.test.ts`, IKKE en `fakePool()`-mock).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: VisionService;

const TENANT_A = "tenant-vis-svc-a";
const TENANT_B = "tenant-vis-svc-b";
const PERSON_A = "person-vis-a";
const PERSON_B = "person-vis-b";

/** `source_event_id` defaultes til en FERSK, unik verdi per kall - overstyr eksplisitt i idempotens-/dedupe-tester som trenger en GJENTATT samme id. */
function validObjectDetected(overrides: Partial<VisionObservationInput> = {}): VisionObservationInput {
  return {
    event_type: "object_detected",
    object_label: "package",
    confidence: 0.92,
    observed_at: "2026-06-01T08:00:00.000Z",
    source_type: "fake",
    source_instance_id: "camera-1",
    source_event_id: `evt-${randomUUID()}`,
    ...overrides
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vision-svc-"));
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

  await adminPool.query("CREATE ROLE jarvis_vis_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_vis_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Vision Svc A', 'person'), ('${TENANT_B}', 'Vision Svc B', 'person')`
  );
  await adminPool.query(
    `INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}', 'Person A'), ('${PERSON_B}', 'Person B')`
  );
  // Sammensatt (person_id, tenant_id)-medlemskaps-FK mot person_tenants
  // (055_vision.sql, samme D-129-lærdom som location/health) - PERSON_A må
  // være et faktisk medlem av BÅDE TENANT_A og TENANT_B før noen observasjon
  // kan skrives for de tenantene.
  await adminPool.query(
    `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${TENANT_A}'), ('${PERSON_A}', '${TENANT_B}')`
  );
  // Registrer 'personal'-spacet for begge tenants (memory_spaces) - trengs
  // av `listTenantMemorySpaces()` (sweep-testblokken under).
  await adminPool.query(
    `INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-vis-svc-a-personal', '${TENANT_A}', 'personal'), ('ms-vis-svc-b-personal', '${TENANT_B}', 'personal')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_vis_svc_test", password: "pw2" });
  service = new VisionService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: gyldig observasjon skrives OG er lesbar via getRecentEvents", () => {
  it("ingestObservation lagrer en gyldig object_detected-hendelse, tenant+space-scoped", async () => {
    const row = await service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected());
    expect(row.observation_id).toMatch(/^vis-ob-/);
    expect(row.memory_space_id).toBe("personal");
    expect(row.event_type).toBe("object_detected");
    expect(row.object_label).toBe("package");
    expect(row.room_id).toBeNull();

    const recent = await service.getRecentEvents(TENANT_A, "personal", PERSON_A);
    expect(recent.map((r) => r.observation_id)).toContain(row.observation_id);
  });

  it("getRecentEvents filtrerer korrekt på eventType/roomId/sinceMs uavhengig av hverandre", async () => {
    const room = await service.createRoom(TENANT_A, "personal", { person_id: PERSON_A, name: "Stue" });
    await service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-06-02T08:00:00.000Z", room_id: room.room_id }));
    await service.ingestObservation(
      TENANT_A,
      "personal",
      PERSON_A,
      validObjectDetected({ event_type: "motion_detected", object_label: undefined, observed_at: "2026-06-02T09:00:00.000Z" })
    );

    const onlyMotion = await service.getRecentEvents(TENANT_A, "personal", PERSON_A, { eventType: "motion_detected" });
    expect(onlyMotion.every((r) => r.event_type === "motion_detected")).toBe(true);
    expect(onlyMotion.length).toBeGreaterThanOrEqual(1);

    const onlyRoom = await service.getRecentEvents(TENANT_A, "personal", PERSON_A, { roomId: room.room_id });
    expect(onlyRoom.every((r) => r.room_id === room.room_id)).toBe(true);
    expect(onlyRoom.length).toBeGreaterThanOrEqual(1);

    const sinceLater = await service.getRecentEvents(TENANT_A, "personal", PERSON_A, { sinceMs: Date.parse("2026-06-02T08:30:00.000Z") });
    expect(sinceLater.every((r) => new Date(r.observed_at).getTime() >= Date.parse("2026-06-02T08:30:00.000Z"))).toBe(true);
  });
});

describe("B: ugyldig verdi/event_type avvises deterministisk - INGEN rad skrevet", () => {
  it("en confidence utenfor [0,1] kastes som VisionObservationValidationError (zod-avvist FØR databasen i det hele tatt nås)", async () => {
    const before = await service.getRecentEvents(TENANT_A, "personal", PERSON_A);
    await expect(
      service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ confidence: 1.5 }))
    ).rejects.toThrow(VisionObservationValidationError);
    const after = await service.getRecentEvents(TENANT_A, "personal", PERSON_A);
    expect(after.length).toBe(before.length); // uendret - ingen rad skrevet.
  });

  it("en event_type UTENFOR det lukkede MVP-settet kastes", async () => {
    const bad = { ...validObjectDetected(), event_type: "face_recognized" } as unknown as VisionObservationInput;
    await expect(service.ingestObservation(TENANT_A, "personal", PERSON_A, bad)).rejects.toThrow(VisionObservationValidationError);
  });

  it("et ugyldig observed_at kastes", async () => {
    await expect(
      service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ observed_at: "ikke-en-dato" }))
    ).rejects.toThrow(VisionObservationValidationError);
  });

  it("en room_id som ikke finnes (eller tilhører en annen person/tenant/space) avvises av databasens sammensatte FK (23503)", async () => {
    await expect(
      service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ room_id: "vis-rm-does-not-exist" }))
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("mangler source_event_id kastes (zod-avvist - PÅKREVD felt, ARKITEKT-REVIEW-FIKS PR #83)", async () => {
    const withoutId = { ...validObjectDetected() } as Record<string, unknown>;
    delete withoutId["source_event_id"];
    await expect(
      service.ingestObservation(TENANT_A, "personal", PERSON_A, withoutId as unknown as VisionObservationInput)
    ).rejects.toThrow(VisionObservationValidationError);
  });

  it("snapshot_ref er FJERNET fra input-schemaet (ARKITEKT-REVIEW-FIKS PR #83, P1) - et forsøk på å sette det avvises strukturelt (.strict())", async () => {
    const withSnapshot = { ...validObjectDetected(), snapshot_ref: "s3://bucket/frame.jpg" } as unknown as VisionObservationInput;
    await expect(service.ingestObservation(TENANT_A, "personal", PERSON_A, withSnapshot)).rejects.toThrow(VisionObservationValidationError);
  });

  it("WP-G3 (D-465, migrasjon 134): snapshot_ref-forbudet (CHECK ... IS NULL) er erstattet av en sammensatt FK mot vision_snapshots - en peker til et bilde som ikke finnes (eller en ekstern URL) avvises FORTSATT av databasen, UTENOM VisionService", async () => {
    await expect(
      adminPool.query(
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at, snapshot_ref)
         VALUES ('vis-ob-bad-snapshot', $1, 'personal', $2, 'motion_detected', 'device', 'device-1', 'evt-bad-snapshot', 'fp-test', now(), 's3://bucket/frame.jpg')`,
        [TENANT_A, PERSON_A]
      )
    ).rejects.toThrow(/vision_event_observations_snapshot_fkey/);
  });
});

describe("C: retention_expires_at beregnes korrekt fra det konfigurerte vinduet, ANKRET på recorded_at/now() - IKKE det ubetrodde observed_at (ARKITEKT-REVIEW-FIKS, PR #83, P1)", () => {
  it("fravær av en konfigurert policy gir retention_expires_at = now() + DEFAULT_RETENTION_DAYS (location-stil, IKKE health-stil NULL)", async () => {
    const tenantNoPolicy = "tenant-vis-svc-nopolicy";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantNoPolicy}', 'No Policy', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantNoPolicy}')`);
    const before = Date.now();
    const row = await service.ingestObservation(tenantNoPolicy, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-01-01T00:00:00.000Z" }));
    const after = Date.now();
    expect(row.retention_expires_at).not.toBeNull();
    const expiresMs = new Date(row.retention_expires_at as string).getTime();
    // Ankret på databasens EGEN mottakstid (now()), ikke det gamle observed_at - toleranse for test-eksekveringstid.
    expect(expiresMs).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("en konfigurert policy på N dager gir retention_expires_at = now() + N dager, ikke observed_at + N dager", async () => {
    const tenantId = "tenant-vis-svc-retention";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Retention', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const policy = await service.setRetentionPolicy(tenantId, "personal", { retention_days: 7 });
    expect(policy.retention_days).toBe(7);

    const before = Date.now();
    const row = await service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-01-01T00:00:00.000Z" }));
    const after = Date.now();
    const expiresMs = new Date(row.retention_expires_at as string).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("ADVERSARIELT: en kilde som sender observed_at langt inn i fremtiden kan IKKE omgå retensjonsvinduet - utløpet er UAVHENGIG av observed_at", async () => {
    const tenantId = "tenant-vis-svc-future-skew";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'FutureSkew', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    await service.setRetentionPolicy(tenantId, "personal", { retention_days: 7 });

    const before = Date.now();
    // En ondsinnet/feilkonfigurert kilde hevder hendelsen skjedde om 500 år.
    const row = await service.ingestObservation(
      tenantId, "personal", PERSON_A, validObjectDetected({ observed_at: "2526-01-01T00:00:00.000Z" })
    );
    const after = Date.now();
    expect(new Date(row.observed_at).getUTCFullYear()).toBe(2526); // proveniens for observed_at er UENDRET.
    const expiresMs = new Date(row.retention_expires_at as string).getTime();
    // Utløpet er ANKRET på mottakstidspunktet, IKKE forskjøvet 500 år frem - beviser at bypasset er lukket.
    expect(expiresMs).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("getRetentionPolicy returnerer null når ingen policy er konfigurert, ellers den registrerte raden", async () => {
    const tenantId = "tenant-vis-svc-getpolicy";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'GetPolicy', 'person')`);
    expect(await service.getRetentionPolicy(tenantId, "personal")).toBeNull();
    await service.setRetentionPolicy(tenantId, "personal", { retention_days: 14 });
    const policy = await service.getRetentionPolicy(tenantId, "personal");
    expect(policy?.retention_days).toBe(14);
  });
});

describe("D: purgeExpiredObservations sletter KUN rader forbi utløp, scoped til (tenant, space)", () => {
  it("en utløpt rad slettes; en ikke-utløpt OG en uten satt frist forblir urørt", async () => {
    const tenantId = "tenant-vis-svc-purge";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Purge', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    const expiredId = "vis-ob-purge-expired";
    const futureId = "vis-ob-purge-future";
    const noRetentionId = "vis-ob-purge-noretention";
    await adminPool.query(
      `INSERT INTO vision_event_observations
         (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at, retention_expires_at)
       VALUES
         ($1, $4, 'personal', $5, 'motion_detected', 'fake', 'device-1', $6, 'fp-test', now() - interval '10 days', now() - interval '1 day'),
         ($2, $4, 'personal', $5, 'motion_detected', 'fake', 'device-1', $7, 'fp-test', now() - interval '10 days', now() + interval '10 years'),
         ($3, $4, 'personal', $5, 'motion_detected', 'fake', 'device-1', $8, 'fp-test', now() - interval '10 days', NULL)`,
      [expiredId, futureId, noRetentionId, tenantId, PERSON_A, `evt-${randomUUID()}`, `evt-${randomUUID()}`, `evt-${randomUUID()}`]
    );

    const deletedCount = await service.purgeExpiredObservations(tenantId, "personal");
    expect(deletedCount).toBe(1);

    const remaining = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    const remainingIds = remaining.map((r) => r.observation_id);
    expect(remainingIds).not.toContain(expiredId);
    expect(remainingIds).toContain(futureId);
    expect(remainingIds).toContain(noRetentionId);
  });
});

describe("E: memory-space-RLS - en sesjon uten det aktuelle spacet i jarvis.memory_spaces ser INGENTING", () => {
  it("en sesjon scopet til KUN 'business' ser null vision-rader for 'personal', selv om rader faktisk finnes", async () => {
    await service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-07-01T00:00:00.000Z" }));

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'business', true)", [
        TENANT_A
      ]);
      const visible = await client.query("SELECT observation_id FROM vision_event_observations WHERE tenant_id = $1", [TENANT_A]);
      expect(visible.rows).toHaveLength(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("samme sesjon MED 'personal' i jarvis.memory_spaces ser radene igjen (kontrollerer at testen over faktisk beviser noe)", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal', true)", [TENANT_A]);
      const visible = await client.query("SELECT observation_id FROM vision_event_observations WHERE tenant_id = $1", [TENANT_A]);
      expect(visible.rows.length).toBeGreaterThan(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

describe("F: tenant-isolasjon (RLS) - TENANT_B ser ALDRI TENANT_A sine vision-hendelser", () => {
  it("getRecentEvents for TENANT_B returnerer tomt for en person hvis data KUN finnes under TENANT_A", async () => {
    await service.ingestObservation(TENANT_A, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-08-01T00:00:00.000Z" }));
    const fromB = await service.getRecentEvents(TENANT_B, "personal", PERSON_A);
    expect(fromB).toHaveLength(0);
  });
});

describe("G: getLastSeen (UA-9 akseptansekriterium 1) - siste kjente hendelse for et objektnavn", () => {
  it("returnerer den NYESTE hendelsen for object_label, ikke den eldste", async () => {
    const tenantId = "tenant-vis-svc-lastseen";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'LastSeen', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    await service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ object_label: "cat", observed_at: "2026-04-01T08:00:00.000Z" }));
    const newest = await service.ingestObservation(
      tenantId, "personal", PERSON_A, validObjectDetected({ object_label: "cat", observed_at: "2026-04-02T08:00:00.000Z" })
    );

    const lastSeen = await service.getLastSeen(tenantId, "personal", PERSON_A, "cat");
    expect(lastSeen?.observation_id).toBe(newest.observation_id);
  });

  it("returnerer null når ingen hendelse med det objektnavnet finnes ennå (ærlig 'vet ikke', ikke en feil)", async () => {
    const tenantId = "tenant-vis-svc-lastseen-empty";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'LastSeenEmpty', 'person')`);
    expect(await service.getLastSeen(tenantId, "personal", PERSON_A, "dinosaur")).toBeNull();
  });
});

describe("H: VisionEventSource-adapterkontrakten komponerer ende-til-ende via ingestFromSource", () => {
  it("FakeVisionEventSource -> ingestFromSource() validerer OG skriver alle produserte hendelser", async () => {
    const tenantId = "tenant-vis-svc-source";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'Source', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_B}', '${tenantId}')`);

    const source = new FakeVisionEventSource([
      validObjectDetected({ observed_at: "2026-09-01T06:00:00.000Z" }),
      { event_type: "doorbell_event", observed_at: "2026-09-01T20:00:00.000Z", source_type: "fake", source_instance_id: "camera-1", source_event_id: `evt-${randomUUID()}` }
    ]);

    const written = await service.ingestFromSource(tenantId, "personal", PERSON_B, source);
    expect(written).toHaveLength(2);
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.personId).toBe(PERSON_B);

    const recent = await service.getRecentEvents(tenantId, "personal", PERSON_B);
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => r.event_type).sort()).toEqual(["doorbell_event", "object_detected"]);
  });

  it("sinceMs filtreres av kilden selv - VisionService pålegger INGEN egen filtrering utover det kilden returnerer", async () => {
    const tenantId = "tenant-vis-svc-source-since";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'SourceSince', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_B}', '${tenantId}')`);
    const source = new FakeVisionEventSource([
      validObjectDetected({ observed_at: "2026-01-01T00:00:00.000Z" }),
      validObjectDetected({ observed_at: "2026-05-01T00:00:00.000Z" })
    ]);
    const written = await service.ingestFromSource(tenantId, "personal", PERSON_B, source, { sinceMs: Date.parse("2026-03-01T00:00:00.000Z") });
    expect(written).toHaveLength(1);
    expect(source.calls[0]?.sinceMs).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
  });
});

describe("I: runVisionRetentionSweepForAllTenants fan-out mot (tenant, space) - reell wiring, IKKE mocket", () => {
  it("purger en utløpt rad i TENANT_A sitt 'personal'-space uten å røre en ikke-utløpt rad i TENANT_B", async () => {
    const sweepExpiredId = "vis-ob-sweep-expired";
    await adminPool.query(
      `INSERT INTO vision_event_observations
         (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_instance_id, source_event_id, payload_fingerprint, observed_at, retention_expires_at)
       VALUES ($1, $2, 'personal', $3, 'motion_detected', 'fake', 'device-1', $4, 'fp-test', now() - interval '40 days', now() - interval '1 day')`,
      [sweepExpiredId, TENANT_A, PERSON_A, `evt-${randomUUID()}`]
    );
    const keepRow = await service.ingestObservation(TENANT_B, "personal", PERSON_A, validObjectDetected({ observed_at: "2026-09-10T00:00:00.000Z" }));

    const result = await runVisionRetentionSweepForAllTenants(adminPool, service);
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toBeGreaterThan(0);

    const { rows } = await adminPool.query(`SELECT 1 FROM vision_event_observations WHERE observation_id = $1`, [sweepExpiredId]);
    expect(rows).toHaveLength(0);

    const stillThere = await service.getRecentEvents(TENANT_B, "personal", PERSON_A);
    expect(stillThere.map((r) => r.observation_id)).toContain(keepRow.observation_id);
  });
});

describe("J: idempotens/atomisitet for kilde-ingestion (ARKITEKT-REVIEW-FIKS, PR #83, P1) - adversarielle tester", () => {
  it("eksakt retry: samme source_event_id sendt to ganger via ingestObservation() gir SAMME rad, ingen duplikat", async () => {
    const tenantId = "tenant-vis-svc-retry-exact";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'RetryExact', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const input = validObjectDetected({ source_event_id: "evt-retry-exact-1" });

    const first = await service.ingestObservation(tenantId, "personal", PERSON_A, input);
    const second = await service.ingestObservation(tenantId, "personal", PERSON_A, input);
    expect(second.observation_id).toBe(first.observation_id);

    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.observation_id === first.observation_id)).toHaveLength(1);
  });

  it("overlappende poll: to ingestFromSource()-kall med delvis overlappende hendelsessett skriver KUN de genuint nye radene", async () => {
    const tenantId = "tenant-vis-svc-overlap-poll";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'OverlapPoll', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    const shared = validObjectDetected({ source_event_id: "evt-overlap-shared", observed_at: "2026-04-01T00:00:00.000Z" });
    const onlyFirst = validObjectDetected({ source_event_id: "evt-overlap-first", observed_at: "2026-04-01T01:00:00.000Z" });
    const onlySecond = validObjectDetected({ source_event_id: "evt-overlap-second", observed_at: "2026-04-01T02:00:00.000Z" });

    const firstPoll = new FakeVisionEventSource([shared, onlyFirst]);
    const secondPoll = new FakeVisionEventSource([shared, onlySecond]); // "shared" levert på nytt - overlappende vindu.

    await service.ingestFromSource(tenantId, "personal", PERSON_A, firstPoll);
    await service.ingestFromSource(tenantId, "personal", PERSON_A, secondPoll);

    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all).toHaveLength(3); // shared + onlyFirst + onlySecond - IKKE 4.
    expect(all.filter((r) => r.source_event_id === "evt-overlap-shared")).toHaveLength(1);
  });

  it("samtidig duplikat-levering: to PARALLELLE ingestObservation()-kall med SAMME source_event_id gir presis ÉN rad, ingen krasj", async () => {
    const tenantId = "tenant-vis-svc-concurrent-dupe";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'ConcurrentDupe', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const input = validObjectDetected({ source_event_id: "evt-concurrent-dupe-1" });

    const [a, b] = await Promise.all([
      service.ingestObservation(tenantId, "personal", PERSON_A, input),
      service.ingestObservation(tenantId, "personal", PERSON_A, input)
    ]);
    expect(a.observation_id).toBe(b.observation_id);

    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_event_id === "evt-concurrent-dupe-1")).toHaveLength(1);
  });

  it("valid-så-invalid batch: ingestFromSource() skriver INGEN rader i det hele tatt når ETT element i batchen feiler validering (atomisk, ikke delvis committet prefiks)", async () => {
    const tenantId = "tenant-vis-svc-partial-batch";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'PartialBatch', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    const validItem = validObjectDetected({ source_event_id: "evt-partial-batch-valid" });
    const invalidItem = { ...validObjectDetected({ source_event_id: "evt-partial-batch-invalid" }), confidence: 5 };
    const source = new FakeVisionEventSource([validItem, invalidItem]);

    await expect(service.ingestFromSource(tenantId, "personal", PERSON_A, source)).rejects.toThrow(VisionObservationValidationError);

    // Det GYLDIGE elementet ble IKKE committet før det ugyldige elementet kastet.
    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_event_id === "evt-partial-batch-valid")).toHaveLength(0);
  });

  it("retry ETTER en rettet valid-så-invalid batch er trygg: det tidligere (aldri skrevne) gyldige elementet skrives nå, ingen duplikat av noe som helst", async () => {
    const tenantId = "tenant-vis-svc-partial-batch-retry";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'PartialBatchRetry', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    const validItem = validObjectDetected({ source_event_id: "evt-partial-retry-valid" });
    const invalidItem = { ...validObjectDetected({ source_event_id: "evt-partial-retry-invalid" }), confidence: 5 };
    const failingSource = new FakeVisionEventSource([validItem, invalidItem]);
    await expect(service.ingestFromSource(tenantId, "personal", PERSON_A, failingSource)).rejects.toThrow(VisionObservationValidationError);

    // Kilden retter feilen og batchen re-polles (samme "valid"-element, IKKE det ugyldige).
    const fixedSource = new FakeVisionEventSource([validItem]);
    const written = await service.ingestFromSource(tenantId, "personal", PERSON_A, fixedSource);
    expect(written).toHaveLength(1);

    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_event_id === "evt-partial-retry-valid")).toHaveLength(1);
  });
});

describe("K: dedupe-kollisjonsdomene + payload-verifisert replay (ARKITEKT-REVIEW-FIKS, PR #83, RUNDE 2, P1x2) - adversarielle tester", () => {
  it("mangler source_instance_id kastes (zod-avvist - PÅKREVD felt, RUNDE 2)", async () => {
    const withoutInstance = { ...validObjectDetected() } as Record<string, unknown>;
    delete withoutInstance["source_instance_id"];
    await expect(
      service.ingestObservation(TENANT_A, "personal", PERSON_A, withoutInstance as unknown as VisionObservationInput)
    ).rejects.toThrow(VisionObservationValidationError);
  });

  it("to UAVHENGIGE enheter (ulik source_instance_id) bak SAMME source_type kan IKKE overskrive hverandres hendelser selv med SAMME lokale source_event_id (datatap-bug lukket)", async () => {
    const tenantId = "tenant-vis-svc-two-instances";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'TwoInstances', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);

    // To FYSISK ULIKE kameraer, begge type 'home_assistant', som begge (uavhengig av hverandre) bruker lokal event-teller '1'.
    const fromCameraA = validObjectDetected({ source_type: "home_assistant", source_instance_id: "camera-a", source_event_id: "1", object_label: "cat" });
    const fromCameraB = validObjectDetected({ source_type: "home_assistant", source_instance_id: "camera-b", source_event_id: "1", object_label: "dog" });

    const writtenA = await service.ingestObservation(tenantId, "personal", PERSON_A, fromCameraA);
    const writtenB = await service.ingestObservation(tenantId, "personal", PERSON_A, fromCameraB);

    expect(writtenA.observation_id).not.toBe(writtenB.observation_id); // IKKE behandlet som en replay av hverandre.
    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_type === "home_assistant" && r.source_event_id === "1")).toHaveLength(2);
    expect(all.map((r) => r.object_label).sort()).toEqual(["cat", "dog"]);
  });

  it("eksakt SAMME payload under SAMME nøkkel: deterministisk replay, EKSISTERENDE rad returneres uendret (fingerprint stemmer)", async () => {
    const tenantId = "tenant-vis-svc-fingerprint-match";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'FingerprintMatch', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const input = validObjectDetected({ source_event_id: "evt-fp-match" });

    const first = await service.ingestObservation(tenantId, "personal", PERSON_A, input);
    const second = await service.ingestObservation(tenantId, "personal", PERSON_A, { ...input }); // NY objekt-referanse, SAMME innhold.
    expect(second.observation_id).toBe(first.observation_id);
  });

  it("SAMME nøkkel (source_type/source_instance_id/source_event_id) med ET ANNET event_type kastes som VisionReplayConflictError - ALDRI en stille retur av feil data (nøkkel-gjenbruk/korrupsjon)", async () => {
    const tenantId = "tenant-vis-svc-fingerprint-mismatch";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'FingerprintMismatch', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const key = "evt-fp-mismatch";

    const first = await service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, event_type: "motion_detected", object_label: undefined }));
    await expect(
      service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, event_type: "security_alert", object_label: undefined }))
    ).rejects.toThrow(VisionReplayConflictError);

    // Den ORIGINALE raden er UENDRET - append-only, ingen overskriving forsøkt.
    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    const stored = all.find((r) => r.observation_id === first.observation_id);
    expect(stored?.event_type).toBe("motion_detected");
    expect(all.filter((r) => r.source_event_id === key)).toHaveLength(1); // ingen ny rad skrevet av det avviste forsøket heller.
  });

  it("SAMME nøkkel med ET ANNET observed_at kastes ogsaa (payload-fingerprint dekker observed_at, ikke bare event_type)", async () => {
    const tenantId = "tenant-vis-svc-fingerprint-mismatch-time";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'FingerprintMismatchTime', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const key = "evt-fp-mismatch-time";

    await service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, observed_at: "2026-06-01T08:00:00.000Z" }));
    await expect(
      service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, observed_at: "2026-06-01T09:00:00.000Z" }))
    ).rejects.toThrow(VisionReplayConflictError);
  });

  it("samtidig EKSAKT duplikat-levering (SAMME payload, parallelt) forblir trygg med fingerprint-verifiseringen på plass - fortsatt presis ÉN rad", async () => {
    const tenantId = "tenant-vis-svc-concurrent-fp-match";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'ConcurrentFpMatch', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const input = validObjectDetected({ source_event_id: "evt-concurrent-fp-match" });

    const [a, b] = await Promise.all([
      service.ingestObservation(tenantId, "personal", PERSON_A, input),
      service.ingestObservation(tenantId, "personal", PERSON_A, { ...input })
    ]);
    expect(a.observation_id).toBe(b.observation_id);
    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_event_id === "evt-concurrent-fp-match")).toHaveLength(1);
  });

  it("samtidig MOTSTRIDENDE levering (SAMME nøkkel, ULIK payload, parallelt) - én lykkes, den andre kastes VisionReplayConflictError, fortsatt presis ÉN rad", async () => {
    const tenantId = "tenant-vis-svc-concurrent-fp-mismatch";
    await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantId}', 'ConcurrentFpMismatch', 'person')`);
    await adminPool.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}', '${tenantId}')`);
    const key = "evt-concurrent-fp-mismatch";

    const results = await Promise.allSettled([
      service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, event_type: "motion_detected", object_label: undefined })),
      service.ingestObservation(tenantId, "personal", PERSON_A, validObjectDetected({ source_event_id: key, event_type: "security_alert", object_label: undefined }))
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(VisionReplayConflictError);

    const all = await service.getRecentEvents(tenantId, "personal", PERSON_A);
    expect(all.filter((r) => r.source_event_id === key)).toHaveLength(1); // fortsatt presis ÉN rad, uansett hvilken som "vant" løpet.
  });
});
