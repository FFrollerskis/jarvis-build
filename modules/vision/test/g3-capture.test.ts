import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalHashEmbedding } from "@jarvis/memory";
import { VisionCameraService, type VisionCamera } from "../src/cameras.ts";
import { captureSigningBytes, CAPTURE_MAX_PENDING_PER_CAMERA, VisionCaptureError, VisionCaptureService, type CaptureContext, type CaptureRequest } from "../src/capture.ts";
import { VisionClassifier } from "../src/classifier.ts";
import { VisionEmbeddingService } from "../src/embeddings.ts";
import { VisionInventoryService } from "../src/inventory.ts";
import { VisionIngestPipeline } from "../src/pipeline.ts";
import { VisionService } from "../src/service.ts";
import { VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter } from "../src/storage.ts";
import { FakeDevice, TestDeviceRegistry } from "./support/fake-device.ts";
import { detectionsJson, makeJpeg, NOT_AN_IMAGE, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WP-G3 (D-465), P2d: iPhone-kamera på forespørsel - SERVERKONTRAKTEN (appen er BLOCKED_EXTERNAL) mot en FAKE enhet som følger nøyaktig samme protokoll.
 * Bevist: eier ber om ett opptak -> enheten henter forespørselen -> enhetssignert opplasting -> samme pipeline som HA, og alle angrepsflater feiler lukket med en stabil kode:
 * replay, samtidig dobbeltopplasting, ombundet signatur, manipulerte bytes, feil/revokert/ukjent enhet, annen person, annen tenant, utløp, tidsskjevhet, størrelse, ikke-bilde,
 * og pipeline-feil etter forbruk.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let cameras: VisionCameraService;
let snapshots: VisionSnapshotService;
let registry: TestDeviceRegistry;
let phone: FakeDevice;
let storeCamera: VisionCamera;
let localCamera: VisionCamera;
let ctx: CaptureContext;
let gateway: ScriptedGateway;
let service: VisionCaptureService;
let clock = Date.now();

const count = async (sql: string, params: unknown[] = []): Promise<number> => ((await db.admin.query(sql, params)).rows[0] as { n: number }).n;
const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ name: "VisionCaptureError", code });
};

function makeService(over: { pipelineVision?: VisionService } = {}): VisionCaptureService {
  const pipeline = new VisionIngestPipeline({
    pool: db.app, vision: over.pipelineVision ?? vision, classifier: new VisionClassifier({ gateway }), snapshots, embeddings: new VisionEmbeddingService(db.app, new LocalHashEmbedding()),
    inventory: new VisionInventoryService(db.app), enabled: true, storeSnapshots: true
  });
  return new VisionCaptureService(db.app, cameras, pipeline, registry, { now: () => new Date(clock) });
}

beforeAll(async () => {
  db = await startVisionDb("g3cap");
  T = await seedTenant(db, "g3c-t1");
  T2 = await seedTenant(db, "g3c-t2");
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
  snapshots = new VisionSnapshotService(db.app, new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-g3cap-"))), vision);
  registry = new TestDeviceRegistry();
  phone = new FakeDevice("iphone-eier", T.tenant, T.owner);
  registry.register(phone);
  const reg = (label: string, policy: "local_only" | "store_snapshot" | "discard", ref = "iphone-eier"): Promise<VisionCamera> =>
    cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label, source_type: "iphone", source_ref: ref, zone_kind: "home", route_policy: policy });
  storeCamera = await reg("iPhone (lagre)", "store_snapshot");
  localCamera = await reg("iPhone (lokal)", "local_only", "iphone-lokal");
  ctx = { tenant_id: T.tenant, memory_space: "home", person_id: T.owner, task_id: "task-capture", session_id: "sess-cap" };
}, 240_000);

afterAll(async () => {
  await db?.stop();
}, 120_000);

beforeEach(async () => {
  gateway = new ScriptedGateway();
  gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "ryggsekk", confidence: 0.85 }]);
  clock = Date.now();
  service = makeService();
  await db.admin.query(`UPDATE vision_capture_requests SET state = 'cancelled', resolved_at = now() WHERE state = 'pending'`);
});

const request = (over: { camera?: VisionCamera; key?: string; ttl_ms?: number } = {}): Promise<CaptureRequest> =>
  service.requestCapture(ctx, { camera_id: (over.camera ?? storeCamera).camera_id, idempotency_key: over.key, ttl_ms: over.ttl_ms });

describe("protokollen ende-til-ende", () => {
  it("eier ber -> enheten henter -> signert opplasting -> pipeline (kun det modellen ser skrives, bilde lagres etter kameraets policy) -> forespørselen er forbrukt", async () => {
    const requested = await request();
    expect(requested).toMatchObject({ state: "pending", device_id: "iphone-eier", camera_id: storeCamera.camera_id, person_id: T.owner });
    const pending = await service.listPending(T.tenant, "home", T.owner, "iphone-eier");
    expect(pending.map((p) => p.request_id)).toEqual([requested.request_id]);

    const bytes = makeJpeg();
    const result = await service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "task-upload" }, phone.upload(requested, bytes), bytes);
    expect(result.outcome).toMatchObject({ status: "recorded", classification_status: "classified", detection_count: 1 });
    expect(result.outcome.snapshot_id).toBeDefined();
    expect(result.request).toMatchObject({ state: "fulfilled", snapshot_id: result.outcome.snapshot_id });
    expect(result.request.upload_sha256).toMatch(/^[0-9a-f]{64}$/);

    const obs = (await db.admin.query(`SELECT * FROM vision_event_observations WHERE source_event_id LIKE $1`, [`${requested.request_id}%`])).rows;
    expect(obs).toHaveLength(1); // ingen utløserhendelse - kun objektet
    expect(obs[0]).toMatchObject({ event_type: "object_detected", object_label: "ryggsekk", source_type: "iphone", source_instance_id: storeCamera.camera_id, person_id: T.owner, task_id: `vision-capture:${requested.request_id}`, snapshot_ref: result.outcome.snapshot_id, classification_status: "classified" });
    expect(await service.listPending(T.tenant, "home", T.owner, "iphone-eier")).toEqual([]);
    expect(gateway.calls[0]).toMatchObject({ mode: "LOCAL", sensitivity: "SECRET_RESTRICTED", paid_models_allowed: false });
  });

  it("kamera med local_only: opptaket klassifiseres og forkastes - INGEN lagring", async () => {
    const phone2 = new FakeDevice("iphone-lokal", T.tenant, T.owner);
    registry.register(phone2);
    const requested = await request({ camera: localCamera });
    const bytes = makeJpeg();
    const result = await service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone2.upload(requested, bytes), bytes);
    expect(result.outcome).toMatchObject({ status: "recorded", reason: "ok_local_only" });
    expect(result.outcome.snapshot_id).toBeUndefined();
    expect(await count(`SELECT count(*)::int AS n FROM vision_snapshots WHERE camera_id = $1`, [localCamera.camera_id])).toBe(0);
  });
});

describe("engangsbruk og binding", () => {
  it("replay av den samme gyldige opplastingen avvises (request_not_pending), og ingenting dupliseres", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const upload = phone.upload(requested, bytes);
    await service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, upload, bytes);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, upload, bytes), "request_not_pending");
    expect(await count(`SELECT count(*)::int AS n FROM vision_event_observations WHERE source_event_id LIKE $1`, [`${requested.request_id}%`])).toBe(1);
    expect(gateway.calls).toHaveLength(1);
  });

  it("to samtidige opplastinger av samme forespørsel: nøyaktig én vinner", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const upload = phone.upload(requested, bytes);
    const results = await Promise.allSettled([1, 2, 3].map(() => service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, upload, bytes)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failed of results.filter((r) => r.status === "rejected")) expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: "request_not_pending" });
    expect(gateway.calls).toHaveLength(1);
  });

  it("signaturen er bundet til forespørselen: en signatur for forespørsel A kan ikke brukes mot forespørsel B", async () => {
    const a = await request();
    const b = await request();
    const bytes = makeJpeg();
    const forA = phone.upload(a, bytes);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, { ...forA, request_id: b.request_id }, bytes), "invalid_signature");
    expect((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [b.request_id])).rows[0].state).toBe("pending");
  });

  it("manipulerte bytes (signert hash stemmer ikke med bildet) -> hash_mismatch; ny hash uten gyldig signatur -> invalid_signature; ingen av dem forbruker forespørselen", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const upload = phone.upload(requested, bytes);
    const tampered = Uint8Array.from(bytes);
    tampered[20] = (tampered[20] as number) ^ 0xff;
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, upload, tampered), "hash_mismatch");
    const recomputed = phone.upload(requested, tampered);
    await expect(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, { ...recomputed, sha256: upload.sha256 }, tampered)).rejects.toMatchObject({ code: "invalid_signature" });
    expect((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [requested.request_id])).rows[0].state).toBe("pending");
  });

  it("feil nøkkel, ukjent/revokert enhet og en annen persons enhet avvises", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const stranger = new FakeDevice("iphone-eier", T.tenant, T.owner);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(requested, bytes, { signAs: stranger }), bytes), "invalid_signature");

    const revoked = new FakeDevice("iphone-eier", T.tenant, T.owner);
    registry.register(revoked);
    registry.revoke(revoked);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, revoked.upload(requested, bytes), bytes), "unknown_device");
    registry.register(phone); // gjenopprett den ekte enheten

    const otherPerson = new FakeDevice("iphone-eier", T.tenant, T.other);
    registry.register(otherPerson);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, otherPerson.upload(requested, bytes), bytes), "device_person_mismatch");
    registry.register(phone);

    const wrongDevice = new FakeDevice("iphone-annen", T.tenant, T.owner);
    registry.register(wrongDevice);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, wrongDevice.upload(requested, bytes), bytes), "device_mismatch");
  });

  it("en annen tenant kan ikke laste opp mot forespørselen (RLS: request_not_found)", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const foreign = new FakeDevice("iphone-eier", T2.tenant, T2.owner);
    registry.register(foreign);
    await expectCode(service.submitUpload({ tenant_id: T2.tenant, memory_space: "home", task_id: "t" }, foreign.upload(requested, bytes), bytes), "request_not_found");
  });

  it("utløpt og kansellert forespørsel kan ikke oppfylles; tidsskjevhet (gammel/fremtidig signatur) avvises", async () => {
    const expired = await request();
    await db.admin.query(`UPDATE vision_capture_requests SET expires_at = now() - interval '1 second', requested_at = now() - interval '10 minutes' WHERE request_id = $1`, [expired.request_id]);
    const bytes = makeJpeg();
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(expired, bytes), bytes), "request_not_pending");

    const cancelled = await request();
    expect(await service.cancel(T.tenant, "home", T.owner, cancelled.request_id)).toBe(true);
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(cancelled, bytes), bytes), "request_not_pending");

    const live = await request();
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(live, bytes, { issued_at: new Date(Date.now() - 3_600_000).toISOString() }), bytes), "timestamp_skew");
    await expectCode(service.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(live, bytes, { issued_at: new Date(Date.now() + 3_600_000).toISOString() }), bytes), "timestamp_skew");
  });

  it("størrelse/format: lengde som ikke stemmer, for stort, og et ikke-bilde med gyldig signatur avvises før noe forbrukes", async () => {
    const requested = await request();
    const bytes = makeJpeg();
    const ctxUpload = { tenant_id: T.tenant, memory_space: "home", task_id: "t" } as const;
    await expectCode(service.submitUpload(ctxUpload, phone.upload(requested, bytes, { byte_length: bytes.length + 1 }), bytes), "upload_size_mismatch");
    const big = new Uint8Array(6 * 1024 * 1024);
    await expectCode(service.submitUpload(ctxUpload, phone.upload(requested, big), big), "upload_size_mismatch");
    await expectCode(service.submitUpload(ctxUpload, phone.upload(requested, NOT_AN_IMAGE), NOT_AN_IMAGE), "image_unsupported_format");
    await expectCode(service.submitUpload(ctxUpload, phone.upload(requested, bytes, { media_type: "image/png" }), bytes), "image_content_type_mismatch");
    await expectCode(service.submitUpload(ctxUpload, { ...phone.upload(requested, bytes), media_type: "video/mp4" }, bytes), "upload_malformed");
    expect((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [requested.request_id])).rows[0].state).toBe("pending");
  });

  it("pipeline-feil ETTER forbruk gir state rejected (pipeline_failed), ikke en stille fulfilled", async () => {
    const flaky = Object.create(vision) as VisionService;
    flaky.ingestWithinTransaction = async () => {
      throw new Error("simulert databasefeil");
    };
    const failing = makeService({ pipelineVision: flaky });
    const requested = await failing.requestCapture(ctx, { camera_id: storeCamera.camera_id });
    const bytes = makeJpeg();
    const result = await failing.submitUpload({ tenant_id: T.tenant, memory_space: "home", task_id: "t" }, phone.upload(requested, bytes), bytes);
    expect(result.outcome.status).toBe("failed");
    expect(result.request).toMatchObject({ state: "rejected", reject_reason: "pipeline_failed" });
  });
});

describe("opprettelse av forespørsler", () => {
  it("idempotensnøkkel gir samme forespørsel; maks åpne per kamera; levetid klemmes til 30 s - 15 min", async () => {
    const first = await request({ key: "idem-capture-0001" });
    const again = await request({ key: "idem-capture-0001" });
    expect(again.request_id).toBe(first.request_id);
    await request();
    await request();
    await expect(request()).rejects.toMatchObject({ code: "too_many_pending" });
    expect(CAPTURE_MAX_PENDING_PER_CAMERA).toBe(3);
    await db.admin.query(`UPDATE vision_capture_requests SET state = 'cancelled', resolved_at = now()`);
    const longTtl = await request({ ttl_ms: 24 * 3_600_000 });
    const shortTtl = await request({ ttl_ms: 1 });
    const ms = (r: CaptureRequest): number => new Date(r.expires_at).getTime() - new Date(r.requested_at).getTime();
    expect(ms(longTtl)).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(ms(longTtl)).toBeGreaterThan(14 * 60_000);
    expect(ms(shortTtl)).toBeGreaterThanOrEqual(29_000);
    expect(ms(shortTtl)).toBeLessThan(31_000);
  });

  it("kun en registrert, påslått iPhone-kamera med en policy som behandler bilder - og kun eierens egne kameraer", async () => {
    const haCamera = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "HA", source_type: "home_assistant", source_ref: "camera.ha_x", trigger_entities: [], zone_kind: "home", route_policy: "local_only" });
    const discard = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "Forkast", source_type: "iphone", source_ref: "iphone-forkast", zone_kind: "home", route_policy: "discard" });
    const off = await cameras.registerCamera(T.tenant, "home", { person_id: T.owner, label: "Av", source_type: "iphone", source_ref: "iphone-av", zone_kind: "home", route_policy: "local_only", enabled: false });
    await expectCode(service.requestCapture(ctx, { camera_id: haCamera.camera_id }), "camera_not_iphone");
    await expectCode(service.requestCapture(ctx, { camera_id: discard.camera_id }), "camera_policy_discard");
    await expectCode(service.requestCapture(ctx, { camera_id: off.camera_id }), "camera_disabled");
    await expectCode(service.requestCapture(ctx, { camera_id: "vis-cam-finnes-ikke" }), "camera_not_found");
    await expectCode(service.requestCapture({ ...ctx, person_id: T.other }, { camera_id: storeCamera.camera_id }), "camera_not_found");
    await expectCode(service.requestCapture(ctx, { camera_id: storeCamera.camera_id, idempotency_key: "kort" }), "idempotency_key_invalid");
    await expectCode(service.requestCapture({ ...ctx, tenant_id: T2.tenant }, { camera_id: storeCamera.camera_id }), "camera_not_found");
  });

  it("maintain(): utløpte forespørsler markeres expired, og gamle oppgjorte slettes", async () => {
    const live = await request();
    await db.admin.query(`UPDATE vision_capture_requests SET expires_at = now() - interval '1 second', requested_at = now() - interval '6 minutes' WHERE request_id = $1`, [live.request_id]);
    const first = await service.maintain(T.tenant, "home", 7);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [live.request_id])).rows[0].state).toBe("expired");
    await db.admin.query(`UPDATE vision_capture_requests SET requested_at = now() - interval '30 days', expires_at = now() - interval '30 days' + interval '5 minutes' WHERE request_id = $1`, [live.request_id]);
    expect((await service.maintain(T.tenant, "home", 7)).deleted).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT count(*)::int AS n FROM vision_capture_requests WHERE request_id = $1`, [live.request_id])).toBe(0);
  });
});

describe("signaturkontrakten", () => {
  it("de signerte bytene har domeneseparasjon og versjon, og et felt med linjeskift avvises (ingen feltinjeksjon)", () => {
    const fields = { request_id: "r", tenant_id: "t", person_id: "p", device_id: "d", sha256: "a".repeat(64), byte_length: 10, media_type: "image/jpeg", issued_at: "2026-11-18T12:00:00.000Z" };
    expect(new TextDecoder().decode(captureSigningBytes(fields)).split("\n")[0]).toBe("jarvis.vision.capture.v1");
    expect(() => captureSigningBytes({ ...fields, device_id: "d\nrequest_id" })).toThrow(VisionCaptureError);
  });
});
