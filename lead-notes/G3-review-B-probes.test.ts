import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { LocalFsStorageAdapter, VisionCameraService, VisionCaptureService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService, VisionService, VisionSnapshotService } from "@jarvis/vision";
import { FakeDevice, TestDeviceRegistry } from "../../../modules/vision/test/support/fake-device.ts";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { buildVisionRuntime } from "../src/vision-runtime.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * REVIEWER B (WP-G3) - PROBER, IKKE en del av byggerens gren. Kopieres midlertidig til apps/api/test/zz-revB-g3-probes.test.ts og slettes etterpå.
 *  P1: atomisk engangsforbruk under en DETERMINISTISK barriere (alle tre har passert state-sjekken før noen forbruker). Ekte kode: nøyaktig 1 vinner. Mutant uten `state = 'pending'`: 3.
 *  P2: mykt lagringstak - samtidige begin() kan overskride taket.
 *  P3: gravsteiner reapes IKKE når JARVIS_VISION_STORE_SNAPSHOTS er av (kun STORAGE_DIR satt) - fila blir liggende; med STORE_SNAPSHOTS=on reapes den.
 *  P4: pre-auth kroppstak: /vision/capture/upload leser ~6 MB før grantet avvises; en vanlig kontrollrute avviser 100 KB med 413.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let cameras: VisionCameraService;
let n = 0;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = await startVisionDb("revbprobe");
  T = await seedTenant(db, "revb-t");
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await db?.stop();
}, 120_000);

describe("P1: engangsforbruk er atomisk (deterministisk barriere)", () => {
  it("tre samtidige opplastinger som ALLE har passert state-sjekken: nøyaktig én vinner, én modellkjøring", async () => {
    const storage = new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-revb-")));
    const snapshots = new VisionSnapshotService(db.app, storage, vision);
    const registry = new TestDeviceRegistry();
    const phone = new FakeDevice("iphone-probe", T.tenant, T.owner);
    registry.register(phone);
    // Forsinkelse i enhetsoppslaget: alle tre kall har da lest forespørselen som `pending` FØR noen av dem forbruker den.
    const slow = { approverFor: async (d: string, t: string) => { await new Promise((r) => setTimeout(r, 250)); return registry.approverFor(d, t); } };
    const gateway = new ScriptedGateway();
    gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "ryggsekk", confidence: 0.9 }]);
    const pipeline = new VisionIngestPipeline({ pool: db.app, vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings: new VisionEmbeddingService(db.app, new LocalHashEmbedding()), inventory: new VisionInventoryService(db.app), enabled: true, storeSnapshots: true });
    const service = new VisionCaptureService(db.app, cameras, pipeline, slow);
    const camera = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "iPhone-probe", source_type: "iphone", source_ref: "iphone-probe", zone_kind: "home", route_policy: "store_snapshot" });
    const request = await service.requestCapture({ tenant_id: T.tenant, memory_space: "home", person_id: T.owner, task_id: "t" }, { camera_id: camera.camera_id });
    const bytes = makeJpeg();
    const upload = phone.upload(request, bytes);
    const results = await Promise.allSettled([1, 2, 3].map(() => service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, upload, bytes)));
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    console.log(`P1 fulfilled=${fulfilled} model_calls=${gateway.calls.length} rejected_codes=${results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.code).join(",")}`);
    expect(fulfilled).toBe(1);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("P2: lagringstaket er mykt", () => {
  it("8 samtidige begin() mot et tak med plass til ETT bilde: hvor mange slipper gjennom?", async () => {
    const storage = new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-revb2-")));
    const usedNow = Number(((await db.admin.query(`SELECT COALESCE(SUM(byte_length),0)::int AS n FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant])).rows[0] as { n: number }).n);
    const limited = new VisionSnapshotService(db.app, storage, vision, { maxStoredBytes: usedNow + 600 });
    const cam = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "HA-probe", source_type: "home_assistant", source_ref: "camera.probe_quota", trigger_entities: [], zone_kind: "home", route_policy: "store_snapshot" });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => limited.begin(T.tenant, "home", T.owner, { camera_id: cam.camera_id, source_type: "home_assistant", source_instance_id: cam.camera_id, source_event_id: `evt-quota-${i}`, media_type: "image/jpeg", byte_length: 524, sha256: "a".repeat(64), task_id: "t" })));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    const total = Number(((await db.admin.query(`SELECT COALESCE(SUM(byte_length),0)::int AS n FROM vision_snapshots WHERE source_event_id LIKE 'evt-quota-%'`)).rows[0] as { n: number }).n);
    console.log(`P2 accepted=${accepted} of 8; stored bytes=${total} (room for exactly ONE 524-byte image: 600)`);
    expect(accepted).toBeGreaterThanOrEqual(1);
  });
});

describe("P3: gravsteiner reapes ikke uten JARVIS_VISION_STORE_SNAPSHOTS", () => {
  it("kun STORAGE_DIR satt: fila blir liggende etter full vedlikeholdskjøring; med STORE_SNAPSHOTS=on reapes den", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-vision-revb3-"));
    const probeStorage = new LocalFsStorageAdapter(dir);
    n += 1;
    const key = `snapshots/revb${n}/vis-snap-probe-${n}`;
    await probeStorage.put(key, makeJpeg());
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key) VALUES ($1, 'home', 'local_fs', $2)`, [T.tenant, key]);
    const common = {
      pool: db.app, vision, gateway: { complete: async () => ({ text: "{}", provider: "local_vision", model: "m" }) }, memoryEmbedding: new LocalHashEmbedding(), devices: { approverFor: async () => undefined },
      ownerTenantId: T.tenant, secrets: { get: async () => null }, ownerControls: { killSwitch: { isActiveDurable: async () => false }, controls: { isFrozenDurable: async () => false, isRevokedDurable: async () => false } }
    };
    const off = buildVisionRuntime({ ...common, env: { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORAGE_DIR: dir } as NodeJS.ProcessEnv });
    await off!.fullMaintenance();
    await off!.lightMaintenance();
    const stillThere = await probeStorage.exists(key);
    const tombs = Number(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = $1`, [key])).rows[0] as { n: number }).n);
    console.log(`P3 STORE_SNAPSHOTS=off: file_exists=${stillThere} tombstone_rows=${tombs}`);
    expect(stillThere).toBe(true);
    expect(tombs).toBe(1);
    const on = buildVisionRuntime({ ...common, env: { JARVIS_VISION_ENABLED: "on", JARVIS_VISION_STORE_SNAPSHOTS: "on", JARVIS_VISION_STORAGE_DIR: dir } as NodeJS.ProcessEnv });
    await on!.lightMaintenance();
    console.log(`P3 STORE_SNAPSHOTS=on : file_exists=${await probeStorage.exists(key)}`);
    expect(await probeStorage.exists(key)).toBe(false);
  });
});

describe("P4: pre-auth kroppstak", () => {
  it("/vision/capture/upload leser ~6 MB FØR grantet avvises (403); en vanlig kontrollrute avviser 100 KB med 413", async () => {
    const deps = {
      grants: { verify: async () => ({ ok: false, reason: "grant_invalid" }) },
      identity: { resolveIdentity: async () => ({ ok: false, reason: "x" }) },
      vision: { cameras: {} as never, capture: {} as never, lastSeen: {} as never, inventory: {} as never, maxUploadBytes: 5 * 1024 * 1024 }
    } as unknown as ApiDeps;
    const server = createApiServer(deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const big = await post("/vision/capture/upload", { grant_token: "bogus", data_base64: "A".repeat(6_000_000) });
    const small = await post("/vision/cameras/list", { grant_token: "bogus", pad: "A".repeat(100_000) });
    console.log(`P4 upload(6MB, ugyldig grant) -> ${big.status}; cameras/list(100KB) -> ${small.status}`);
    expect(big.status).toBe(403);
    expect(small.status).toBe(413);
  });
});

describe("P5: ukjent room_id ved kameraregistrering", () => {
  it("POST /vision/cameras/register med et rom som ikke finnes: status?", async () => {
    const deps = {
      grants: { verify: async (t: string) => (t === "owner" ? { ok: true, grant: { person_id: T.owner, tenant_id: T.tenant, channel: "web", auth_strength: "signed", session_id: "s", memory_space: "home", device_id: "web-owner" } } : { ok: false, reason: "grant_invalid" }) },
      identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
      owner: { tenant_id: T.tenant, person_id: T.owner },
      ownerGate: (id: { person_id: string }) => id.person_id === T.owner,
      vision: { cameras, capture: {} as never, lastSeen: {} as never, inventory: {} as never, maxUploadBytes: 5 * 1024 * 1024 }
    } as unknown as ApiDeps;
    const server = createApiServer(deps);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/vision/cameras/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_token: "owner", label: "X", source_type: "iphone", source_ref: "iphone-room-x", zone_kind: "home", route_policy: "local_only", room_id: "rm-finnes-ikke" }) });
    console.log(`P5 status=${res.status} body=${await res.text()}`);
    expect([400, 404, 409]).toContain(res.status);
  });
});
