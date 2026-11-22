import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { VisionCameraService, type VisionCamera } from "../src/cameras.ts";
import { VisionClassifier } from "../src/classifier.ts";
import { VisionEmbeddingService } from "../src/embeddings.ts";
import { HomeAssistantVisionSource } from "../src/ha-source.ts";
import { VisionInventoryService } from "../src/inventory.ts";
import { VisionIngestPipeline, type IngestContext } from "../src/pipeline.ts";
import { VisionService } from "../src/service.ts";
import { VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter } from "../src/storage.ts";
import { contractFetch, FakeHaServer, haTimestamp } from "./support/fake-ha-server.ts";
import { detectionsJson, makeJpeg, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3 (D-465), P1a: Home Assistant-kilden ende-til-ende mot pipelinen og en ekte embedded Postgres, mot en falsk HA (lokal HTTP-server). Bevist: poll -> utløser -> ETT øyeblikksbilde ->
 * lokal klassifisering -> én transaksjon; en ny poll av samme tilstand koster ingenting (idempotens FØR bilde/modell); kameraets policy bestemmer hva som hentes/lagres; HA nede = `source_error`
 * (ingen kast); tokenet finnes ingensteds i databasen; flagg av = ingen forespørsel til HA.
 */
const TOKEN = "canary-ha-credential-0001";
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let ha: FakeHaServer;
let vision: VisionService;
let cameras: VisionCameraService;
let snapshots: VisionSnapshotService;
let gateway: ScriptedGateway;
let source: HomeAssistantVisionSource;
let ctx: IngestContext;
let errorLog: MockInstance<typeof console.error>;
let stua: string;

const count = async (sql: string, params: unknown[] = []): Promise<number> => ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;
let counter = 0;
const registerCamera = (policy: "store_snapshot" | "local_only" | "discard", extra: { trigger?: string[] } = {}): Promise<VisionCamera> => {
  counter += 1;
  return cameras.registerCamera(T.tenant, "home", {
    person_id: T.owner, label: `Kamera ${counter}`, source_type: "home_assistant", source_ref: `camera.cam_${counter}`,
    trigger_entities: extra.trigger ?? [`binary_sensor.cam_${counter}_motion`], zone_kind: "home", route_policy: policy, room_id: stua
  });
};
const motionNow = (entity: string, ageMs = 4_000): void => ha.setState(entity, { state: "on", attributes: { device_class: "motion" }, last_changed: haTimestamp(new Date(Date.now() - ageMs)) });
const makePipeline = (over: { enabled?: boolean; storeSnapshots?: boolean } = {}): VisionIngestPipeline =>
  new VisionIngestPipeline({
    pool: db.app, vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings: new VisionEmbeddingService(db.app, new LocalHashEmbedding()),
    inventory: new VisionInventoryService(db.app), enabled: over.enabled ?? true, storeSnapshots: over.storeSnapshots ?? true
  });

beforeAll(async () => {
  db = await startVisionDb("g3ha");
  T = await seedTenant(db, "g3ha-t1");
  ha = await FakeHaServer.start();
  vision = new VisionService(db.app);
  stua = (await vision.createRoom(T.tenant, "home", { person_id: T.owner, name: "Stua" })).room_id;
  cameras = new VisionCameraService(db.app);
  snapshots = new VisionSnapshotService(db.app, new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-g3ha-"))), vision);
  ctx = { tenant_id: T.tenant, memory_space: "home", person_id: T.owner, task_id: "task-ha-poll", session_id: "sess-ha" };
}, 240_000);

afterAll(async () => {
  await ha?.stop();
  await db?.stop();
}, 120_000);

beforeEach(() => {
  ha.reset();
  gateway = new ScriptedGateway();
  gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "pakke", confidence: 0.9 }]);
  source = new HomeAssistantVisionSource({ fetch: contractFetch, baseUrl: async () => ha.base, token: async () => TOKEN });
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorLog.mockRestore();
});

describe("poll -> pipeline", () => {
  it("bevegelse: ETT bilde hentes, klassifiseres lokalt og lagres (store_snapshot) i én transaksjon; en ny poll av samme tilstand er en duplikat uten bilde-/modellkost", async () => {
    const camera = await registerCamera("store_snapshot");
    const trigger = camera.trigger_entities[0] as string;
    const bytes = makeJpeg();
    motionNow(trigger);
    ha.setImage(camera.source_ref, bytes);
    const pipeline = makePipeline();

    const first = await pipeline.pollSource(ctx, source, [camera]);
    expect(first).toEqual({ events_seen: 1, recorded: 1, duplicates: 0, discarded: 0, cooldown: 0, failed: 0 });
    expect(ha.requestsTo("/api/camera_proxy/")).toHaveLength(1);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({ mode: "LOCAL", sensitivity: "SECRET_RESTRICTED", paid_models_allowed: false });

    const rows = (await db.admin.query(`SELECT event_type, source_event_id, source_type, source_instance_id, person_id, task_id, session_id, classification_status, snapshot_ref FROM vision_event_observations WHERE source_instance_id = $1 ORDER BY event_type`, [camera.camera_id])).rows as Array<Record<string, string | null>>;
    expect(rows.map((r) => r["event_type"])).toEqual(["motion_detected", "object_detected"]);
    for (const row of rows) expect(row).toMatchObject({ source_type: "home_assistant", person_id: T.owner, task_id: "task-ha-poll", session_id: "sess-ha" });
    expect(rows[0]?.["source_event_id"]).toMatch(new RegExp(`^${trigger}@\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`));
    expect(rows[1]?.["source_event_id"]).toBe(`${rows[0]?.["source_event_id"]}#obj:pakke`);
    const snapshot = (await db.admin.query(`SELECT sha256, byte_length, state FROM vision_snapshots WHERE camera_id = $1`, [camera.camera_id])).rows[0] as { sha256: string; byte_length: number; state: string };
    expect(snapshot).toEqual({ sha256: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, state: "stored" });
    expect(await count(`SELECT count(*)::int AS n FROM vision_inventory_items WHERE person_id = $1 AND object_label = 'pakke'`, [T.owner])).toBe(1);

    const second = await pipeline.pollSource(ctx, source, [camera]);
    expect(second).toMatchObject({ events_seen: 1, recorded: 0, duplicates: 1 });
    expect(ha.requestsTo("/api/camera_proxy/")).toHaveLength(1); // idempotens FØR bilde
    expect(gateway.calls).toHaveLength(1); // ... og før modell
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1`, [camera.camera_id])).toBe(2);
  });

  it("local_only: bildet hentes og klassifiseres men LAGRES ikke; discard: hendelsen forkastes helt - ingenting hentes, ingenting skrives", async () => {
    const local = await registerCamera("local_only");
    const dropped = await registerCamera("discard");
    for (const camera of [local, dropped]) {
      motionNow(camera.trigger_entities[0] as string);
      ha.setImage(camera.source_ref, makeJpeg());
    }
    const summary = await makePipeline().pollSource(ctx, source, [local, dropped]);
    expect(summary).toMatchObject({ events_seen: 2, recorded: 1, discarded: 1, failed: 0 });
    expect(ha.requestsTo(`/api/camera_proxy/${local.source_ref}`)).toHaveLength(1);
    expect(ha.requestsTo(`/api/camera_proxy/${dropped.source_ref}`)).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM vision_snapshots WHERE camera_id = ANY($1)`, [[local.camera_id, dropped.camera_id]])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1 AND event_type = 'object_detected'`, [local.camera_id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1`, [dropped.camera_id])).toBe(0);
  });

  it("HA nede/feil token: pollSource kaster ikke, gir source_error med stabil kode, og skriver ingenting", async () => {
    const camera = await registerCamera("store_snapshot");
    ha.route(`/api/states/${camera.trigger_entities[0]}`, (_req, res) => {
      res.writeHead(401);
      res.end(`unauthorized ${TOKEN}`);
    });
    const summary = await makePipeline().pollSource(ctx, source, [camera]);
    expect(summary).toEqual({ events_seen: 0, recorded: 0, duplicates: 0, discarded: 0, cooldown: 0, failed: 0, source_error: "home_assistant_error_401" });
    expect(errorLog.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain(TOKEN);
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1`, [camera.camera_id])).toBe(0);
  });

  it("bildehenting feiler (HA gir 500 på camera_proxy): hendelsen skrives uten objekter, status registreres, ingen halv skriving", async () => {
    const camera = await registerCamera("store_snapshot");
    motionNow(camera.trigger_entities[0] as string);
    ha.route(`/api/camera_proxy/${camera.source_ref}`, (_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const summary = await makePipeline().pollSource(ctx, source, [camera]);
    // review B-L12: «hendelsen skrives uten objekter» - selve raden FINNES (recorded = 1, ingenting feilet), men har ingen objekter og intet bilde
    expect(summary).toEqual({ events_seen: 1, recorded: 1, duplicates: 0, discarded: 0, cooldown: 0, failed: 0 });
    const base = (await db.admin.query(`SELECT event_type, snapshot_ref, classification_status FROM vision_event_observations WHERE source_instance_id = $1`, [camera.camera_id])).rows as Array<{ event_type: string; snapshot_ref: string | null; classification_status: string }>;
    expect(base).toEqual([{ event_type: "motion_detected", snapshot_ref: null, classification_status: "not_applicable" }]);
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1 AND event_type = 'object_detected'`, [camera.camera_id])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM vision_snapshots WHERE camera_id = $1 AND state = 'stored'`, [camera.camera_id])).toBe(0);
    expect(gateway.calls).toHaveLength(0);
  });

  it("flagg av (enabled=false): ingen forespørsel går til HA i det hele tatt; kameraer for andre kildetyper pollles ikke", async () => {
    const camera = await registerCamera("store_snapshot");
    motionNow(camera.trigger_entities[0] as string);
    ha.setImage(camera.source_ref, makeJpeg());
    const off = await makePipeline({ enabled: false }).pollSource(ctx, source, [camera]);
    expect(off).toEqual({ events_seen: 0, recorded: 0, duplicates: 0, discarded: 0, cooldown: 0, failed: 0 });
    expect(ha.requests).toEqual([]);

    const iphone = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "iPhone", source_type: "iphone", source_ref: "iphone-x", zone_kind: "home", route_policy: "local_only" });
    expect(await makePipeline().pollSource(ctx, source, [iphone])).toMatchObject({ events_seen: 0 });
    expect(ha.requests).toEqual([]);
  });

  it("review delta2 A LOW-E3 + B LOW-E1: en poll-runde der inventaret for en etikett hoppes over (databasen avviser den) melder tallet i PollSummary (kun tall, kun når > 0) - hendelsen er lagret, og vanlige runder har ingen slike felt", async () => {
    const camera = await registerCamera("local_only");
    motionNow(camera.trigger_entities[0] as string);
    ha.setImage(camera.source_ref, makeJpeg());
    gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "driftet", confidence: 0.9 }, { event_type: "object_detected", object_label: "pakke", confidence: 0.8 }]);
    // CHECK-en strammes inn (NOT VALID: gjelder nye rader) slik at databasen avviser en etikett JS-regelen godtar - samme drift savepointet beskytter mot.
    const check = "vision_inventory_items_object_label_check";
    const original = ((await db.admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [check])).rows[0] as { def: string }).def.replace(/^CHECK\s*/, "").replace(/\s+NOT VALID$/, "");
    await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${check}`);
    await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${check} CHECK (object_label <> 'driftet') NOT VALID`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const pipeline = makePipeline();
      const summary = await pipeline.pollSource(ctx, source, [camera]);
      expect(summary).toStrictEqual({ events_seen: 1, recorded: 1, duplicates: 0, discarded: 0, cooldown: 0, failed: 0, inventory_label_rejected: 1 }); // `inventory_label_invalid` er ikke med: kun felt > 0
      expect(JSON.stringify(summary)).not.toContain("driftet"); // kun tall, aldri etikettinnhold
      expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_instance_id = $1 AND object_label = 'driftet'`, [camera.camera_id])).toBe(1); // hendelsen ER lagret
      expect(await count(`SELECT count(*)::int AS n FROM vision_inventory_items WHERE person_id = $1 AND object_label = 'pakke'`, [T.owner])).toBeGreaterThanOrEqual(1); // ... og neste objekts inventar også
      expect(await count(`SELECT count(*)::int AS n FROM vision_inventory_items WHERE person_id = $1 AND object_label = 'driftet'`, [T.owner])).toBe(0);
      expect(pipeline.stats()).toMatchObject({ inventory_label_invalid: 0, inventory_label_rejected: 1 });
      expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("vision_inventory_skipped"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await db.admin.query(`ALTER TABLE vision_inventory_items DROP CONSTRAINT ${check}`);
      await db.admin.query(`ALTER TABLE vision_inventory_items ADD CONSTRAINT ${check} CHECK ${original}`);
    }
  });

  it("tokenet (og HA-URL-en) finnes ingensteds i vision-tabellene - heller ikke i feilkoder", async () => {
    for (const table of ["vision_cameras", "vision_event_observations", "vision_snapshots", "vision_snapshot_tombstones", "vision_inventory_items", "vision_capture_requests", "vision_retention_policies", "vision_rooms"]) {
      const rows = (await db.admin.query(`SELECT t::text AS row FROM ${table} t`)).rows as Array<{ row: string }>;
      for (const row of rows) {
        expect(row.row).not.toContain(TOKEN);
        expect(row.row).not.toContain("127.0.0.1");
      }
    }
  });
});
