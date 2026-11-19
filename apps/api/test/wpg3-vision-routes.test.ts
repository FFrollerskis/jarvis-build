import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { LocalHashEmbedding } from "@jarvis/memory";
import {
  LocalFsStorageAdapter, VisionCameraService, VisionCaptureService, VisionClassifier, VisionEmbeddingService, VisionIngestPipeline, VisionInventoryService, VisionLastSeenService, VisionService, VisionSnapshotService
} from "@jarvis/vision";
import { FakeDevice, TestDeviceRegistry } from "../../../modules/vision/test/support/fake-device.ts";
import { detectionsJson, makeJpeg, NOT_AN_IMAGE, ScriptedGateway, seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G3 (D-465): `/vision/*` over HTTP mot en ekte Postgres (app-rolle, RLS): dormant (404), grant/eier/step-up-rekkefølgen, typet bekreftelse for sletting, enhets-id kun fra grantet og den enhetssignerte
 * engangsopplastingen (replay, annen enhet, annet space, manipulerte bytes, for stor/ugyldig kropp). Svarene bærer aldri bildebytes eller modellens rå tekst.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let url = "";
let urlDormant = "";
let vision: VisionService;
let cameras: VisionCameraService;
let gateway: ScriptedGateway;
let registry: TestDeviceRegistry;
let phone: FakeDevice;
let roomId = "";
let mainCamera = "";
const closers: Array<() => Promise<void>> = [];
const MAX_UPLOAD = 64 * 1024;

type Grant = { person_id: string; tenant_id: string; channel: string; auth_strength: string; session_id: string; memory_space: string; device_id: string };
const grants = new Map<string, Grant>();

const OWNER_ID = (identity: IdentityContext): boolean => identity.person_id === T.owner && identity.tenant_id === T.tenant && identity.delegation_id === undefined;

function makeDeps(withFeature: boolean): ApiDeps {
  return {
    grants: { verify: async (token: string) => (grants.has(token) ? { ok: true, grant: grants.get(token) } : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    owner: { tenant_id: T.tenant, person_id: T.owner },
    ownerGate: OWNER_ID,
    ...(withFeature
      ? {
          vision: {
            cameras,
            capture: new VisionCaptureService(db.app, cameras, pipeline(), registry),
            lastSeen: new VisionLastSeenService(db.app, { embeddings, inventory }),
            inventory,
            maxUploadBytes: MAX_UPLOAD
          }
        }
      : {})
  } as unknown as ApiDeps;
}

let embeddings: VisionEmbeddingService;
let inventory: VisionInventoryService;
let snapshots: VisionSnapshotService;
function pipeline(): VisionIngestPipeline {
  return new VisionIngestPipeline({ pool: db.app, vision, classifier: new VisionClassifier({ gateway: { complete: (c) => gateway.complete(c) } }), snapshots, embeddings, inventory, enabled: true, storeSnapshots: true });
}

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const grant = (over: Partial<Grant> = {}): Grant => ({ person_id: T.owner, tenant_id: T.tenant, channel: "web", auth_strength: "signed", session_id: "s-owner", memory_space: "home", device_id: "web-owner", ...over });

beforeAll(async () => {
  db = await startVisionDb("g3api");
  T = await seedTenant(db, "g3api-t");
  vision = new VisionService(db.app);
  cameras = new VisionCameraService(db.app);
  inventory = new VisionInventoryService(db.app);
  embeddings = new VisionEmbeddingService(db.app, new LocalHashEmbedding());
  snapshots = new VisionSnapshotService(db.app, new LocalFsStorageAdapter(await mkdtemp(join(tmpdir(), "jarvis-vision-g3api-"))), vision);
  roomId = (await vision.createRoom(T.tenant, "home", { person_id: T.owner, name: "Gangen" })).room_id;
  registry = new TestDeviceRegistry();
  phone = new FakeDevice("iphone-eier", T.tenant, T.owner);
  registry.register(phone);
  registry.register(new FakeDevice("iphone-annen", T.tenant, T.owner));
  grants.set("owner-signed", grant());
  grants.set("owner-active", grant({ auth_strength: "active", session_id: "s-active" }));
  grants.set("owner-voice", grant({ channel: "voice", session_id: "s-voice" }));
  grants.set("other-signed", grant({ person_id: T.other, session_id: "s-other", device_id: "web-other" }));
  grants.set("phone", grant({ channel: "mobile", session_id: "s-phone", device_id: "iphone-eier" }));
  grants.set("phone-other-device", grant({ channel: "mobile", session_id: "s-phone2", device_id: "iphone-annen" }));
  grants.set("phone-personal-space", grant({ channel: "mobile", session_id: "s-phone3", device_id: "iphone-eier", memory_space: "personal" }));
  url = await listen(makeDeps(true));
  urlDormant = await listen(makeDeps(false));
  // Én iPhone = ÉN registrert kilde per space (unik indeks): hovedkameraet gjenbrukes av opptakstestene.
  mainCamera = await iphone("Hovedkamera", "iphone-eier");
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await db?.stop();
}, 120_000);

beforeEach(async () => {
  gateway = new ScriptedGateway();
  gateway.text = detectionsJson([{ event_type: "object_detected", object_label: "ryggsekk", confidence: 0.9 }]);
  await db.admin.query(`UPDATE vision_capture_requests SET state = 'cancelled', resolved_at = now() WHERE state = 'pending'`);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testens svar-JSON er bevisst løst typet
type Json = Record<string, any>;
const post = (base: string, path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const call = async (path: string, token: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: Json }> => {
  const res = await post(url, path, { grant_token: token, ...body });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
};
const iphone = async (label: string, ref = "iphone-eier", policy: "local_only" | "store_snapshot" | "discard" = "store_snapshot", room = true): Promise<string> => {
  const res = await call("/vision/cameras/register", "owner-signed", { label, source_type: "iphone", source_ref: ref, zone_kind: "home", route_policy: policy, ...(room ? { room_id: roomId } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body["data"]["camera_id"] as string;
};
const upload = (request: { request_id: string }, bytes: Uint8Array, over: Record<string, unknown> = {}, device = phone): Record<string, unknown> => {
  const signed = device.upload(request, bytes);
  return { request_id: signed.request_id, media_type: signed.media_type, byte_length: signed.byte_length, sha256: signed.sha256, issued_at: signed.issued_at, signature: signed.signature, data_base64: Buffer.from(bytes).toString("base64"), ...over };
};

describe("dormant: uten deps.vision finnes ingen rute", () => {
  it("alle ruter gir 404 selv med gyldig eier-grant; med deps.vision gir feil metode/ukjent sti også 404", async () => {
    for (const path of ["/vision/cameras/list", "/vision/cameras/register", "/vision/capture/request", "/vision/capture/upload", "/vision/last-seen", "/vision/inventory"]) {
      expect((await post(urlDormant, path, { grant_token: "owner-signed" })).status, path).toBe(404);
    }
    expect((await fetch(`${url}/vision/cameras/list`)).status).toBe(404); // GET
    expect((await post(url, "/vision/unknown", { grant_token: "owner-signed" })).status).toBe(404);
    expect((await post(url, "/vision/cameras/list/extra", { grant_token: "owner-signed" })).status).toBe(404);
  });
});

describe("kropp, grant, eier og step-up - alt avvises FØR noe skrives", () => {
  it("uten grant 401; ugyldig grant 403; identitetsfelt (også enhet/space) og ukjente felt 400", async () => {
    expect((await post(url, "/vision/cameras/list", {})).status).toBe(401);
    expect((await call("/vision/cameras/list", "bogus")).status).toBe(403);
    for (const field of ["person_id", "tenant_id", "memory_space", "memory_space_id", "device_id", "session_id", "channel", "auth_strength"]) {
      const res = await call("/vision/cameras/list", "owner-signed", { [field]: "x" });
      expect(res.status, field).toBe(400);
      expect(res.body["error"]).toBe("identity_field_forbidden");
    }
    expect((await call("/vision/cameras/list", "owner-signed", { surprise: 1 })).status).toBe(400);
    expect((await call("/vision/cameras/register", "owner-signed", { label: "x", source_type: "iphone", source_ref: "d", zone_kind: "home", route_policy: "local_only", person_id: "p" })).status).toBe(400);
  });

  it("en annen person i samme tenant får 403 owner_required på alle eier-ruter; enhets-rutene er personbundne", async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["/vision/cameras/list", {}], ["/vision/last-seen", { query: "x" }], ["/vision/inventory", {}],
      ["/vision/cameras/register", { label: "x", source_type: "iphone", source_ref: "d", zone_kind: "home", route_policy: "local_only" }],
      ["/vision/cameras/update", { camera_id: "c", label: "x" }], ["/vision/cameras/remove", { camera_id: "c", confirm: true, confirm_camera_id: "c" }], ["/vision/capture/request", { camera_id: "c" }]
    ];
    for (const [path, body] of bodies) {
      const res = await call(path, "other-signed", body);
      expect(res.status, path).toBe(403);
      expect(res.body["error"], path).toBe("owner_required");
    }
  });

  it("skriving krever step-up (signert enhetsøkt fra en eier-kanal): active-økt og talekanal -> 403; lesing fungerer med active", async () => {
    const register = { label: "Uten step-up", source_type: "iphone", source_ref: "iphone-xyz", zone_kind: "home", route_policy: "local_only" };
    const active = await call("/vision/cameras/register", "owner-active", register);
    expect(active.status).toBe(403);
    expect(active.body).toMatchObject({ error: "step_up_required", reason: "step_up_required:signed_device_session" });
    const voice = await call("/vision/cameras/register", "owner-voice", register);
    expect(voice.status).toBe(403);
    expect(voice.body["reason"]).toBe("step_up_required:channel_voice_not_allowed");
    expect((await call("/vision/cameras/list", "owner-active")).status).toBe(200);
    expect(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_cameras WHERE source_ref = 'iphone-xyz'`)).rows[0] as { n: number }).n).toBe(0);
  });
});

describe("kamera-registeret", () => {
  it("registrer -> list -> oppdater -> fjern (typet bekreftelse); person fra grantet, validering gir 400 med feltnavn", async () => {
    const id = await iphone("Reg-test", "iphone-reg-1", "local_only");
    const listed = await call("/vision/cameras/list", "owner-signed");
    expect(listed.status).toBe(200);
    expect(listed.body["data"]["cameras"].find((c: { camera_id: string }) => c.camera_id === id)).toMatchObject({ label: "Reg-test", person_id: T.owner, source_type: "iphone", route_policy: "local_only", enabled: true });

    const updated = await call("/vision/cameras/update", "owner-signed", { camera_id: id, label: "Omdøpt", cooldown_seconds: 60, enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body["data"]).toMatchObject({ label: "Omdøpt", cooldown_seconds: 60, enabled: false });
    expect((await call("/vision/cameras/update", "owner-signed", { camera_id: "vis-cam-finnes-ikke", label: "x" })).status).toBe(404);
    expect((await call("/vision/cameras/update", "owner-signed", { label: "uten id" })).status).toBe(400);

    const noConfirm = await call("/vision/cameras/remove", "owner-signed", { camera_id: id });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body).toMatchObject({ error: "confirmation_required", confirm_camera_id_required: id });
    expect((await call("/vision/cameras/remove", "owner-signed", { camera_id: id, confirm: true, confirm_camera_id: "annen-id" })).status).toBe(409);
    expect((await call("/vision/cameras/remove", "owner-signed", { camera_id: id, confirm: "true", confirm_camera_id: id })).status).toBe(409);
    expect(((await db.admin.query(`SELECT count(*)::int AS n FROM vision_cameras WHERE camera_id = $1`, [id])).rows[0] as { n: number }).n).toBe(1);
    expect((await call("/vision/cameras/remove", "owner-signed", { camera_id: id, confirm: true, confirm_camera_id: id })).body["data"]).toEqual({ removed: true, camera_id: id });
    expect((await call("/vision/cameras/remove", "owner-signed", { camera_id: id, confirm: true, confirm_camera_id: id })).status).toBe(404);
  });

  it("samme kilde to ganger (samme enhet i samme space) er en konflikt 409, ikke en serverfeil", async () => {
    const again = await call("/vision/cameras/register", "owner-signed", { label: "Dobbel", source_type: "iphone", source_ref: "iphone-eier", zone_kind: "home", route_policy: "local_only" });
    expect(again.status).toBe(409);
    expect(again.body["error"]).toBe("camera_already_registered");
  });

  it("valideringsfeil: arbeidsplass kan aldri lagre bilder, ugyldig HA-entity og ukjent policy gir 400 med feltnavn (aldri 500)", async () => {
    const work = await call("/vision/cameras/register", "owner-signed", { label: "Jobb", source_type: "iphone", source_ref: "iphone-jobb", zone_kind: "workplace", route_policy: "store_snapshot" });
    expect(work.status).toBe(400);
    expect(work.body).toMatchObject({ error: "vision_validation", field: "route_policy", detail: "zone_forbids_storage" });
    const ha = await call("/vision/cameras/register", "owner-signed", { label: "HA", source_type: "home_assistant", source_ref: "sensor.not_a_camera", zone_kind: "home", route_policy: "local_only" });
    expect(ha.body).toMatchObject({ error: "vision_validation", field: "source_ref" });
    const policy = await call("/vision/cameras/register", "owner-signed", { label: "X", source_type: "iphone", source_ref: "iphone-x", zone_kind: "home", route_policy: "cloud" });
    expect(policy.status).toBe(400);
    expect(policy.body["error"]).toBe("vision_validation");
    expect((await call("/vision/cameras/register", "owner-signed", { label: "Uten policy", source_type: "iphone", source_ref: "iphone-np", zone_kind: "home" })).status).toBe(400); // ingen standardpolicy
  });
});

describe("iPhone-opptak på forespørsel (enhetssignert engangsopplasting)", () => {
  it("ende-til-ende: eier ber -> enheten (kun sine egne) henter -> signert opplasting -> pipeline; svaret har kun utfallskoder (ingen etiketter/bytes); replay -> 409", async () => {
    const cameraId = mainCamera;
    const requested = await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, idempotency_key: "idem-e2e-0001", ttl_seconds: 120 });
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    const request = requested.body["data"] as { request_id: string; device_id: string; state: string };
    expect(request).toMatchObject({ device_id: "iphone-eier", state: "pending" });
    expect(Object.keys(request).sort()).toEqual(["camera_id", "device_id", "expires_at", "request_id", "requested_at", "resolved_at", "state"]);
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, idempotency_key: "idem-e2e-0001", ttl_seconds: 120 })).body["data"]["request_id"]).toBe(request.request_id);

    // en ANNEN enhet (samme eier) ser ikke forespørselen; riktig enhet gjør det
    expect((await call("/vision/capture/pending", "phone-other-device")).body["data"]["requests"]).toEqual([]);
    const pending = await call("/vision/capture/pending", "phone");
    expect(pending.body["data"]["requests"].map((r: { request_id: string }) => r.request_id)).toEqual([request.request_id]);

    const bytes = makeJpeg();
    const done = await call("/vision/capture/upload", "phone", upload(request, bytes));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body["data"]).toEqual({ request: { request_id: request.request_id, state: "fulfilled" }, outcome: { status: "recorded", reason: "ok_store_snapshot", classification_status: "classified", detection_count: 1, snapshot_stored: true } });
    expect(JSON.stringify(done.body)).not.toMatch(/ryggsekk|data_base64|signature/);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({ mode: "LOCAL", sensitivity: "SECRET_RESTRICTED", paid_models_allowed: false });

    const replay = await call("/vision/capture/upload", "phone", upload(request, bytes));
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: "vision_capture", code: "request_not_pending" });
    expect(gateway.calls).toHaveLength(1);

    // «sist sett» finner objektet med romnavn fra kameraets plassering, og inventaret har det
    const seen = await call("/vision/last-seen", "owner-signed", { query: "Ryggsekk" });
    expect(seen.status).toBe(200);
    expect(seen.body["data"]).toMatchObject({ query: "ryggsekk", found: true, last: { object_label: "ryggsekk", room_name: "Gangen", has_snapshot: true, source_type: "iphone" }, inventory_present_now: true });
    const items = await call("/vision/inventory", "owner-signed", { room_id: roomId });
    expect(items.body["data"]["items"].map((i: { object_label: string }) => i.object_label)).toContain("ryggsekk");
  });

  it("device_id kommer fra grantet: en annen enhet kan ikke laste opp en forespørsel adressert til iphone-eier (device_mismatch 403), og kroppen kan ikke bære device_id (400)", async () => {
    const cameraId = mainCamera;
    const request = (await call("/vision/capture/request", "owner-signed", { camera_id: cameraId })).body["data"] as { request_id: string };
    const bytes = makeJpeg();
    const stolen = await call("/vision/capture/upload", "phone-other-device", upload(request, bytes));
    expect(stolen.status).toBe(403);
    expect(stolen.body).toMatchObject({ code: "device_mismatch" });
    const claimed = await call("/vision/capture/upload", "phone-other-device", { ...upload(request, bytes), device_id: "iphone-eier" });
    expect(claimed.status).toBe(400);
    expect(claimed.body["error"]).toBe("identity_field_forbidden");
    expect(((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [request.request_id])).rows[0] as { state: string }).state).toBe("pending");
  });

  it("enhetens økt i et annet memory space ser ikke forespørselen (request_not_found 404) - enhetens scope MÅ være kameraets space", async () => {
    const cameraId = mainCamera;
    const request = (await call("/vision/capture/request", "owner-signed", { camera_id: cameraId })).body["data"] as { request_id: string };
    expect((await call("/vision/capture/pending", "phone-personal-space")).body["data"]["requests"]).toEqual([]);
    const res = await call("/vision/capture/upload", "phone-personal-space", upload(request, makeJpeg()));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "request_not_found" });
  });

  it("ugyldige opplastinger: manipulert bilde 400 hash_mismatch, falsk signatur 403, ikke-bilde 400, ugyldig base64/felt/lengde 400, for stor kropp 413 - ingenting forbrukes", async () => {
    const cameraId = mainCamera;
    const request = (await call("/vision/capture/request", "owner-signed", { camera_id: cameraId })).body["data"] as { request_id: string };
    const bytes = makeJpeg();
    const tampered = Uint8Array.from(bytes);
    tampered[30] = (tampered[30] as number) ^ 0xff;
    const hashMismatch = await call("/vision/capture/upload", "phone", upload(request, bytes, { data_base64: Buffer.from(tampered).toString("base64") }));
    expect(hashMismatch.status).toBe(400);
    expect(hashMismatch.body["code"]).toBe("hash_mismatch");
    const stranger = new FakeDevice("iphone-eier", T.tenant, T.owner);
    const forged = await call("/vision/capture/upload", "phone", upload(request, bytes, {}, stranger));
    expect(forged.status).toBe(403);
    expect(forged.body["code"]).toBe("invalid_signature");
    const html = await call("/vision/capture/upload", "phone", upload(request, NOT_AN_IMAGE));
    expect(html.status).toBe(400);
    expect(html.body["code"]).toBe("image_unsupported_format");
    for (const bad of [{ data_base64: "ikke base64!!" }, { data_base64: "abc" }, { byte_length: 0 }, { byte_length: 1.5 }, { byte_length: MAX_UPLOAD + 1 }, { signature: "" }, { sha256: 7 }, { media_type: "video/mp4" }]) {
      const res = await call("/vision/capture/upload", "phone", upload(request, bytes, bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const huge = await post(url, "/vision/capture/upload", { grant_token: "phone", ...upload(request, bytes), data_base64: "A".repeat(MAX_UPLOAD * 3) });
    expect(huge.status).toBe(413);
    expect(((await db.admin.query(`SELECT state FROM vision_capture_requests WHERE request_id = $1`, [request.request_id])).rows[0] as { state: string }).state).toBe("pending");
    expect(gateway.calls).toHaveLength(0);
  });

  it("forespørselsvalidering: ukjent/ikke-iPhone/policy-forkast kamera gir 404/409 med stabil kode; ugyldig ttl/nøkkel gir 400; for mange åpne gir 429", async () => {
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: "vis-cam-finnes-ikke" })).status).toBe(404);
    const discard = await iphone("Forkast", "iphone-forkast", "discard");
    const res = await call("/vision/capture/request", "owner-signed", { camera_id: discard });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "vision_capture", code: "camera_policy_discard" });
    const ha = (await call("/vision/cameras/register", "owner-signed", { label: "HA-kam", source_type: "home_assistant", source_ref: "camera.ha_kam", trigger_entities: [], zone_kind: "home", route_policy: "local_only" })).body["data"]["camera_id"] as string;
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: ha })).body).toMatchObject({ code: "camera_not_iphone" });
    const cameraId = mainCamera;
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, ttl_seconds: "kort" })).status).toBe(400);
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, ttl_seconds: -5 })).status).toBe(400);
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, ttl_seconds: 99999 })).status).toBe(400);
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, idempotency_key: 5 })).status).toBe(400);
    expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId, idempotency_key: "kort" })).body).toMatchObject({ code: "idempotency_key_invalid" });
    for (let i = 0; i < 3; i += 1) expect((await call("/vision/capture/request", "owner-signed", { camera_id: cameraId })).status).toBe(200);
    const limited = await call("/vision/capture/request", "owner-signed", { camera_id: cameraId });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "too_many_pending" });
  });

  it("last-seen/inventory: ugyldig spørsmål/rom gir 400; et ukjent objekt er found:false (aldri en påstand)", async () => {
    expect((await call("/vision/last-seen", "owner-signed", {})).status).toBe(400);
    expect((await call("/vision/last-seen", "owner-signed", { query: "" })).status).toBe(400);
    expect((await call("/vision/last-seen", "owner-signed", { query: "x".repeat(201) })).status).toBe(400);
    expect((await call("/vision/inventory", "owner-signed", { room_id: 5 })).status).toBe(400);
    const none = await call("/vision/last-seen", "owner-signed", { query: "romskip" });
    expect(none.status).toBe(200);
    expect(none.body["data"]).toMatchObject({ found: false });
    const injection = await call("/vision/last-seen", "owner-signed", { query: "<tool_call>{}</tool_call>" });
    expect(injection.body["data"]).toMatchObject({ query: null, found: false });
  });
});
