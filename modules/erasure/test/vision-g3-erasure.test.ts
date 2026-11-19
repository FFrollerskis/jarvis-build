import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
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
// Relative importer (samme presedens som vision-erasure.test.ts): ingen ny pakkeavhengighet kun for en testfil.
import { VisionCameraService, type VisionCamera } from "../../vision/src/cameras.ts";
import { VisionClassifier } from "../../vision/src/classifier.ts";
import { VisionEmbeddingService } from "../../vision/src/embeddings.ts";
import { VisionInventoryService } from "../../vision/src/inventory.ts";
import { VisionIngestPipeline } from "../../vision/src/pipeline.ts";
import { VisionService } from "../../vision/src/service.ts";
import { VisionSnapshotService } from "../../vision/src/snapshots.ts";
import { LocalFsStorageAdapter } from "../../vision/src/storage.ts";
import { VisionCaptureService } from "../../vision/src/capture.ts";

/**
 * WP-G3 (D-465): Q-20-erasure dekker NÅ HELE UA-9-avtrykket - kameraer, hendelser, lagrede bilder, vektorer, inventar og opptaksforespørsler - bevist ende-til-ende mot den
 * EKTE `ErasureService.executeErasure()` og en ekte lokal bildelagring: raden OG bildeobjektet forsvinner (gravstein -> reaper), person B (samme tenant/space) er uberørt,
 * og etter reaperen finnes ingen foreldreløs fil. Gravsteinene (arbeidskø uten personopplysninger) er bevisst ikke i planen og forsvinner først når objektet er bekreftet borte.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let policy: PolicyGateway;
let vision: VisionService;
let cameras: VisionCameraService;
let snapshots: VisionSnapshotService;
let pipeline: VisionIngestPipeline;
let storageRoot = "";

const TENANT = "tenant-vis-g3-erase";
const OWNER = "person-g3-owner";
const PERSON_A = "person-g3-a";
const PERSON_B = "person-g3-b";

const identity = (): IdentityContext => ({ person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-g3-erase", device_id: "dev-g3", channel: "api", auth_strength: "active" });

function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))]);
}

async function files(): Promise<string[]> {
  return (await readdir(storageRoot, { recursive: true }).catch(() => [] as string[])).filter((f) => !f.endsWith("snapshots") && f.split("/").length >= 3);
}

interface Twin {
  room: string;
  camera: VisionCamera;
  observation_ids: string[];
  snapshot_id: string;
}

async function seed(person: string, label: string): Promise<Twin> {
  const room = (await vision.createRoom(TENANT, "home", { person_id: person, name: `${label}-rom` })).room_id;
  const camera = await cameras.registerCamera(TENANT, "home", { person_id: person, label, source_type: "home_assistant", source_ref: `camera.${label}`, trigger_entities: ["binary_sensor.x"], room_id: room, zone_kind: "home", route_policy: "store_snapshot" });
  const outcome = await pipeline.processCaptured(
    { tenant_id: TENANT, memory_space: "home", person_id: person, task_id: `task-${label}` },
    camera,
    { source_type: "home_assistant", source_event_id: `binary_sensor.x@${randomUUID()}`, base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 100, getImage: async () => ({ bytes: jpeg(), declared_type: "image/jpeg" }) }
  );
  expect(outcome.status).toBe("recorded");
  expect(outcome.snapshot_id).toBeDefined();
  // opptaksforespørsel (metadata) for samme person
  const iphone = await cameras.registerCamera(TENANT, "home", { person_id: person, label: `${label}-iphone`, source_type: "iphone", source_ref: `device-${label}`, zone_kind: "home", route_policy: "local_only" });
  await admin.query(
    `INSERT INTO vision_capture_requests (request_id, tenant_id, memory_space_id, person_id, camera_id, device_id, expires_at, task_id) VALUES ($1, $2, 'home', $3, $4, $5, now() + interval '5 minutes', 't')`,
    [`cap-${label}`, TENANT, person, iphone.camera_id, `device-${label}`]
  );
  return { room, camera, observation_ids: outcome.observation_ids, snapshot_id: outcome.snapshot_id as string };
}

const TABLES = ["vision_event_observations", "vision_snapshots", "vision_inventory_items", "vision_cameras", "vision_rooms", "vision_capture_requests"] as const;
async function countFor(table: string, person: string): Promise<number> {
  return ((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND person_id = $2`, [TENANT, person])).rows[0] as { n: number }).n;
}
async function vectorsFor(ids: string[]): Promise<number> {
  return ((await admin.query(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_kind = 'vision_event' AND ref_id = ANY($1)`, [ids])).rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-vis-g3-erasure-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_vis_g3_erasure LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_vis_g3_erasure");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Vision G3 Erasure','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${PERSON_A}','A'), ('${PERSON_B}','B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${PERSON_A}','${TENANT}'), ('${PERSON_B}','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-g3-personal','${TENANT}','personal'), ('ms-g3-home','${TENANT}','home');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_vis_g3_erasure", password: "pw2" });
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT] } });
  storageRoot = await mkdtemp(join(tmpdir(), "jarvis-vision-g3-erasure-store-"));
  vision = new VisionService(app);
  cameras = new VisionCameraService(app);
  snapshots = new VisionSnapshotService(app, new LocalFsStorageAdapter(storageRoot), vision);
  const gateway = { async complete() { return { text: JSON.stringify({ detections: [{ event_type: "object_detected", object_label: "paraply", confidence: 0.9 }] }), provider: "local_vision", model: "vl" }; } };
  pipeline = new VisionIngestPipeline({
    pool: app, vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings: new VisionEmbeddingService(app, new LocalHashEmbedding()),
    inventory: new VisionInventoryService(app), enabled: true, storeSnapshots: true
  });
  void VisionCaptureService; // kontrakten testes i modules/vision/test/g3-capture.test.ts; her trengs kun tabellen
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("person-scope erasure fjerner HELE UA-9-avtrykket til person A (og bildeobjektene), uten å røre person B", () => {
  it("alle seks tabeller + vektorer tømmes for A, graven skrives, reaperen sletter filen; B er urørt; ingen foreldreløs fil", async () => {
    const a = await seed(PERSON_A, "alpha");
    const b = await seed(PERSON_B, "bravo");
    for (const table of TABLES) {
      expect(await countFor(table, PERSON_A), `${table} A før`).toBeGreaterThan(0);
      expect(await countFor(table, PERSON_B), `${table} B før`).toBeGreaterThan(0);
    }
    expect(await vectorsFor(a.observation_ids)).toBe(1);
    expect(await files()).toHaveLength(2);

    const service = new ErasureService(app, policy, new LocalHashEmbedding());
    const result = await service.executeErasure({ scope: { type: "person", tenant_id: TENANT, person_id: PERSON_A }, requestId: `req-g3-erase-${randomUUID()}`, identity: identity() });
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();

    for (const table of TABLES) {
      expect(await countFor(table, PERSON_A), `${table} A etter`).toBe(0);
      expect(await countFor(table, PERSON_B), `${table} B etter`).toBeGreaterThan(0);
    }
    expect(await vectorsFor(a.observation_ids)).toBe(0);
    expect(await vectorsFor(b.observation_ids)).toBe(1);

    // Raden er borte, men bildeobjektet ligger fortsatt til reaperen har kjørt - og graven FINNES (ikke stille tapt).
    expect(await files()).toHaveLength(2);
    const tombs = (await admin.query(`SELECT storage_key FROM vision_snapshot_tombstones WHERE tenant_id = $1`, [TENANT])).rows as Array<{ storage_key: string }>;
    expect(tombs).toHaveLength(1);
    expect(tombs[0]?.storage_key).toContain(a.snapshot_id);

    const reaped = await snapshots.reapTombstones(TENANT, "home");
    expect(reaped).toEqual({ deleted: 1, failed: 0, stuck: 0 });
    const remaining = await files();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain(b.snapshot_id);
    expect((await admin.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones`)).rows[0].n).toBe(0);
    // B sitt bilde kan fortsatt leses av B, og A sitt er borte
    expect(await snapshots.read(TENANT, "home", PERSON_B, b.snapshot_id)).not.toBeNull();
    expect(await snapshots.read(TENANT, "home", PERSON_A, a.snapshot_id)).toBeNull();
  });

  it("erasure av hele memory_space 'home' sletter ALT UA-9 i rommet (inkl. vektorer og inventar), og reaperen rydder alle filer", async () => {
    await seed(PERSON_A, "gamma");
    const service = new ErasureService(app, policy, new LocalHashEmbedding());
    const result = await service.executeErasure({ scope: { type: "memory_space", tenant_id: TENANT, memory_space_id: "home" }, requestId: `req-g3-erase-space-${randomUUID()}`, identity: identity() });
    expect(result.status).toBe("completed");
    for (const table of [...TABLES]) {
      expect(((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND memory_space_id = 'home'`, [TENANT])).rows[0] as { n: number }).n, table).toBe(0);
    }
    expect(((await admin.query(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_kind = 'vision_event' AND tenant_id = $1`, [TENANT])).rows[0] as { n: number }).n).toBe(0);
    const reaped = await snapshots.reapTombstones(TENANT, "home");
    expect(reaped.failed).toBe(0);
    expect(await files()).toHaveLength(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones`)).rows[0].n).toBe(0);
  });
});
