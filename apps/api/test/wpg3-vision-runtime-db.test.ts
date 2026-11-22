import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import {
  LocalFsStorageAdapter, VisionCameraService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService, VisionService, VisionSnapshotService, type VisionCamera, type VisionHttpFetch,
  type VisionMaintenanceSummary
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
    expect(runtime.status().maintenance).toEqual({ light: null, full: null, light_run: { running_since: null, skipped_ticks: 0, abandoned_runs: 0 } });

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
    expect(off.status()).toEqual({
      poller: { enabled: false }, maintenance: { light: null, full: null, light_run: { running_since: null, skipped_ticks: 0, abandoned_runs: 0 } }, ingest: { inventory_label_invalid: 0, inventory_label_rejected: 0, last_inventory_skip_at: null },
      storage: { maintenance_enabled: false, writing_enabled: false }, classifier: false, embeddings: true
    });
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

describe("review delta B LOW-D4: lett vedlikehold overlapper aldri seg selv, og full kjøring rapporterer ryddede skriverester", () => {
  const pause = (ms: number): Promise<"timeout"> => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));

  it("mens en lett kjøring pågår hoppes en overlappende tikk over (ingen andre reaper, ingen ventende databasekall); vakten slippes etter suksess OG etter en feil, så neste tikk faktisk jobber", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-overlap-"));
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root })));
    // En eksklusiv lås på bildetabellen holder den første kjøringen fast i `reapPending` (første spørring mot tabellen) - deterministisk, uten å stole på tidsbruk.
    const blocker = await db.admin.connect();
    let first: Promise<void> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE vision_snapshots IN ACCESS EXCLUSIVE MODE");
      first = runtime.lightMaintenance();
      first.catch(() => undefined); // ingen ubehandlet avvisning mens vi venter
      const waiting = async (): Promise<number> => scalar(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%vision_snapshots%' AND pid <> pg_backend_pid()`);
      for (let i = 0; i < 100 && (await waiting()) === 0; i += 1) await pause(50);
      expect(await waiting(), "den første kjøringen står fast på låsen").toBe(1);
      const second = await Promise.race([runtime.lightMaintenance().then(() => "skipped" as const), pause(1_500)]);
      expect(second, "den overlappende tikken kom tilbake med en gang (uten vakt ville den også stått fast på låsen)").toBe("skipped");
      expect(await waiting(), "ingen annen kjøring står og venter på tabellen").toBe(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    await first; // den første kjøringen fullfører normalt når låsen slippes
    // Vakten er sluppet etter suksess: en ny tikk rydder en gravstein for et objekt som ikke finnes (idempotent sletting).
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key) VALUES ($1, 'home', 'local_fs', 'snapshots/overlap/after-success')`, [T1.tenant]);
    await runtime.lightMaintenance();
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = 'snapshots/overlap/after-success'`)).toBe(0);
    // ... og etter en FEIL: en gravstein som er «stuck» (EISDIR) får lett kjøring til å kaste - og neste tikk kjører likevel (kaster igjen i stedet for å bli hoppet over).
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = "snapshots/overlap/stuck-dir";
    await mkdir(join(root, key), { recursive: true });
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key, attempts) VALUES ($1, 'home', 'local_fs', $2, 4)`, [T1.tenant, key]);
    await expect(runtime.lightMaintenance()).rejects.toThrow("vision_maintenance_failed:1");
    await expect(runtime.lightMaintenance(), "vakten ble sluppet etter feilen: neste tikk kjørte og kastet igjen").rejects.toThrow("vision_maintenance_failed:1");
    await rm(join(root, key), { recursive: true });
    await runtime.lightMaintenance();
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = $1`, [key])).toBe(0);
    runtime.stop();
  });

  it("full kjøring rydder en foreldreløs skriverest (eldre enn 6 t) og rapporterer den i status().maintenance.full.temp_files_purged; lett kjøring teller 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-tmp-"));
    const dir = join(root, "snapshots", "aa");
    await mkdir(dir, { recursive: true });
    const orphan = join(dir, `snap-1.tmp-${randomUUID()}`);
    await writeFile(orphan, "halvskrevet");
    const old = new Date(Date.now() - 10 * 3_600_000);
    await utimes(orphan, old, old);
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: root })));
    await runtime.lightMaintenance();
    expect(runtime.status().maintenance.light).toMatchObject({ temp_files_purged: 0, temp_files_truncated: false });
    expect(await filesIn(root)).toEqual([orphan]); // lett kjøring rører den ikke
    expect((await runtime.fullMaintenance()).failed).toEqual([]);
    expect(runtime.status().maintenance.full).toMatchObject({ failed: 0, temp_files_purged: 1, temp_files_truncated: false });
    expect(await filesIn(root)).toEqual([]);
    runtime.stop();
  });
});

describe("review delta2 A LOW-E3 + B LOW-E1: hoppede inventarskrivinger er SYNLIGE i status().ingest (kun tall og tidspunkt)", () => {
  it("startverdi 0/null; et hopp (databasen avviser en etikett JS godtok) teller kumulativt i status().ingest og logges - aldri med etikettinnhold", async () => {
    const gateway = new ScriptedGateway();
    gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "driftet", confidence: 0.9 }]);
    const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_CLASSIFIER: "on", JARVIS_VISION_LOCAL_URL: "http://127.0.0.1:11434" }, { gateway })));
    expect(runtime.status().ingest).toEqual({ inventory_label_invalid: 0, inventory_label_rejected: 0, last_inventory_skip_at: null });
    const room = (await vision.createRoom(T1.tenant, "home", { person_id: T1.owner, name: "Ingest-rom" })).room_id;
    const camera = await cameras.registerCamera(T1.tenant, "home", {
      person_id: T1.owner, label: "Ingest", source_type: "home_assistant", source_ref: "camera.ingest_skip", trigger_entities: [], zone_kind: "home", route_policy: "local_only", room_id: room
    });
    const ctx = { tenant_id: T1.tenant, memory_space: "home" as const, person_id: T1.owner, task_id: "task-ingest-skip" };
    const event = (id: number) => ({
      source_type: "home_assistant", source_event_id: `binary_sensor.ingest@skip-${id}`, base_event_type: "motion_detected" as const, observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
      getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
    });
    const check = "vision_inventory_items_object_label_check";
    const original = ((await db.admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [check])).rows[0] as { def: string }).def.replace(/^CHECK\s*/, "").replace(/\s+NOT VALID$/, "");
    await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${check}`);
    await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${check} CHECK (object_label <> 'driftet') NOT VALID`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = await runtime.pipeline.processCaptured(ctx, camera, event(1));
      expect(first).toMatchObject({ status: "recorded", inventory_skipped: { invalid: 0, rejected: 1 } });
      const afterFirst = runtime.status().ingest;
      expect(afterFirst).toMatchObject({ inventory_label_invalid: 0, inventory_label_rejected: 1 });
      expect(afterFirst.last_inventory_skip_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      await runtime.pipeline.processCaptured(ctx, camera, event(2));
      expect(runtime.status().ingest.inventory_label_rejected).toBe(2); // kumulativt
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("vision_inventory_skipped"));
      expect(lines).toHaveLength(2); // én logglinje per hendelse
      expect(JSON.parse(lines[0] as string)).toMatchObject({ msg: "vision_inventory_skipped", code: "inventory_label_rejected", invalid: 0, rejected: 1 });
      expect(JSON.stringify(runtime.status())).not.toContain("driftet");
      expect(lines.join("\n")).not.toContain("driftet");
    } finally {
      await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${check}`);
      await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${check} CHECK ${original}`);
      runtime.stop();
    }
  });
});

describe("review delta2 B LOW-E2: lett vedlikehold kan ikke holdes fast for alltid - databasegrenser, tidsbegrenset vakt og SYNLIGE hoppede tikk", () => {
  const pause = (ms: number): Promise<"timeout"> => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
  const waiting = (): Promise<number> => scalar(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%vision_snapshots%' AND pid <> pg_backend_pid()`);
  const until = async (predicate: () => Promise<boolean>, what: string): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if (await predicate()) return;
      await pause(50);
    }
    throw new Error(`tidsavbrudd: ventet på ${what}`);
  };
  /** Faller om `promise` ikke er ferdig innen `ms` - uten å etterlate en hengende timer eller en ubehandlet avvisning. */
  const withDeadline = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
    promise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`HENGT: ${what}`)), ms); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const lockSnapshotsTable = async (): Promise<pg.PoolClient> => {
    const blocker = await db.admin.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE vision_snapshots IN ACCESS EXCLUSIVE MODE");
    return blocker;
  };
  const release = async (blocker: pg.PoolClient): Promise<void> => {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  };
  const storageEnv = async (): Promise<Record<string, string>> => ({ JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: await mkdtemp(join(tmpdir(), "jarvis-vision-g3rt-e2-")) });
  const emptySummary = (over: Partial<VisionMaintenanceSummary> = {}): VisionMaintenanceSummary => ({
    spaces: 0, snapshots_purged: 0, pending_reaped: 0, tombstones_deleted: 0, tombstones_failed: 0, tombstones_stuck: 0, temp_files_purged: 0, temp_files_truncated: false,
    inventory_purged: 0, captures_expired: 0, captures_deleted: 0, vectors_backfilled: 0, failed: [], ...over
  });

  it("lock_timeout: en forlatt tabell-lås gir en SYNLIG sveipefeil etter grensen i stedet for en evig venting (lett OG full kjøring); vakten er sluppet, og neste tikk kjører når låsen er borte", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = track(buildVisionRuntime(baseDeps(await storageEnv(), { maintenance: { lockTimeoutMs: 400 } })));
    const blocker = await lockSnapshotsTable();
    try {
      await expect(withDeadline(runtime.lightMaintenance(), 25_000, "lett vedlikehold ble holdt fast av tabell-låsen")).rejects.toThrow(/^vision_maintenance_failed:\d+$/);
      const failures = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("vision_maintenance_failed"));
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures.join("\n")).toMatch(/lock timeout/); // Postgres sin egen kode-tekst: ingen stier, ingen innhold
      expect(runtime.status().maintenance.light_run).toEqual({ running_since: null, skipped_ticks: 0, abandoned_runs: 0 }); // vakten er sluppet etter feilen
      const full = await withDeadline(runtime.fullMaintenance(), 25_000, "full vedlikeholdskjøring ble holdt fast av tabell-låsen"); // samme grenser (kaster ikke: failed-listen bærer feilene)
      expect(full.failed.length).toBeGreaterThanOrEqual(1);
      expect(full.failed.map((failure) => failure.error).join("\n")).toMatch(/lock timeout/);
    } finally {
      await release(blocker);
    }
    await runtime.lightMaintenance(); // låsen er borte: kjører og lykkes
    expect(runtime.status().maintenance.light).toMatchObject({ failed: 0 });
    runtime.stop();
  }, 90_000);

  it("ekte hengning (ingen databasegrenser): etter tidsgrensen regnes kjøringen som forlatt og en erstatning starter (og henger også); begge fullfører når låsen slippes, og alt nullstilles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fakeNow = Date.parse("2026-11-19T12:00:00.000Z");
    const runtime = track(buildVisionRuntime(baseDeps(await storageEnv(), { maintenance: { maxRunMs: 60_000, statementTimeoutMs: 0, lockTimeoutMs: 0, now: () => fakeNow } })));
    const runs: Array<Promise<unknown>> = [];
    const startRun = (): void => {
      const run = runtime.lightMaintenance();
      run.catch(() => undefined);
      runs.push(run);
    };
    const blocker = await lockSnapshotsTable();
    try {
      startRun();
      await until(async () => (await waiting()) === 1, "den første kjøringen står fast på låsen");
      fakeNow += 30_000;
      await runtime.lightMaintenance(); // innenfor tidsgrensen: hoppes over (kommer tilbake med en gang)
      expect(await waiting(), "ingen ny kjøring mot den låste tabellen").toBe(1);
      expect(runtime.status().maintenance.light_run).toMatchObject({ skipped_ticks: 1, abandoned_runs: 0 });
      fakeNow += 40_000; // 70 s siden første kjøring startet: over tidsgrensen på 60 s
      startRun();
      await until(async () => (await waiting()) === 2, "erstatningen står også fast på låsen (den første kjøringen er forlatt, ikke avbrutt)");
      expect(runtime.status().maintenance.light_run).toEqual({ running_since: new Date(fakeNow).toISOString(), skipped_ticks: 1, abandoned_runs: 1 });
    } finally {
      await release(blocker);
    }
    await withDeadline(Promise.allSettled(runs), 30_000, "begge kjøringene fullfører når låsen er borte");
    expect(runtime.status().maintenance.light_run).toEqual({ running_since: null, skipped_ticks: 1, abandoned_runs: 0 });
    await runtime.lightMaintenance(); // vakten er fri
    expect(runtime.status().maintenance.light_run.skipped_ticks).toBe(1);
    runtime.stop();
  }, 90_000);

  describe("vaktens logikk (styrt sveip, injisert klokke: deterministisk)", () => {
    type Pending = { resolve: (summary: VisionMaintenanceSummary) => void; reject: (err: Error) => void };
    const harness = async (over: { maxRunMs?: number; skipLogIntervalMs?: number } = {}) => {
      const pending: Pending[] = [];
      let fakeNow = Date.parse("2026-11-19T12:00:00.000Z");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const sweep = (): Promise<VisionMaintenanceSummary> => new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      const runtime = track(buildVisionRuntime(baseDeps({ JARVIS_VISION_ENABLED: "on" }, { maintenance: { maxRunMs: over.maxRunMs ?? 60_000, skipLogIntervalMs: over.skipLogIntervalMs ?? 600_000, now: () => fakeNow, sweep } })));
      const started: Array<Promise<void>> = [];
      return {
        runtime, pending,
        advance: (ms: number): void => { fakeNow += ms; },
        iso: (): string => new Date(fakeNow).toISOString(),
        tick: (): Promise<void> => { const run = runtime.lightMaintenance(); run.catch(() => undefined); started.push(run); return run; },
        run: (index: number): Promise<void> => started[index] as Promise<void>,
        lightRun: () => runtime.status().maintenance.light_run,
        skipLines: (): Array<Record<string, unknown>> => warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>).filter((line) => line["msg"] === "vision_light_maintenance_skipped"),
        overrunLines: (): Array<Record<string, unknown>> => errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("vision_light_maintenance_overrun")).map((line) => JSON.parse(line) as Record<string, unknown>)
      };
    };

    it("startverdi: ingen kjøring pågår, ingen hoppede tikk, ingen forlatte; en kjøring som fullfører setter utfallet og frigir vakten (running_since null)", async () => {
      const h = await harness();
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 0, abandoned_runs: 0 });
      const start = h.iso();
      void h.tick();
      expect(h.pending).toHaveLength(1);
      expect(h.lightRun()).toEqual({ running_since: start, skipped_ticks: 0, abandoned_runs: 0 });
      h.pending[0]?.resolve(emptySummary({ tombstones_deleted: 5 }));
      await h.run(0);
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 0, abandoned_runs: 0 });
      expect(h.runtime.status().maintenance.light).toMatchObject({ failed: 0, tombstones_deleted: 5 });
    });

    it("en tikk innenfor tidsgrensen hoppes over og TELLES; første hopp logges (kode og tall, ingen innhold), neste innen logg-intervallet logges ikke, og etter intervallet logges det igjen", async () => {
      const h = await harness({ maxRunMs: 3_600_000, skipLogIntervalMs: 600_000 });
      void h.tick();
      h.advance(30_000);
      await h.tick();
      expect(h.pending, "ingen ny kjøring").toHaveLength(1);
      expect(h.lightRun()).toMatchObject({ skipped_ticks: 1 });
      expect(h.skipLines()).toEqual([{ msg: "vision_light_maintenance_skipped", reason: "previous_run_in_progress", running_ms: 30_000, skipped_ticks: 1 }]);
      h.advance(1_000);
      await h.tick();
      expect(h.lightRun()).toMatchObject({ skipped_ticks: 2 });
      expect(h.skipLines(), "rate-begrenset: ikke en ny logglinje for hver tikk").toHaveLength(1);
      h.advance(600_000);
      await h.tick();
      expect(h.lightRun()).toMatchObject({ skipped_ticks: 3 });
      expect(h.skipLines().map((line) => line["skipped_ticks"])).toEqual([1, 3]);
      h.pending[0]?.resolve(emptySummary());
      await h.run(0);
    });

    it("første hoppede tikk av HVER kjøring logges, også innen logg-intervallet fra forrige kjørings hopp (en ny hengning skal ikke skjules av den forrige)", async () => {
      const h = await harness({ maxRunMs: 3_600_000, skipLogIntervalMs: 600_000 });
      void h.tick();
      h.advance(10_000);
      await h.tick();
      expect(h.skipLines()).toHaveLength(1);
      h.pending[0]?.resolve(emptySummary());
      await h.run(0); // den første kjøringen er ferdig
      const second = h.tick(); // en NY kjøring (som henger)
      expect(h.pending).toHaveLength(2);
      h.advance(10_000); // fortsatt langt innenfor logg-intervallet (600 s) fra forrige hopp
      await h.tick();
      expect(h.skipLines().map((line) => line["skipped_ticks"]), "det første hoppet i den nye kjøringen logges").toEqual([1, 2]);
      h.pending[1]?.resolve(emptySummary());
      await second;
    });

    it("over tidsgrensen regnes kjøringen som FORLATT (logget) og en erstatning starter; en forlatt kjøring som fullfører senere frigir ikke den nyes vakt og overskriver ikke dens utfall", async () => {
      const h = await harness();
      void h.tick();
      h.advance(61_000);
      const replacementStart = h.iso();
      void h.tick();
      expect(h.pending, "erstatningen startet").toHaveLength(2);
      expect(h.lightRun()).toEqual({ running_since: replacementStart, skipped_ticks: 0, abandoned_runs: 1 });
      expect(h.overrunLines()).toEqual([{ msg: "vision_light_maintenance_overrun", running_ms: 61_000, max_run_ms: 60_000, abandoned_runs: 1 }]);
      // Den FORLATTE kjøringen fullfører først (med et utfall som ikke skal bli stående): vakten til erstatningen og statusen er urørt.
      h.pending[0]?.resolve(emptySummary({ tombstones_deleted: 7 }));
      await h.run(0);
      expect(h.lightRun()).toEqual({ running_since: replacementStart, skipped_ticks: 0, abandoned_runs: 0 });
      expect(h.runtime.status().maintenance.light, "en forlatt kjøring overskriver aldri en nyere kjørings utfall").toBeNull();
      h.advance(1_000);
      await h.tick();
      expect(h.pending, "vakten til erstatningen holder fortsatt: den forlattes ferdigstilling slapp den ikke").toHaveLength(2);
      expect(h.lightRun()).toMatchObject({ skipped_ticks: 1 });
      // Erstatningen fullfører: NÅ settes utfallet og vakten frigis.
      h.pending[1]?.resolve(emptySummary({ tombstones_deleted: 9 }));
      await h.run(1);
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 1, abandoned_runs: 0 });
      expect(h.runtime.status().maintenance.light).toMatchObject({ tombstones_deleted: 9 });
    });

    it("høyst to forlatte kjøringer om gangen: den fjerde tikken starter ingenting (`previous_runs_stuck`, logget og talt), og alt nullstilles når kjøringene fullfører (også i en annen rekkefølge)", async () => {
      const h = await harness();
      void h.tick(); // A
      h.advance(61_000);
      void h.tick(); // B (A forlatt)
      h.advance(61_000);
      void h.tick(); // C (B forlatt)
      expect(h.pending).toHaveLength(3);
      expect(h.lightRun()).toMatchObject({ abandoned_runs: 2 });
      h.advance(61_000);
      await h.tick(); // D: nektes
      expect(h.pending, "ingen fjerde kjøring").toHaveLength(3);
      expect(h.lightRun()).toMatchObject({ abandoned_runs: 2, skipped_ticks: 1 });
      expect(h.skipLines()).toEqual([{ msg: "vision_light_maintenance_skipped", reason: "previous_runs_stuck", running_ms: 61_000, skipped_ticks: 1 }]);
      expect(h.overrunLines().map((line) => line["abandoned_runs"])).toEqual([1, 2]);
      // De fullfører i omvendt rekkefølge: den nyeste (C) først. Vakten frigis, de to forlatte teller ned når de blir ferdige.
      h.pending[2]?.resolve(emptySummary());
      await h.run(2);
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 1, abandoned_runs: 2 });
      h.pending[0]?.resolve(emptySummary());
      h.pending[1]?.resolve(emptySummary());
      await Promise.all([h.run(0), h.run(1)]);
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 1, abandoned_runs: 0 });
      // Vakten er fri igjen: en ny tikk starter en ny kjøring.
      const fresh = h.tick();
      expect(h.pending).toHaveLength(4);
      h.pending[3]?.resolve(emptySummary());
      await fresh;
    });

    it("en kjøring som FEILER (kastet feil eller failed-liste) frigir vakten, og feilen kastes videre som før; en forlatt kjøring som feiler senere påvirker ikke den nyes vakt", async () => {
      const h = await harness();
      void h.tick();
      h.pending[0]?.resolve(emptySummary({ failed: [{ tenant_id: "t", memory_space_id: "home", error: "tombstones_stuck:1" }] }));
      await expect(h.run(0)).rejects.toThrow("vision_maintenance_failed:1");
      expect(h.runtime.status().maintenance.light).toMatchObject({ failed: 1 }); // utfallet er satt selv om kjøringen kastet
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 0, abandoned_runs: 0 });
      void h.tick(); // frisk kjøring
      h.pending[1]?.reject(new Error("tilkobling_brutt"));
      await expect(h.run(1)).rejects.toThrow("tilkobling_brutt");
      expect(h.lightRun()).toEqual({ running_since: null, skipped_ticks: 0, abandoned_runs: 0 });
      // forlatt kjøring som feiler mens erstatningen pågår
      void h.tick(); // A (index 2)
      h.advance(61_000);
      void h.tick(); // B (index 3): A forlatt
      const bStart = h.iso();
      h.pending[2]?.reject(new Error("sent_feil"));
      await expect(h.run(2)).rejects.toThrow("sent_feil");
      expect(h.lightRun()).toEqual({ running_since: bStart, skipped_ticks: 0, abandoned_runs: 0 });
      h.pending[3]?.resolve(emptySummary());
      await h.run(3);
      expect(h.lightRun().running_since).toBeNull();
    });
  });

  it("ugyldige vaktverdier kastes ved oppstart, ikke først under en kjøring (maxRunMs < 1, negative/ikke-heltall databasegrenser)", async () => {
    const env = { JARVIS_VISION_ENABLED: "on" };
    expect(() => buildVisionRuntime(baseDeps(env, { maintenance: { maxRunMs: 0 } }))).toThrow("vision_maintenance_guard_invalid");
    expect(() => buildVisionRuntime(baseDeps(env, { maintenance: { skipLogIntervalMs: -1 } }))).toThrow("vision_maintenance_guard_invalid");
    expect(() => buildVisionRuntime(baseDeps(env, { maintenance: { lockTimeoutMs: -1 } }))).toThrow("vision_db_limits_invalid");
    expect(() => buildVisionRuntime(baseDeps(env, { maintenance: { statementTimeoutMs: 1.5 } }))).toThrow("vision_db_limits_invalid");
  });
});
