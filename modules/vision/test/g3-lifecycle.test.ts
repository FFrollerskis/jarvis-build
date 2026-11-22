import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemorySpace } from "@jarvis/contracts";
import { LocalHashEmbedding } from "@jarvis/memory";
import { VisionCameraService, VisionCameraValidationError, type VisionCamera } from "../src/cameras.ts";
import { VisionClassifier } from "../src/classifier.ts";
import { VisionEmbeddingService } from "../src/embeddings.ts";
import { VisionInventoryService } from "../src/inventory.ts";
import { VisionIngestPipeline, type IngestContext } from "../src/pipeline.ts";
import { VisionService } from "../src/service.ts";
import { SnapshotQuotaError, VisionSnapshotService } from "../src/snapshots.ts";
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
 *  - integritet: et ødelagt bildeobjekt serveres aldri,
 *  - review B-L7/B-L8/B-L11: kvoten holder under samtidighet (advisory-lås, deterministisk barriere), reaperen tømmer køen i batcher (hver gravstein forsøkes høyst én gang per kall) og en «stuck» gravstein er en sveipefeil.
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

describe("lagringskvote: en støyende sensor kan ikke fylle disken", () => {
  it("over taket per (tenant, space) lagres bildet ikke (hendelsen skrives uten bilde, notat snapshot_quota_exceeded), ingen pending-rest og ingen fil; taket gjelder summen i spacet", async () => {
    const used = await scalar(`SELECT COALESCE(SUM(byte_length), 0)::int AS n FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant]);
    const limited = new VisionSnapshotService(db.app, storage, vision, { maxStoredBytes: used + 1200 }); // plass til to bilder à ~524 byte
    const run = async (label: string): Promise<{ status: string; snapshot_id?: string | undefined; notes: string[] }> => {
      const gateway = new ScriptedGateway();
      gateway.text = detectionsJson([{ event_type: "object_detected", object_label: label, confidence: 0.9 }]);
      const p = new VisionIngestPipeline({ pool: db.app, vision, classifier: new VisionClassifier({ gateway }), snapshots: limited, embeddings, inventory, enabled: true, storeSnapshots: true });
      return p.processCaptured(ctx, camera, {
        source_type: "home_assistant", source_event_id: `binary_sensor.x@quota-${label}`, base_event_type: "motion_detected", observed_at: new Date().toISOString(), age_ms: 10, skipCooldown: true,
        getImage: async () => ({ bytes: makeJpeg(), declared_type: "image/jpeg" })
      });
    };
    const before = (await files()).length;
    const first = await run("kvote1");
    const second = await run("kvote2");
    const third = await run("kvote3");
    expect([first.status, second.status, third.status]).toEqual(["recorded", "recorded", "recorded"]);
    expect(first.snapshot_id).toBeDefined();
    expect(second.snapshot_id).toBeDefined();
    expect(third.snapshot_id).toBeUndefined();
    expect(third.notes).toContain("snapshot_quota_exceeded");
    expect((await files()).length - before).toBe(2);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE source_event_id LIKE '%quota-kvote3%'`)).toBe(0);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_event_id LIKE '%quota-kvote3%' AND event_type = 'object_detected'`)).toBe(1); // objektet er likevel registrert
    // en annen tenants space teller ikke mot dette spacet (egen kvote)
    expect(await scalar(`SELECT COALESCE(SUM(byte_length), 0)::int AS n FROM vision_snapshots WHERE tenant_id = $1`, [T2.tenant])).toBe(0);
  });

  it("ugyldig kvote avvises ved konstruksjon", () => {
    expect(() => new VisionSnapshotService(db.app, storage, vision, { maxStoredBytes: 0 })).toThrow("vision_snapshot_quota_invalid");
    expect(() => new VisionSnapshotService(db.app, storage, vision, { maxStoredBytes: Number.NaN })).toThrow("vision_snapshot_quota_invalid");
  });
});

/**
 * Review B-L7: holder ALLE `parties` begin()-transaksjoner åpne (retensjonsoppslaget er gjort, ingenting er satt inn ennå) til alle har kommet. Det gjør kappløpet mellom innsetting og kvotesjekk
 * deterministisk uten sleep: uten en lås ser hver transaksjon bare sin egen uforpliktede rad (READ COMMITTED) og slipper gjennom.
 */
class LatchedVision extends VisionService {
  arrived = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(pool: pg.Pool, private readonly parties: number) {
    super(pool);
  }

  override async snapshotRetentionDaysInTransaction(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<number> {
    const days = await super.snapshotRetentionDaysInTransaction(client, tenantId, memorySpace);
    this.arrived += 1;
    if (this.arrived >= this.parties) for (const release of this.waiting) release();
    else await new Promise<void>((resolve) => { this.waiting.push(resolve); setTimeout(resolve, 10_000).unref(); });
    return days;
  }
}

/**
 * Review B-L7 (del 2): holder hver transaksjon rett ETTER innsettingen av bilderaden (før kvotesjekken) i inntil `windowMs`, eller til alle har satt inn. Uten en lås har alle satt inn før noen teller summen
 * og ser dermed bare sin egen uforpliktede rad (alle slipper gjennom, uavhengig av timing); med låsen kommer bare én om gangen hit, og ventetiden er en kort pause per transaksjon.
 */
function pausingAfterInsert(pool: pg.Pool, parties: number, windowMs: number): pg.Pool {
  let inserted = 0;
  const waiting: Array<() => void> = [];
  const pause = async (): Promise<void> => {
    inserted += 1;
    if (inserted >= parties) for (const release of waiting) release();
    else await new Promise<void>((resolve) => { waiting.push(resolve); setTimeout(resolve, windowMs).unref(); });
  };
  const bindIfFunction = (target: object, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  const wrap = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, prop) {
        if (prop !== "query") return bindIfFunction(target, prop);
        return async (...args: unknown[]): Promise<unknown> => {
          const result: unknown = await Reflect.apply(target.query, target, args);
          if (typeof args[0] === "string" && args[0].includes("INSERT INTO vision_snapshots")) await pause();
          return result;
        };
      }
    });
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect") return async (): Promise<pg.PoolClient> => wrap(await target.connect());
      return bindIfFunction(target, prop);
    }
  });
}

describe("review B-L7: kvoten holder også under samtidighet", () => {
  it("åtte samtidige begin() med plass til nøyaktig ÉN ekstra bilderad: nøyaktig én slipper gjennom, resten får SnapshotQuotaError (uten advisory-lås slipper alle gjennom, deterministisk)", async () => {
    const parties = 8;
    const racing = new LatchedVision(db.app, parties);
    const used = await scalar(`SELECT COALESCE(SUM(byte_length), 0)::int AS n FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant]);
    const limited = new VisionSnapshotService(pausingAfterInsert(db.app, parties, 100), storage, racing, { maxStoredBytes: used + 150 }); // ett bilde à 100 byte får plass, to får det ikke
    const results = await Promise.allSettled(
      Array.from({ length: parties }, (_, i) =>
        limited.begin(T.tenant, "home", T.owner, { camera_id: camera.camera_id, source_type: "home_assistant", source_instance_id: camera.camera_id, source_event_id: `binary_sensor.x@race-${i}`, media_type: "image/jpeg", byte_length: 100, sha256: String(i).repeat(64), task_id: "task-race" })
      )
    );
    expect(racing.arrived).toBe(parties); // alle åtte hadde åpnet transaksjonen før noen satte inn
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failed of results.filter((r) => r.status === "rejected")) expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(SnapshotQuotaError);
    expect(await scalar(`SELECT count(*)::int AS n FROM vision_snapshots WHERE source_event_id LIKE '%@race-%'`)).toBe(1); // ingen pending-rester fra de avviste
    expect(await scalar(`SELECT COALESCE(SUM(byte_length), 0)::int AS n FROM vision_snapshots WHERE tenant_id = $1 AND memory_space_id = 'home'`, [T.tenant])).toBeLessThanOrEqual(used + 150);
    await snapshots.reapPending(T.tenant, "home", 0); // rydd: den ene pending-raden hører ikke til resten av filen
    await snapshots.reapTombstones(T.tenant, "home");
  });
});

describe("review B-L11 + B-L8: reaperen tømmer køen, og en gravstein som ikke lar seg slette synes", () => {
  const stuckDir = async (name: string, attempts = 0): Promise<string> => {
    // En KATALOG på nøkkelens sti kan ikke slettes med unlink (EISDIR, også som root): en deterministisk «ulesbar gravstein» uten å late som om vi kan endre filrettigheter.
    const key = `snapshots/stuck/${name}`;
    await mkdir(join(root, key), { recursive: true });
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key, attempts) VALUES ($1, 'home', 'local_fs', $2, $3)`, [T.tenant, key, attempts]);
    return key;
  };
  const bulk = async (prefix: string, count: number): Promise<void> => {
    const keys = Array.from({ length: count }, (_, i) => `snapshots/bulk/${prefix}-${i}`);
    await db.admin.query(`INSERT INTO vision_snapshot_tombstones (tenant_id, memory_space_id, storage_backend, storage_key) SELECT $1, 'home', 'local_fs', k FROM unnest($2::text[]) AS k`, [T.tenant, keys]);
  };
  const remaining = (like: string): Promise<number> => scalar(`SELECT count(*)::int AS n FROM vision_snapshot_tombstones WHERE storage_key LIKE $1`, [like]);

  it("B-L11: køen leses i NUMERISK id-rekkefølge også når id-ene krysser en sifferbredde (99 -> 100) midt i en batch - ingen gravstein hoppes over (ORDER BY mot et tekst-alias sorterte leksikalsk)", async () => {
    // Eksplisitte id-er 90..119 (OVERRIDING SYSTEM VALUE) gjør testen uavhengig av hvor identitetssekvensen står: «100» < «90» som tekst, men 90 < 100 som tall.
    await db.admin.query(
      `INSERT INTO vision_snapshot_tombstones (tombstone_id, tenant_id, memory_space_id, storage_backend, storage_key)
       OVERRIDING SYSTEM VALUE SELECT 90 + i, $1, 'home', 'local_fs', 'snapshots/bulk/width-' || i FROM generate_series(0, 29) AS i`,
      [T.tenant]
    );
    const result = await snapshots.reapTombstones(T.tenant, "home", { limit: 7 });
    expect(result.deleted).toBeGreaterThanOrEqual(30);
    expect(result.failed).toBe(0);
    expect(await remaining("snapshots/bulk/width-%")).toBe(0);
  });

  it("B-L11: 250 gravsteiner med batch-størrelse 100 tømmes i ÉN kjøring (en enkelt batch ville latt 150 ligge til neste kjøring)", async () => {
    await bulk("b11", 250);
    const result = await snapshots.reapTombstones(T.tenant, "home", { limit: 100 });
    expect(result.deleted).toBeGreaterThanOrEqual(250);
    expect(result.failed).toBe(0);
    expect(await remaining("snapshots/bulk/b11-%")).toBe(0);
  });

  it("B-L11: en gravstein som feiler forsøkes høyst ÉN gang per kall (markøren går forbi den), resten av køen tømmes likevel; maxBatches er en sikkerhetsgrense", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const key = await stuckDir("b11-once");
      await bulk("b11-rest", 5);
      const result = await snapshots.reapTombstones(T.tenant, "home", { limit: 2 });
      expect(result.failed).toBe(1); // ikke ett nytt forsøk per batch
      expect(result.deleted).toBeGreaterThanOrEqual(5);
      expect(await remaining("snapshots/bulk/b11-rest-%")).toBe(0);
      const row = (await db.admin.query(`SELECT attempts, last_error FROM vision_snapshot_tombstones WHERE storage_key = $1`, [key])).rows[0] as { attempts: number; last_error: string };
      expect(row).toEqual({ attempts: 1, last_error: "eisdir" }); // kun en kort kode, aldri sti eller tekst

      await bulk("b11-cap", 3);
      const bounded = await snapshots.reapTombstones(T.tenant, "home", { limit: 1, maxBatches: 2 });
      expect(bounded.deleted + bounded.failed).toBeLessThanOrEqual(2); // to batcher à ÉN gravstein: aldri mer
      expect((await remaining("snapshots/bulk/b11-cap-%")) + (await remaining(key))).toBeGreaterThanOrEqual(2);
      await rm(join(root, key), { recursive: true }); // rydd: volumet repareres, så tømmes resten
      await snapshots.reapTombstones(T.tenant, "home");
      expect(await remaining("snapshots/bulk/%")).toBe(0);
      expect(await remaining(key)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe("review delta LOW-D5/D1: markøren er STRENG (`tombstone_id > markør`) - en gravstein som feiler som SISTE rad i en batch forsøkes likevel høyst ÉN gang per kall", () => {
    const attemptsOf = async (key: string): Promise<number> => (await db.admin.query(`SELECT attempts FROM vision_snapshot_tombstones WHERE storage_key = $1`, [key])).rows[0].attempts as number;
    const repair = async (...keys: string[]): Promise<void> => {
      for (const key of keys) await rm(join(root, key), { recursive: true });
      await snapshots.reapTombstones(T.tenant, "home");
    };

    it("limit=1: hver batch er ÉN rad, så den feilende er alltid SIST i sin batch - attempts er nøyaktig 1 og kjøringen kommer videre (med `>=` sto den stille og ble forsøkt på nytt hver runde)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await bulk("d1a-before", 1);
        const key = await stuckDir("d1a-stuck");
        await bulk("d1a-after", 2);
        const result = await snapshots.reapTombstones(T.tenant, "home", { limit: 1, maxBatches: 40 });
        expect(await attemptsOf(key)).toBe(1); // ikke ett forsøk per batch den står først i
        expect(result.failed).toBe(1);
        expect(await remaining("snapshots/bulk/d1a-%")).toBe(0); // radene bak den feilende ble også tømt (fremdrift)
        expect(result.deleted).toBeGreaterThanOrEqual(3);
        await repair(key);
        expect(await remaining(key)).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("limit=2 med to NABOER som feiler: uansett hvor batch-grensen faller er den ene av dem sist i en batch - begge har attempts = 1 etter ett kall", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const first = await stuckDir("d1b-first");
        const second = await stuckDir("d1b-second");
        await bulk("d1b-after", 3);
        const result = await snapshots.reapTombstones(T.tenant, "home", { limit: 2, maxBatches: 40 });
        expect([await attemptsOf(first), await attemptsOf(second)]).toEqual([1, 1]);
        expect(result.failed).toBe(2);
        expect(await remaining("snapshots/bulk/d1b-after-%")).toBe(0);
        // Et nytt kall gir nøyaktig ETT nytt forsøk per gravstein (+1, ikke +2)
        await snapshots.reapTombstones(T.tenant, "home", { limit: 2, maxBatches: 40 });
        expect([await attemptsOf(first), await attemptsOf(second)]).toEqual([2, 2]);
        await repair(first, second);
        expect((await remaining(first)) + (await remaining(second))).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("B-L8: en gravstein som har nådd «stuck» (5 mislykkede forsøk) er en SVEIPEFEIL (failed-listen), ikke bare en teller - og feilen forsvinner når lagringen er reparert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const key = await stuckDir("b8-stuck", 4);
      const first = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots }, { light: true });
      expect(first.tombstones_stuck).toBe(1);
      expect(first.tombstones_failed).toBe(1);
      expect(first.failed).toEqual([{ tenant_id: T.tenant, memory_space_id: "home", error: "tombstones_stuck:1" }]);
      expect(await remaining(key)).toBe(1); // graven står (ingenting stille tapt)
      await rm(join(root, key), { recursive: true }); // volumet er reparert
      const second = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots }, { light: true });
      expect(second.failed).toEqual([]);
      expect(second.tombstones_stuck).toBe(0);
      expect(await remaining(key)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("review delta B LOW-D4: skriverester (krasj midt i en put) ryddes av den FULLE kjøringen - ikke den lette - og ingenting annet røres", () => {
  const tmpName = (): string => `snap-orphan.tmp-${randomUUID()}`;
  const age = async (path: string, hours: number): Promise<void> => {
    const when = new Date(Date.now() - hours * 3_600_000);
    await utimes(path, when, when);
  };
  const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null;

  it("full kjøring fjerner foreldreløse `.tmp-<uuid>` eldre enn 6 timer og teller dem (temp_files_purged); lett kjøring rører dem ikke; fersk temp og et ekte objekt står", async () => {
    const dir = join(root, "snapshots", "orphan-tmp");
    await mkdir(dir, { recursive: true });
    const stale = join(dir, tmpName());
    const fresh = join(dir, tmpName());
    const recent = join(dir, tmpName());
    const real = join(dir, "snap-real-object");
    for (const path of [stale, fresh, recent, real]) await writeFile(path, "x");
    await age(stale, 30);
    await age(recent, 1); // 1 time: yngre enn grensen (6 t) - kan være en treg skriving
    await age(real, 30);
    try {
      const light = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots }, { light: true });
      expect(light.temp_files_purged).toBe(0);
      expect(await exists(stale)).toBe(true); // lett kjøring: ikke rørt
      const full = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots });
      expect(full.temp_files_purged).toBe(1);
      expect(full.failed).toEqual([]);
      expect(await exists(stale)).toBe(false);
      expect(await exists(fresh)).toBe(true); // kan være en skriving som pågår
      expect(await exists(recent)).toBe(true); // yngre enn 6 timer
      expect(await exists(real)).toBe(true); // ekte objekt: aldri rørt, uansett alder
      expect((await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots })).temp_files_purged).toBe(0); // idempotent
      // uten lagringstjeneste er det ingenting å rydde (og ingen feil)
      expect((await runVisionMaintenanceSweepForAllTenants(db.app, {})).temp_files_purged).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rydding som feiler er en SVEIPEFEIL med stabil kode (failed) og velter ikke kjøringen: en adapter som kaster, og en som ikke får slettet enkeltfiler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapter = (purge: () => Promise<{ removed: number; failed: number }>): StorageAdapter => ({
        backend: "local_fs", put: () => Promise.resolve(), get: () => Promise.resolve(null), exists: () => Promise.resolve(false), delete: () => Promise.resolve({ existed: false }), purgeStaleTemp: purge
      });
      const throwing = adapter(() => Promise.reject(Object.assign(new Error("sti /var/secret er ulesbar"), { code: "EACCES" })));
      const broken = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots: new VisionSnapshotService(db.app, throwing, vision) });
      expect(broken.failed).toEqual([{ tenant_id: "*", memory_space_id: "*", error: "temp_purge_failed:eacces" }]); // kun kode - aldri sti eller meldingstekst
      expect(broken.temp_files_purged).toBe(0);
      const partial = adapter(() => Promise.resolve({ removed: 2, failed: 3 }));
      const some = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots: new VisionSnapshotService(db.app, partial, vision) });
      expect(some.temp_files_purged).toBe(2);
      expect(some.failed).toEqual([{ tenant_id: "*", memory_space_id: "*", error: "temp_files_failed:3" }]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("review delta2 B LOW-E3: en AVKORTET temp-gang er SYNLIG (temp_files_truncated + én logglinje med kode, uten innhold) men er ikke en sveipefeil; en lett kjøring og en fullført gang rører ikke feltet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const storageReturning = (result: { removed: number; failed: number; truncated?: true }): StorageAdapter => ({
        backend: "local_fs", put: () => Promise.resolve(), get: () => Promise.resolve(null), exists: () => Promise.resolve(false), delete: () => Promise.resolve({ existed: false }), purgeStaleTemp: () => Promise.resolve(result)
      });
      const truncating = new VisionSnapshotService(db.app, storageReturning({ removed: 4, failed: 0, truncated: true }), vision);
      const full = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots: truncating });
      expect(full.temp_files_truncated).toBe(true);
      expect(full.temp_files_purged).toBe(4);
      expect(full.failed).toEqual([]); // avkortet = ufullstendig opprydding, ikke en feil (ingen retry-storm)
      const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("vision_temp_purge_truncated"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual({ msg: "vision_temp_purge_truncated", code: "temp_purge_truncated", removed: 4 });
      warn.mockClear();
      const light = await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots: truncating }, { light: true });
      expect(light.temp_files_truncated).toBe(false);
      const complete = new VisionSnapshotService(db.app, storageReturning({ removed: 1, failed: 0 }), vision);
      expect((await runVisionMaintenanceSweepForAllTenants(db.app, { snapshots: complete })).temp_files_truncated).toBe(false);
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("vision_temp_purge_truncated"))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
