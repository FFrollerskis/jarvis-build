import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import {
  LocalFsStorageAdapter, VisionCameraService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService, VisionService, VisionSnapshotService, type VisionCamera, type VisionHttpFetch
} from "@jarvis/vision";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { buildVisionRuntime } from "../src/vision-runtime.ts";

/**
 * WP-G3 (D-465), review B-M1 og B-M2: kjøretidskoblingen (apps/api/src/vision-runtime.ts) mot en EKTE Postgres og ekte lokal lagring.
 *  B-M1: bildefiler slettes (retensjon, kamera-fjerning, gravsteiner) også når JARVIS_VISION_STORE_SNAPSHOTS er AV så lenge JARVIS_VISION_STORAGE_DIR er satt - flagget styrer kun SKRIVING.
 *  B-M2: HA-polleren i kjøretiden leser KUN eierens tenant (`tenantIds: [ownerTenantId]`): en annen tenants kamera polles aldri med eierens HA-credential.
 *  B-L8: en gravstein som ikke lar seg slette (stuck) og et sveip med feil KASTES av lett vedlikehold i stedet for å ligge stille i en teller; `status()` (= `/vision/status`) samler siste vedlikeholdsutfall og pollerens feilserie.
 */
let db: VisionDb;
let T1: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let cameras: VisionCameraService;
let n = 0;
const runtimes: Array<{ stop(): void }> = [];

const baseDeps = (env: Record<string, string>, over: Record<string, unknown> = {}) => ({
  pool: db.app,
  env: env as NodeJS.ProcessEnv,
  vision,
  gateway: new ScriptedGateway(),
  memoryEmbedding: new LocalHashEmbedding(),
  devices: { approverFor: async () => undefined },
  ownerTenantId: T1.tenant,
  secrets: { get: async (name: string) => (name === "JARVIS_HA_BASE_URL" ? "http://ha.test:8123" : name === "JARVIS_HA_TOKEN" ? "tok-test-0001" : null) },
  ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } },
  ...over
});

const track = <T extends { stop(): void } | null>(runtime: T): NonNullable<T> => {
  if (runtime === null) throw new Error("runtime_null");
  runtimes.push(runtime);
  return runtime as NonNullable<T>;
};

const filesIn = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
const scalar = async (sql: string, params: unknown[] = []): Promise<number> => ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;

beforeAll(async () => {
  db = await startVisionDb("g3rt");
  T1 = await seedTenant(db, "g3rt-t1");
  T2 = await seedTenant(db, "g3rt-t2");
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
}, 240_000);

afterAll(async () => {
  for (const r of runtimes) r.stop();
  await db?.stop();
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("B-M2: HA-polleren i kjøretiden leser kun eierens tenant", () => {
  const register = (tenant: string, person: string, entity: string, ref: string): Promise<VisionCamera> =>
    cameras.registerCamera(tenant, "home", { person_id: person, label: `Kamera ${ref}`, source_type: "home_assistant", source_ref: ref, trigger_entities: [entity], zone_kind: "home", route_policy: "local_only" });

  it("runtime.poller.tick() ber HA kun om eierens utløsere - en annen tenants kamera polles aldri med eierens credential (og valget følger ownerTenantId, det er ikke hardkodet)", async () => {
    await register(T1.tenant, T1.owner, "binary_sensor.t1_front", "camera.t1_front");
    await register(T2.tenant, T2.owner, "binary_sensor.t2_front", "camera.t2_front");
    const asked: string[] = [];
    const fetchImpl: VisionHttpFetch = async (url) => {
      asked.push(new URL(url).pathname);
      return new Response(JSON.stringify({ state: "off", attributes: { device_class: "motion" }, last_changed: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const env = { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_HA_POLL: "on" };

    const asT1 = track(buildVisionRuntime(baseDeps(env, { fetchImpl, ownerTenantId: T1.tenant })));
    const first = await asT1.poller?.tick();
    expect(first).toMatchObject({ status: "ok", cameras_polled: 1 });
    expect(asked).toEqual(["/api/states/binary_sensor.t1_front"]);
    asT1.stop();

    asked.length = 0;
    const asT2 = track(buildVisionRuntime(baseDeps(env, { fetchImpl, ownerTenantId: T2.tenant })));
    expect(await asT2.poller?.tick()).toMatchObject({ status: "ok", cameras_polled: 1 });
    expect(asked).toEqual(["/api/states/binary_sensor.t2_front"]);
    asT2.stop();
  });

  it("kjøretiden gir polleren en ikke-tom, enkelt-tenant-liste: uten HA-poll bygges ingen poller i det hele tatt", () => {
    const off = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on" })));
    expect(off.poller).toBeNull();
    off.stop();
  });
});

describe("B-M1: bildefiler slettes også når JARVIS_VISION_STORE_SNAPSHOTS er av (STORAGE_DIR styrer vedlikeholdet, STORE_SNAPSHOTS kun skrivingen)", () => {
  it("utløpt bilde, fjernet kamera og forlatt gravstein: lett og full vedlikeholdskjøring sletter filene; en ny hendelse lagrer derimot ingenting", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-"));
    // En tidligere økt der lagring var PÅ: to bilder ligger på disk.
    const earlierGateway = new ScriptedGateway();
    earlierGateway.text = detectionsJson([{ event_type: "object_detected", object_label: "pakke", confidence: 0.9 }]);
    const earlier = new VisionIngestPipeline({
      pool: db.app, vision, classifier: new VisionClassifier({ gateway: earlierGateway }), snapshots: new VisionSnapshotService(db.app, new LocalFsStorageAdapter(root), vision),
      embeddings: new VisionEmbeddingService(db.app, new LocalHashEmbedding()), inventory: new VisionInventoryService(db.app), enabled: true, storeSnapshots: true
    });
    const ctx = { tenant_id: T1.tenant, memory_space: "home" as const, person_id: T1.owner, task_id: "task-m1" };
    const cam = async (ref: string): Promise<VisionCamera> =>
      cameras.registerCamera(T1.tenant, "home", { person_id: T1.owner, label: ref, source_type: "home_assistant", source_ref: ref, trigger_entities: [], zone_kind: "home", route_policy: "store_snapshot" });
    const capture = async (camera: VisionCamera): Promise<string> => {
      n += 1;
      const out = await earlier.processCaptured(ctx, camera, {
        source_type: "home_assistant", source_event_id: `binary_sensor.x@m1-${n}`, base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
        getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
      });
      expect(out.status).toBe("recorded");
      return out.snapshot_id as string;
    };
    const expiring = await cam("camera.m1_expiring");
    const removed = await cam("camera.m1_removed");
    const expiringId = await capture(expiring);
    await capture(removed);
    expect(await filesIn(root)).toHaveLength(2);
    expect(await cameras.removeCamera(T1.tenant, "home", T1.owner, removed.camera_id, { confirm: true })).toBe(true);
    await db.admin.query(`UPDATE vision_snapshots SET retention_expires_at = now() - interval '1 minute' WHERE snapshot_id = $1`, [expiringId]);

    // Lagring er AV (STORE_SNAPSHOTS), men mappen er satt: vedlikeholdet MÅ likevel rydde.
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root })));
    await runtime.lightMaintenance();
    expect(await filesIn(root), "lett kjøring: gravsteinen til det fjernede kameraet er reapet").toHaveLength(1);
    const full = await runtime.fullMaintenance();
    expect(full.failed).toEqual([]);
    expect(await filesIn(root), "full kjøring: utløpt bilde slettet og reapet").toHaveLength(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE tenant_id = $1`, [T1.tenant])).toBe(0);

    // ... men flagget styrer fortsatt SKRIVING: en store_snapshot-hendelse lagrer ikke noe bilde.
    const out = await runtime.pipeline.processCaptured(ctx, expiring, {
      source_type: "home_assistant", source_event_id: "binary_sensor.x@m1-after", base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
      getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
    });
    expect(out.status).toBe("recorded");
    expect(out.snapshot_id).toBeUndefined();
    expect(await filesIn(root)).toHaveLength(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE camera_id = $1`, [expiring.camera_id])).toBe(0);
    runtime.stop();
  });

  it("uten STORAGE_DIR finnes ingen lagringstjeneste og vedlikeholdet kjører uten feil (ingenting å rydde)", async () => {
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on" })));
    expect(await runtime.fullMaintenance()).toMatchObject({ failed: [] });
    await runtime.lightMaintenance();
    runtime.stop();
  });
});

describe("B-L8: vedlikeholdsfeil og stuck gravsteiner synes (kastes, full-kjøringens failed-liste, /vision/status)", () => {
  it("en gravstein som ikke lar seg slette: lett kjøring kaster FØRST når den er «stuck» (5 forsøk), full kjøring returnerer feilen, status() har tallene - alt er grønt igjen når lagringen er reparert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-b8-"));
    const key = "snapshots/stuck/b8-dir";
    // En katalog på nøkkelens sti kan ikke slettes med unlink (EISDIR): en deterministisk «ulesbar gravstein». Tre forsøk er allerede gjort.
    await mkdir(join(root, key), { recursive: true });
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key, attempts) VALUES ($1, 'home', 'local_fs', $2, 3)`, [T1.tenant, key]);
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root })));
    expect(runtime.status().maintenance).toEqual({ light: null, full: null });

    await runtime.lightMaintenance(); // forsøk 4: feilet, men ennå ikke «stuck» (grensen er 5)
    expect(runtime.status().maintenance.light).toMatchObject({ failed: 0, tombstones_failed: 1, tombstones_stuck: 0 });
    await expect(runtime.lightMaintenance()).rejects.toThrow("vision_maintenance_failed:1"); // forsøk 5: stuck = sveipefeil
    const light = runtime.status().maintenance.light as { at: string; failed: number };
    expect(light).toMatchObject({ failed: 1, tombstones_failed: 1, tombstones_stuck: 1, tombstones_deleted: 0 });
    expect(new Date(light.at).toISOString()).toBe(light.at);

    const full = await runtime.fullMaintenance();
    expect(full.failed).toEqual([{ tenant_id: T1.tenant, memory_space_id: "home", error: "tombstones_stuck:1" }]); // DailyScheduler.assertNoSweepFailures kaster på dette
    expect(runtime.status().maintenance.full).toMatchObject({ failed: 1, tombstones_stuck: 1 });
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = $1`, [key])).toBe(1); // ingenting stille tapt

    await rm(join(root, key), { recursive: true }); // volumet repareres
    await runtime.lightMaintenance();
    expect(runtime.status().maintenance.light).toMatchObject({ failed: 0, tombstones_deleted: 1, tombstones_stuck: 0 });
    expect((await runtime.fullMaintenance()).failed).toEqual([]);
    runtime.stop();
  });

  it("status(): uten poller/lagring er alt av; med STORAGE_DIR (uten STORE_SNAPSHOTS) er KUN vedlikeholdet på, og med STORE_SNAPSHOTS også skrivingen - ingen stier, URL-er eller hemmeligheter i svaret", async () => {
    const off = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on" })));
    expect(off.status()).toEqual({ poller: { enabled: false }, maintenance: { light: null, full: null }, storage: { maintenance_enabled: false, writing_enabled: false }, classifier: false, embeddings: true });
    off.stop();
    const root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-st-"));
    const maintenanceOnly = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root })));
    expect(maintenanceOnly.status().storage).toEqual({ maintenance_enabled: true, writing_enabled: false });
    maintenanceOnly.stop();
    const writing = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root, JARVIS_VISION_STORE_SNAPSHOTS: "on" })));
    expect(writing.status().storage).toEqual({ maintenance_enabled: true, writing_enabled: true });
    expect(JSON.stringify(writing.status())).not.toContain(root);
    writing.stop();
  });

  it("status().poller viser siste runde og feilserien: HA nede -> consecutive_failures og doblet ventetid (20 s -> 40 s), neste vellykkede runde nullstiller - uten vertsnavn, adresser eller token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await cameras.registerCamera(T1.tenant, "home", { person_id: T1.owner, label: "Helse-kamera", source_type: "home_assistant", source_ref: "camera.l8_front", trigger_entities: ["binary_sensor.l8_front"], zone_kind: "home", route_policy: "local_only" });
    let down = true;
    const fetchImpl: VisionHttpFetch = async () => {
      if (down) throw new Error("connect ECONNREFUSED 10.0.0.5:8123");
      return new Response(JSON.stringify({ state: "off", attributes: { device_class: "motion" }, last_changed: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_HA_POLL: "on" }, { fetchImpl })));
    expect(runtime.status().poller).toEqual({ enabled: true, last_tick_at: null, last_status: null, last_reason: null, last_source_error: null, consecutive_failures: 0, next_delay_ms: 20_000 });
    await runtime.pollerHandle?.tick();
    const failing = runtime.status().poller;
    expect(failing).toMatchObject({ enabled: true, last_status: "ok", consecutive_failures: 1, next_delay_ms: 40_000 });
    expect((failing as { last_source_error: string }).last_source_error).toMatch(/^[a-z0-9_]{3,60}$/);
    expect(JSON.stringify(failing)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|tok-test|ha\.test/);
    down = false;
    await runtime.pollerHandle?.tick();
    expect(runtime.status().poller).toMatchObject({ enabled: true, last_status: "ok", last_source_error: null, consecutive_failures: 0, next_delay_ms: 20_000 });
    runtime.stop();
  });
});
