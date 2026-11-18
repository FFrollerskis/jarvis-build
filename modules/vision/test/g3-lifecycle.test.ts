import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { VisionCameraService, VisionCameraValidationError, type VisionCamera } from "../src/cameras.ts";
import { VisionClassifier } from "../src/classifier.ts";
import { VisionEmbeddingService } from "../src/embeddings.ts";
import { VisionInventoryService } from "../src/inventory.ts";
import { VisionIngestPipeline, type IngestContext } from "../src/pipeline.ts";
import { VisionService } from "../src/service.ts";
import { VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter, type StorageAdapter } from "../src/storage.ts";
import { runVisionMaintenanceSweepForAllTenants } from "../src/sweep.ts";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3 (D-465): oppbevaring og sletting ende-til-ende. Bevist mot ekte Postgres og ekte lokal lagring:
 *  - bildets eget (kortere) vindu, aldri lengre enn hendelsene,
 *  - bilde-sletting: rad -> gravstein (trigger) -> reaper sletter objektet -> graven forsvinner; hendelsen beholdes med snapshot_ref = NULL,
 *  - hendelser som utløper tar vektor, bilde og (via utløp) inventar med seg,
 *  - reaper-feil står igjen som gravstein med forsøkstall og kort feilkode, og kan prøves på nytt (ingenting stille tapt),
 *  - pending-bilder fra et krasj ryddes, kamera-fjerning er destruktiv og krever bekreftelse, og tenant-isolasjon gjelder reaperen,
 *  - integritet: et ødelagt bildeobjekt serveres aldri.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let root = "";
let storage: LocalFsStorageAdapter;
let vision: VisionService;
let cameras: VisionCameraService;
let snapshots: VisionSnapshotService;
let inventory: VisionInventoryService;
let embeddings: VisionEmbeddingService;
let camera: VisionCamera;
let pipeline: VisionIngestPipeline;
let ctx: IngestContext;
let n = 0;

const files = async (): Promise<string[]> => (await readdir(root, { recursive: true }).catch(() => [] as string[])).filter((f) => f.split("/").length >= 3);
const scalar = async (sql: string, params: unknown[] = []): Promise<number> => ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;

async function capture(): Promise<{ observation_ids: string[]; snapshot_id: string }> {
  const gateway = new ScriptedGateway();
  gateway.text = detectionsJson([{ event_type: "object_detected", object_label: `gjenstand${++n}`, confidence: 0.9 }]);
  const p = new VisionIngestPipeline({ pool: db.app, vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings, inventory, enabled: true, storeSnapshots: true });
  const out = await p.processCaptured(ctx, camera, {
    source_type: "home_assistant", source_event_id: `binary_sensor.x@life-${n}`, base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
    getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
  });
  expect(out.status).toBe("recorded");
  return { observation_ids: out.observation_ids, snapshot_id: out.snapshot_id as string };
}

class FlakyDelete implements StorageAdapter {
  readonly backend = "local_fs";
  failures = 0;
  constructor(private readonly inner: StorageAdapter) {}
  put(key: string, bytes: Uint8Array): Promise<void> { return this.inner.put(key, bytes); }
  get(key: string, max?: number): Promise<Uint8Array | null> { return this.inner.get(key, max); }
  exists(key: string): Promise<boolean> { return this.inner.exists(key); }
  async delete(key: string): Promise<{ existed: boolean }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error("permission denied for /var/secret"), { code: "EACCES" });
    }
    return this.inner.delete(key);
  }
}

beforeAll(async () => {
  db = await startVisionDb("g3life");
  T = await seedTenant(db, "g3l-t1");
  T2 = await seedTenant(db, "g3l-t2");
  root = await mkdtemp(join(tmpdir(), "jarvis-vision-g3l-"));
  storage = new LocalFsStorageAdapter(root);
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
  snapshots = new VisionSnapshotService(db.app, storage, vision);
  inventory = new VisionInventoryService(db.app);
  embeddings = new VisionEmbeddingService(db.app, new LocalHashEmbedding());
  const room = (await vision.createRoom(T.tenant, "home", { person_id: T.owner, name: "Stua" })).room_id;
  camera = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "Inngang", source_type: "home_assistant", source_ref: "camera.inngang", trigger_entities: ["binary_sensor.x"], room_id: room, zone_kind: "home", route_policy: "store_snapshot" });
  ctx = { tenant_id: T.tenant, memory_space: "home", person_id: T.owner, task_id: "task-life" };
  pipeline = new VisionIngestPipeline({ pool: db.app, vision, snapshots, enabled: true, storeSnapshots: true });
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

describe("oppbevaringsvinduer", () => {
  it("bildet har eget vindu: min(snapshot_retention_days ?? 7, retention_days) - aldri lengre enn hendelsene", async () => {
    const expiry = async (): Promise<number> => {
      const c = await capture();
      const row = (await db.admin.query(`SELECT extract(epoch FROM (retention_expires_at - now())) / 86400 AS days FROM vision_snapshots WHERE snapshot_id = $1`, [c.snapshot_id])).rows[0] as { days: number };
      return Number(row.days);
    };
    expect(await expiry()).toBeCloseTo(7, 1); // ingen policy: min(7, 30)
    await vision.setRetentionPolicy(T.tenant, "home", { retention_days: 3, snapshot_retention_days: 10 });
    expect(await expiry()).toBeCloseTo(3, 1); // hendelsesvinduet er kortere: bildet følger det
    await vision.setRetentionPolicy(T.tenant, "home", { retention_days: 30, snapshot_retention_days: 2 });
    expect(await expiry()).toBeCloseTo(2, 1);
    await expect(vision.setRetentionPolicy(T.tenant, "home", { retention_days: 30, snapshot_retention_days: 0 })).rejects.toThrow();
    expect((await vision.getRetentionPolicy(T.tenant, "home"))?.snapshot_retention_days).toBe(2);
    await vision.setRetentionPolicy(T.tenant, "home", { retention_days: 30 });
    expect((await vision.getRetentionPolicy(T.tenant, "home"))?.snapshot_retention_days).toBeNull();
  });
});

describe("bilde-sletting: rad -> gravstein -> reaper -> borte (endelig konsistent)", () => {
  it("utløpt bilde: raden slettes, hendelsen BEHOLDES med snapshot_ref = NULL, objektet ligger til reaperen kjører, så er både fil og grav borte", async () => {
    const c = await capture();
    const filesBefore = (await files()).length;
    await db.admin.query(`UPDATE vision_snapshots SET retention_expires_at = now() - interval '1 minute' WHERE snapshot_id = $1`, [c.snapshot_id]);
    expect(await snapshots.purgeExpiredSnapshots(T.tenant, "home")).toBeGreaterThanOrEqual(1);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = $1`, [c.snapshot_id])).toBe(0);
    const obs = (await db.admin.query(`SELECT snapshot_ref FROM vision_event_observations WHERE observation_id = ANY($1)`, [c.observation_ids])).rows as Array<{ snapshot_ref: string | null }>;
    expect(obs).toHaveLength(c.observation_ids.length);
    expect(obs.every((o) => o.snapshot_ref === null)).toBe(true);
    expect((await files()).length).toBe(filesBefore); // objektet er der ennå
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key LIKE $1`, [`%${c.snapshot_id}`])).toBe(1);
    const reaped = await snapshots.reapTombstones(T.tenant, "home");
    expect(reaped.deleted).toBeGreaterThanOrEqual(1);
    expect(reaped.failed).toBe(0);
    expect((await files()).some((f) => f.includes(c.snapshot_id))).toBe(false);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key LIKE $1`, [`%${c.snapshot_id}`])).toBe(0);
  });

  it("reaper-feil: graven blir stående med attempts + kort feilkode (ingen sti/tekst), kan prøves på nytt, og «stuck» telles etter mange forsøk", async () => {
    const flaky = new FlakyDelete(storage);
    const reaper = new VisionSnapshotService(db.app, flaky, vision);
    const c = await capture();
    await db.admin.query(`UPDATE vision_snapshots SET retention_expires_at = now() - interval '1 minute' WHERE snapshot_id = $1`, [c.snapshot_id]);
    await reaper.purgeExpiredSnapshots(T.tenant, "home");
    flaky.failures = 5;
    const stuckSeries: number[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const result = await reaper.reapTombstones(T.tenant, "home", { stuckAttempts: 5 });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.deleted).toBe(0);
      stuckSeries.push(result.stuck);
    }
    expect(stuckSeries).toEqual([0, 0, 0, 0, 1]); // «stuck» = graven har nådd 5 mislykkede forsøk
    const tomb = (await db.admin.query(`SELECT attempts, last_error FROM vision_snapshot_tombstones WHERE storage_key LIKE $1`, [`%${c.snapshot_id}`])).rows[0] as { attempts: number; last_error: string };
    expect(tomb).toEqual({ attempts: 5, last_error: "eacces" });
    expect(JSON.stringify(tomb)).not.toContain("/var/secret");
    expect(flaky.failures).toBe(0);
    const ok = await reaper.reapTombstones(T.tenant, "home");
    expect(ok.deleted).toBeGreaterThanOrEqual(1);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key LIKE $1`, [`%${c.snapshot_id}`])).toBe(0);
  });

  it("pending-bilde fra et krasj (rad uten fullføring) ryddes av reapPending, gravstein + reaper, selv om objektet aldri ble skrevet (idempotent sletting)", async () => {
    const begun = await snapshots.begin(T.tenant, "home", T.owner, { camera_id: camera.camera_id, source_type: "home_assistant", source_instance_id: camera.camera_id, source_event_id: "binary_sensor.x@crash", media_type: "image/jpeg", byte_length: 10, sha256: "c".repeat(64), task_id: "task-crash" });
    expect(begun.row.state).toBe("pending");
    expect(await snapshots.reapPending(T.tenant, "home", 10 * 60_000)).toBe(0); // for ferskt: en skriving kan pågå
    expect(await snapshots.reapPending(T.tenant, "home", 0)).toBe(1);
    const reaped = await snapshots.reapTombstones(T.tenant, "home");
    expect(reaped.failed).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key = $1`, [begun.row.storage_key])).toBe(0);
  });

  it("begin() er idempotent per kilde-hendelse: et allerede lagret bilde gjenbrukes, et pending (annen arbeider) gir SnapshotInProgressError", async () => {
    const input = { camera_id: camera.camera_id, source_type: "home_assistant", source_instance_id: camera.camera_id, source_event_id: "binary_sensor.x@idem", media_type: "image/jpeg" as const, byte_length: 10, sha256: "d".repeat(64), task_id: "t" };
    const first = await snapshots.begin(T.tenant, "home", T.owner, input);
    await expect(snapshots.begin(T.tenant, "home", T.owner, input)).rejects.toThrow(/vision_snapshot_in_progress/);
    await db.app.query("SELECT 1");
    await db.admin.query(`UPDATE vision_snapshots SET state = 'stored', stored_at = now() WHERE snapshot_id = $1`, [first.row.snapshot_id]);
    const again = await snapshots.begin(T.tenant, "home", T.owner, input);
    expect(again.existing).toBe(true);
    expect(again.row.snapshot_id).toBe(first.row.snapshot_id);
  });

  it("reaperen rører aldri en annen tenants gravsteiner (RLS) - og hopper over en annen lagrings-backend", async () => {
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key) VALUES ($1, 'home', 'local_fs', 'snapshots/other/tenant-key'), ($2, 'home', 's3_other', 'snapshots/x/other-backend')`, [T2.tenant, T.tenant]);
    const result = await snapshots.reapTombstones(T.tenant, "home");
    expect(result.failed).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key IN ('snapshots/other/tenant-key', 'snapshots/x/other-backend')`)).toBe(2);
  });
});

describe("hendelser som utløper tar vektor og bilde med seg; inventar utløper for seg", () => {
  it("purgeExpiredObservations: hendelsene, vektorene og (siste referanse) bildet forsvinner; gravsteinen rydder fila", async () => {
    const c = await capture();
    expect(await scalar(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_kind = 'vision_event' AND ref_id = ANY($1)`, [c.observation_ids])).toBe(1);
    await db.admin.query(`UPDATE vision_event_observations SET retention_expires_at = now() - interval '1 minute' WHERE observation_id = ANY($1)`, [c.observation_ids]);
    expect(await vision.purgeExpiredObservations(T.tenant, "home")).toBeGreaterThanOrEqual(c.observation_ids.length);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_event_observations WHERE observation_id = ANY($1)`, [c.observation_ids])).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM memory_vectors WHERE ref_id = ANY($1)`, [c.observation_ids])).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = $1`, [c.snapshot_id])).toBe(0);
    await snapshots.reapTombstones(T.tenant, "home");
    expect((await files()).some((f) => f.includes(c.snapshot_id))).toBe(false);
  });

  it("inventar utløper på sin egen frist (expires_at fra databasens klokke) og slettes av vedlikeholdssveipet", async () => {
    await capture();
    const label = (await db.admin.query(`SELECT object_label FROM vision_inventory_items ORDER BY updated_at DESC LIMIT 1`)).rows[0] as { object_label: string };
    await db.admin.query(`UPDATE vision_inventory_items SET expires_at = now() - interval '1 minute' WHERE object_label = $1`, [label.object_label]);
    expect((await inventory.list(T.tenant, "home", T.owner)).some((i) => i.object_label === label.object_label)).toBe(false); // utløpt = skjult allerede før sveipet
    expect(await inventory.purgeExpired(T.tenant, "home")).toBeGreaterThanOrEqual(1);
  });
});

describe("kamera-fjerning, integritet og vedlikeholdssveipet", () => {
  it("removeCamera er destruktiv: krever confirm, sletter bildene (kaskade + gravstein) og beholder hendelsene", async () => {
    const extra = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "Midlertidig", source_type: "home_assistant", source_ref: "camera.midlertidig", trigger_entities: [], zone_kind: "home", route_policy: "store_snapshot" });
    const p = new VisionIngestPipeline({ pool: db.app, vision, snapshots, enabled: true, storeSnapshots: true });
    const out = await p.processCaptured(ctx, extra, { source_type: "home_assistant", source_event_id: "binary_sensor.y@gone", base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" }) });
    expect(out.snapshot_id).toBeDefined();
    await expect(cameras.removeCamera(T.tenant, "home", T.owner, extra.camera_id, { confirm: false })).rejects.toBeInstanceOf(VisionCameraValidationError);
    expect(await cameras.getCamera(T.tenant, "home", T.owner, extra.camera_id)).not.toBeNull();
    expect(await cameras.removeCamera(T.tenant, "home", T.owner, extra.camera_id, { confirm: true })).toBe(true);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = $1`, [out.snapshot_id])).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_event_observations WHERE observation_id = ANY($1)`, [out.observation_ids])).toBe(1);
    await snapshots.reapTombstones(T.tenant, "home");
    expect((await files()).some((f) => f.includes(out.snapshot_id as string))).toBe(false);
  });

  it("read(): returnerer bytene til eieren; et ødelagt objekt (sha256 avviker), en annen person og et ikke-lagret bilde gir null", async () => {
    const c = await capture();
    const read = await snapshots.read(T.tenant, "home", T.owner, c.snapshot_id);
    expect(read?.media_type).toBe("image/jpeg");
    expect(read?.bytes.length).toBeGreaterThan(100);
    expect(await snapshots.read(T.tenant, "home", T.other, c.snapshot_id)).toBeNull();
    expect(await snapshots.read(T.tenant, "personal", T.owner, c.snapshot_id)).toBeNull();
    const row = (await db.admin.query(`SELECT storage_key FROM vision_snapshots WHERE snapshot_id = $1`, [c.snapshot_id])).rows[0] as { storage_key: string };
    await writeFile(join(root, row.storage_key), Buffer.concat([Buffer.from(read?.bytes ?? []), Buffer.from("manipulert")]));
    expect(await snapshots.read(T.tenant, "home", T.owner, c.snapshot_id)).toBeNull();
  });

  it("vedlikeholdssveipet (full): utløpte bilder + inventar + gravsteiner i ÉN kjøring, og lett kjøring rører ikke retensjonen", async () => {
    const c = await capture();
    await db.admin.query(`UPDATE vision_snapshots SET retention_expires_at = now() - interval '1 minute' WHERE snapshot_id = $1`, [c.snapshot_id]);
    const light = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots, inventory, embeddings }, { light: true });
    expect(light.snapshots_purged).toBe(0);
    expect(light.failed).toEqual([]);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE snapshot_id = $1`, [c.snapshot_id])).toBe(1);
    const full = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots, inventory, embeddings });
    expect(full.failed).toEqual([]);
    expect(full.snapshots_purged).toBeGreaterThanOrEqual(1);
    expect(full.tombstones_deleted).toBeGreaterThanOrEqual(1);
    expect(full.spaces).toBeGreaterThanOrEqual(2);
    expect((await files()).some((f) => f.includes(c.snapshot_id))).toBe(false);
  });
});
