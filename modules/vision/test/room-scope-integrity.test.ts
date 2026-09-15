import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { VisionService } from "../src/service.ts";

/**
 * D-129-lærdom (samme mønster som `modules/location/test/zone-scope-
 * integrity.test.ts`): en enkel `room_id text PRIMARY KEY`-FK er IKKE en
 * tenant/space-autorisasjonsgrense - Postgres sin FK-sjekk kjører med
 * forhøyet privilegium og OMGÅR RLS. Denne testfilen beviser at
 * `vision_event_observations` sin SAMMENSATTE `(tenant_id, memory_space_id,
 * person_id, room_id)`-fremmednøkkel (`055_vision.sql`) FAKTISK blokkerer et
 * cross-tenant/cross-space/cross-person referansemål - med et RÅTT, DIREKTE
 * `INSERT` mot `vision_event_observations` (BEVISST UTENOM `VisionService`,
 * som uansett aldri selv konstruerer en cross-scope-referanse fra egen
 * applikasjonslogikk - denne testen beviser DATABASENS EGEN håndheving).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: VisionService;

const TENANT_A = "tenant-vis-scope-a";
const TENANT_B = "tenant-vis-scope-b";
const PERSON_A = "person-vis-scope-a";
const PERSON_B = "person-vis-scope-b";
// En TREDJE person, EKTE medlem av TENANT_A (samme tenant som PERSON_A) -
// trengs for å bevise at et cross-PERSON (ikke bare cross-tenant/cross-
// space) referansemål avvises selv når BEGGE personene faktisk er
// medlemmer av den SAMME tenanten (se testblokk "I").
const PERSON_C = "person-vis-scope-c";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vis-scope-"));
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

  await adminPool.query("CREATE ROLE jarvis_vis_scope_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_vis_scope_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Vis Scope A','person'), ('${TENANT_B}','Vis Scope B','person')`
  );
  await adminPool.query(
    `INSERT INTO people (person_id, display_name) VALUES ('${PERSON_A}','Scope Person A'), ('${PERSON_B}','Scope Person B'), ('${PERSON_C}','Scope Person C')`
  );
  // PERSON_A/PERSON_C er BEGGE medlemmer av TENANT_A (kreves av testblokk
  // "I": cross-PERSON, SAMME tenant); PERSON_B er KUN medlem av TENANT_B
  // (kreves av testblokk "H": en ikke-medlem skal avvises).
  await adminPool.query(
    `INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON_A}','${TENANT_A}'), ('${PERSON_C}','${TENANT_A}'), ('${PERSON_B}','${TENANT_B}')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_vis_scope_test", password: "pw2" });
  service = new VisionService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

/** Kjør `fn` i en RÅ transaksjon mot `appPool` (samme NOSUPERUSER/NOBYPASSRLS-rolle) med RLS-konteksten satt eksplisitt - UTENOM `VisionService`. */
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

describe("G: sammensatt FK på vision_event_observations.room_id blokkerer STRUKTURELT et cross-scope rommål", () => {
  it("cross-tenant: en observasjon i TENANT_B kan IKKE bruke en room_id fra TENANT_A (rå FK-brudd, 23503)", async () => {
    const roomA = await service.createRoom(TENANT_A, "personal", { person_id: PERSON_A, name: "Scope room A" });

    await expect(
      rawInsert(
        TENANT_B, "personal",
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, room_id, event_type, source_type, source_event_id, observed_at)
         VALUES ('vis-ob-cross-tenant-attempt', $1, 'personal', $2, $3, 'motion_detected', 'device', $4, now())`,
        [TENANT_B, PERSON_B, roomA.room_id, `evt-${randomUUID()}`]
      )
    ).rejects.toMatchObject({ code: "23503" });

    // Bevis: ingen delvis rad ble stående (transaksjonen rullet tilbake i sin helhet).
    const { rows } = await adminPool.query(`SELECT 1 FROM vision_event_observations WHERE observation_id = 'vis-ob-cross-tenant-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("cross-space (samme tenant): en observasjon i 'business' kan IKKE bruke en room_id fra 'personal' (rå FK-brudd, 23503)", async () => {
    const roomPersonal = await service.createRoom(TENANT_A, "personal", { person_id: PERSON_A, name: "Scope room A personal" });

    await expect(
      rawInsert(
        TENANT_A, "business",
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, room_id, event_type, source_type, source_event_id, observed_at)
         VALUES ('vis-ob-cross-space-attempt', $1, 'business', $2, $3, 'motion_detected', 'device', $4, now())`,
        [TENANT_A, PERSON_A, roomPersonal.room_id, `evt-${randomUUID()}`]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM vision_event_observations WHERE observation_id = 'vis-ob-cross-space-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("positiv kontroll: en SAME-tenant/SAME-space/SAME-person observasjon med gyldig room_id lykkes (beviser at G ikke bare feiler alt)", async () => {
    const room = await service.createRoom(TENANT_A, "guest", { person_id: PERSON_A, name: "Valid scope room" });
    const observed = await service.ingestObservation(TENANT_A, "guest", PERSON_A, {
      event_type: "motion_detected", room_id: room.room_id, source_type: "device", source_event_id: `evt-${randomUUID()}`, observed_at: "2026-05-04T00:00:00.000Z"
    });
    expect(observed.room_id).toBe(room.room_id);

    const events = await service.getRecentEvents(TENANT_A, "guest", PERSON_A, { roomId: room.room_id });
    expect(events.map((e) => e.observation_id)).toContain(observed.observation_id);
  });
});

describe("H: person_id er en sammensatt FK mot person_tenants (bevis: medlemskap, ikke bare eksistens)", () => {
  it("en person som IKKE er medlem av tenanten kan IKKE få en vision_rooms-rad for den tenanten (rå FK-brudd, 23503)", async () => {
    // PERSON_B er KUN medlem av TENANT_B (se beforeAll) - strukturelt umulig
    // å attribuere et TENANT_A-rom til PERSON_B, selv om PERSON_B finnes
    // GLOBALT i `people`.
    await expect(
      rawInsert(
        TENANT_A, "personal",
        `INSERT INTO vision_rooms (room_id, tenant_id, memory_space_id, person_id, name)
         VALUES ('vis-rm-nonmember-attempt', $1, 'personal', $2, 'Nonmember room')`,
        [TENANT_A, PERSON_B]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM vision_rooms WHERE room_id = 'vis-rm-nonmember-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("en person som IKKE er medlem av tenanten kan IKKE få en vision_event_observations-rad for den tenanten (rå FK-brudd, 23503)", async () => {
    await expect(
      rawInsert(
        TENANT_A, "personal",
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, event_type, source_type, source_event_id, observed_at)
         VALUES ('vis-ob-nonmember-attempt', $1, 'personal', $2, 'motion_detected', 'device', $3, now())`,
        [TENANT_A, PERSON_B, `evt-${randomUUID()}`]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM vision_event_observations WHERE observation_id = 'vis-ob-nonmember-attempt'`);
    expect(rows).toHaveLength(0);
  });
});

describe("I: vision_event_observations kan IKKE krysse-referere en ANNEN persons rom, selv i SAMME tenant+space", () => {
  it("en observasjon for PERSON_C kan IKKE bruke en room_id som tilhører PERSON_A, selv om BEGGE er medlemmer av SAMME tenant (rå FK-brudd, 23503)", async () => {
    const roomOfA = await service.createRoom(TENANT_A, "shared", { person_id: PERSON_A, name: "Cross-person room owner A" });

    await expect(
      rawInsert(
        TENANT_A, "shared",
        `INSERT INTO vision_event_observations (observation_id, tenant_id, memory_space_id, person_id, room_id, event_type, source_type, source_event_id, observed_at)
         VALUES ('vis-ob-cross-person-room-attempt', $1, 'shared', $2, $3, 'motion_detected', 'device', $4, now())`,
        [TENANT_A, PERSON_C, roomOfA.room_id, `evt-${randomUUID()}`]
      )
    ).rejects.toMatchObject({ code: "23503" });

    const { rows } = await adminPool.query(`SELECT 1 FROM vision_event_observations WHERE observation_id = 'vis-ob-cross-person-room-attempt'`);
    expect(rows).toHaveLength(0);
  });

  it("positiv kontroll: en SAME-tenant/SAME-space/SAME-person observasjon fortsatt lykkes for PERSON_C (beviser at I ikke bare feiler alt)", async () => {
    const room = await service.createRoom(TENANT_A, "home", { person_id: PERSON_C, name: "Valid same-person room" });
    const observed = await service.ingestObservation(TENANT_A, "home", PERSON_C, {
      event_type: "motion_detected", room_id: room.room_id, source_type: "device", source_event_id: `evt-${randomUUID()}`, observed_at: "2026-05-08T00:00:00.000Z"
    });
    const events = await service.getRecentEvents(TENANT_A, "home", PERSON_C, { roomId: room.room_id });
    expect(events.map((e) => e.observation_id)).toContain(observed.observation_id);
  });
});

describe("J: room_id er NULLABLE - en observasjon UTEN rom omgås FK-en helt (Postgres MATCH SIMPLE)", () => {
  it("en observasjon uten room_id lykkes uansett, selv om ingen rom finnes for personen i det hele tatt", async () => {
    const observed = await service.ingestObservation(TENANT_A, "project", PERSON_A, {
      event_type: "doorbell_event", source_type: "device", source_event_id: `evt-${randomUUID()}`, observed_at: "2026-05-09T00:00:00.000Z"
    });
    expect(observed.room_id).toBeNull();
  });
});
