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
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/vision pakkeavhengighet
// kun for en testfil) - SAMME presedens som personal-digital-twin-erasure.test.ts
// sin relative import av LocationService/HealthService.
import { VisionService } from "../../vision/src/service.ts";

/**
 * UA-9 Vision & Physical World (D-153): end-to-end-bevis mot en EKTE
 * embedded Postgres, via den EKTE `ErasureService.executeErasure()`-APIen -
 * IKKE kun en `plan.ts`-kode-lesning - at `planPerson()` sin nye vision-
 * registrering (`modules/erasure/src/plan.ts`) faktisk fjerner ALT av
 * person A sitt vision-avtrykk (`vision_rooms`/`vision_event_observations`),
 * UTEN å røre person B (samme tenant/space) sitt tilsvarende avtrykk, og
 * UTEN å røre tenantens retensjons-POLICY-konfigurasjon
 * (`vision_retention_policies` - dette er space-nivå konfigurasjon, ikke
 * person-eid data). Samme mønster som `personal-digital-twin-erasure.test.ts`
 * etablerte for location/health.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let vision: VisionService;

const TENANT_A = "tenant-vis-erase-a";
const OWNER = "person-tobias-vis";
const PERSON_A = "person-vis-erase-a";
const PERSON_B = "person-vis-erase-b";

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER, tenant_id: tenantId, memory_space_id: "personal",
    session_id: `sess-${tenantId}`, device_id: "dev-vis-erase", channel: "api", auth_strength: "active"
  };
}

interface SeededVision {
  room_id: string;
  observation_id: string;
}

async function seedVision(personId: string, sentinel: string): Promise<SeededVision> {
  const room = await vision.createRoom(TENANT_A, "personal", { person_id: personId, name: `${sentinel}-room` });
  const observation = await vision.ingestObservation(TENANT_A, "personal", personId, {
    event_type: "object_detected", room_id: room.room_id, object_label: sentinel, source_type: "test", observed_at: new Date().toISOString()
  });
  return { room_id: room.room_id, observation_id: observation.observation_id };
}

async function countFor(table: string, personId: string): Promise<number> {
  const r = await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND person_id = $2`, [TENANT_A, personId]);
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vis-erasure-"));
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
  // Garantert non-bypass rolle - beviser samtidig at 055_vision.sql sin
  // GRANT DELETE faktisk holder for denne EKSAKTE rollekonstruksjonen
  // (samme presedens som personal-digital-twin-erasure.test.ts).
  await adminPool.query("CREATE ROLE jarvis_vis_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_vis_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Vision Erasure Test','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${PERSON_A}','Person A'), ('${PERSON_B}','Person B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${PERSON_A}','${TENANT_A}'), ('${PERSON_B}','${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-vis-erase-personal','${TENANT_A}','personal');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_vis_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] }
  });
  vision = new VisionService(appPool);

  // Eier-konfigurert space-nivå retensjonspolicy (Q-20 må ALDRI fjerne denne ved en person-scope erasure).
  await vision.setRetentionPolicy(TENANT_A, "personal", { retention_days: 60, actor_person_id: OWNER });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: en person-scope erasure fjerner FULLSTENDIG person A sitt vision-avtrykk uten å røre person B eller retensjonspolicyen", () => {
  it("executeErasure sletter vision_event_observations + vision_rooms for person A, lar person B og policy-raden stå urørt, uten FK-brudd", async () => {
    const sentinelA = `SentinelVisEraseA${randomUUID().replace(/-/g, "")}`;
    const sentinelB = `SentinelVisEraseB${randomUUID().replace(/-/g, "")}`;
    const twinA = await seedVision(PERSON_A, sentinelA);
    const twinB = await seedVision(PERSON_B, sentinelB);

    const tablesUnderTest = ["vision_event_observations", "vision_rooms"];
    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_A)).toBe(1);
      expect(await countFor(table, PERSON_B)).toBe(1);
    }

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "person", tenant_id: TENANT_A, person_id: PERSON_A },
      requestId: `req-vis-erase-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    // Ville rapportert "failed" ved en FK-brudd-regresjon (feil slettingsrekkefølge mot vision_rooms<-vision_event_observations).
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();

    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_A)).toBe(0);
    }
    const goneById = await adminPool.query(
      `SELECT
         (SELECT count(*)::int FROM vision_rooms WHERE room_id = $1) AS room,
         (SELECT count(*)::int FROM vision_event_observations WHERE observation_id = $2) AS obs`,
      [twinA.room_id, twinA.observation_id]
    );
    const row = goneById.rows[0] as Record<string, number>;
    for (const key of Object.keys(row)) expect(row[key]).toBe(0);

    // Person B (SAMME tenant/space) er UPÅVIRKET - ingen over-sletting/cross-person-lekkasje.
    for (const table of tablesUnderTest) {
      expect(await countFor(table, PERSON_B)).toBe(1);
    }
    const stillThereB = await adminPool.query(
      `SELECT
         (SELECT count(*)::int FROM vision_rooms WHERE room_id = $1) AS room,
         (SELECT count(*)::int FROM vision_event_observations WHERE observation_id = $2) AS obs`,
      [twinB.room_id, twinB.observation_id]
    );
    const rowB = stillThereB.rows[0] as Record<string, number>;
    for (const key of Object.keys(rowB)) expect(rowB[key]).toBe(1);

    // Tenant-/space-nivå retensjonspolicyen overlever en person-scope erasure uendret - policy-config, ikke person-eid data.
    const policy = await vision.getRetentionPolicy(TENANT_A, "personal");
    expect(policy?.retention_days).toBe(60);

    expect(result.record_counts["vision_event_observations"]).toBe(1);
    expect(result.record_counts["vision_rooms"]).toBe(1);
  });
});

describe("B: ingen resurrection - de faktiske live-lesevegene for person A returnerer tomt etter erasure, urørt for person B", () => {
  it("getRecentEvents/listRooms for person A er tomme etter erasure, person B sine er uendret", async () => {
    const sentinelA = `SentinelVisResurrectA${randomUUID().replace(/-/g, "")}`;
    const sentinelB = `SentinelVisResurrectB${randomUUID().replace(/-/g, "")}`;
    await seedVision(PERSON_A, sentinelA);
    const twinB = await seedVision(PERSON_B, sentinelB);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "person", tenant_id: TENANT_A, person_id: PERSON_A },
      requestId: `req-vis-erase-resurrect-${randomUUID()}`,
      identity: identityFor(TENANT_A)
    });
    expect(result.status).toBe("completed");

    expect(await vision.getRecentEvents(TENANT_A, "personal", PERSON_A)).toHaveLength(0);
    expect(await vision.listRooms(TENANT_A, "personal", PERSON_A)).toHaveLength(0);

    const roomsB = await vision.listRooms(TENANT_A, "personal", PERSON_B);
    expect(roomsB.some((r) => r.room_id === twinB.room_id)).toBe(true);
    const eventsB = await vision.getRecentEvents(TENANT_A, "personal", PERSON_B);
    expect(eventsB.some((e) => e.observation_id === twinB.observation_id)).toBe(true);

    // Fersk data for SAMME person etter erasure får en HELT NY id, aldri en gjenbruk av en slettet.
    const freshRoom = await vision.createRoom(TENANT_A, "personal", { person_id: PERSON_A, name: `${sentinelA}-fresh-room` });
    expect(freshRoom.room_id).not.toBe(twinB.room_id);
    expect(await vision.listRooms(TENANT_A, "personal", PERSON_A)).toHaveLength(1);
  });
});

describe("C: idempotens - samme request_id kjørt to ganger på en person-scoped vision-erasure gir samme resultat, ingen dobbel sletting", () => {
  it("andre kjøring er en idempotent replay med identiske record_counts", async () => {
    const sentinel = `SentinelVisEraseIdem${randomUUID().replace(/-/g, "")}`;
    await seedVision(PERSON_A, sentinel);

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-vis-erase-idem-${randomUUID()}`;
    const scope = { type: "person", tenant_id: TENANT_A, person_id: PERSON_A } as const;
    const identity = identityFor(TENANT_A);

    const first = await service.executeErasure({ scope, requestId, identity });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);

    const policy = await vision.getRetentionPolicy(TENANT_A, "personal");
    expect(policy?.retention_days).toBe(60);
  });
});
