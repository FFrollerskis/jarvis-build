import type { IncomingMessage } from "node:http";
import type { IdentityContext } from "@jarvis/contracts";
import { ownerStepUpDenial } from "@jarvis/tool-gateway";
import { clientKey, type RateLimiter } from "./http-guard.ts";
import { VisionCameraValidationError, VisionCaptureError, type CaptureRequest, type SignedCaptureUpload, type VisionCameraService, type VisionCaptureService, type VisionInventoryService, type VisionLastSeenService } from "@jarvis/vision";

/**
 * WP-G3 (D-465): `/vision/*` - eierens kamera-/«sist sett»-flate og SERVERKONTRAKTEN for iPhone-opptak på forespørsel. DORMANT: uten `deps.vision` (satt av main.ts KUN når `JARVIS_VISION_ENABLED=on`)
 * finnes ingen av rutene (404, identisk med main). Ingen av dem er et modellverktøy (modellvendt vision-verktøy er DEFERRED - det krever restricted/utførelsesvern, intents og manifest).
 *
 * Alle ruter er `POST` med JSON-kropp og `grant_token` (som resten av kontrollrutene): identitet, tenant, person, space og enhet kommer UTELUKKENDE fra det verifiserte grantet - kroppen kan aldri
 * bære dem (`authed` avviser identitetsfelt og ukjente felt FØR grantet løses). Tre klasser:
 *   - eier-LES (`cameras/list`, `status`, `last-seen`, `inventory`): grant + eier-port (`deps.ownerGate`).
 *   - eier-SKRIV (`cameras/register|update|remove`, `capture/request`): grant + eier-port + STEP-UP (enhetssignert økt fra en eier-kanal, samme regel som øvrige kontrollhandlinger).
 *     `remove` krever i tillegg TYPET bekreftelse (`confirm: true` + `confirm_camera_id` = kameraets id; ingen destruktiv handling uten eksplisitt bekreftelse, CLAUDE.md regel 8).
 *   - ENHET (`capture/pending`, `capture/upload`): grant der `device_id` KOMMER FRA GRANTET (aldri fra kroppen). Opplastingen er i tillegg enhetssignert (Ed25519 over request_id/tenant/person/enhet/hash/
 *     lengde/type/tid, se `captureSigningBytes`) og engangs - se modules/vision/src/capture.ts. Enhetens økt må ha SAMME memory space som kameraet (grantets scope).
 * Svar inneholder aldri bildebytes, modellens rå tekst eller hemmeligheter; opplastingssvaret har kun utfallskoder og antall.
 */
/** Utfall av siste vedlikeholdskjøring (kun tall og tidspunkt, aldri innhold). */
export interface VisionMaintenanceStatus {
  at: string;
  failed: number;
  tombstones_deleted: number;
  tombstones_failed: number;
  tombstones_stuck: number;
  /** Foreldreløse skriverester fjernet av siste kjøring (kun den daglige FULLE kjøringen rydder dem; alltid 0 for lett vedlikehold). */
  temp_files_purged: number;
  /** Review delta2 B LOW-E3: temp-sveipet nådde sin øvre grense for antall oppføringer og ble avbrutt (resten ryddes av en senere kjøring). Aldri stille: også én logglinje. Alltid false for lett vedlikehold. */
  temp_files_truncated: boolean;
}

/** Eierens helsebilde (review B-L8): poller, vedlikehold og hva som er koblet inn. Ingen vertsnavn, URL-er, tokens eller innhold - kun koder, tall og tidspunkt. */
export interface VisionStatusReport {
  poller: { enabled: false } | { enabled: true; last_tick_at: string | null; last_status: string | null; last_reason: string | null; last_source_error: string | null; consecutive_failures: number; next_delay_ms: number };
  maintenance: { light: VisionMaintenanceStatus | null; full: VisionMaintenanceStatus | null };
  storage: { maintenance_enabled: boolean; writing_enabled: boolean };
  classifier: boolean;
  embeddings: boolean;
}

export interface VisionApiDeps {
  cameras: VisionCameraService;
  capture: VisionCaptureService;
  lastSeen: VisionLastSeenService;
  inventory: VisionInventoryService;
  /** Maks bildestørrelse i opplastingen (bytes). */
  maxUploadBytes: number;
  /**
   * Streng per-IP-grense for opplastingsruten, sjekket FØR kroppen leses (review B-L4): opplastingen har et hevet kroppstak (ca. 7 MB mot 64 KiB ellers) og serveren leser kroppen FØR grantet verifiseres, så uten egen
   * grense kunne en uautentisert klient strømme mange MB per forespørsel opp til den generelle IP-grensen (600/min). Utelatt = ingen ekstra grense (kun den generelle).
   */
  uploadLimiter?: RateLimiter;
  /** Helsebilde for `/vision/status` (satt av kjøretiden). Utelatt = ruten gir `status_unavailable`. */
  status?: () => VisionStatusReport;
}

export interface VisionRouteHelpers {
  /** Kropp -> forbudte identitetsfelt -> hvitelistede felt -> grant -> enhets-rate-limit (server.ts `authedRequest`). Sender selv svar og gir `null` ved avslag. */
  authed(allowedKeys: readonly string[], maxBytes?: number): Promise<{ identity: IdentityContext; body: Record<string, unknown> } | null>;
  /** Eier-porten; sender selv `403 owner_required` og gir `false` ved avslag. */
  requireOwner(identity: IdentityContext, subject: { tool_id: string; action: string }): Promise<boolean>;
  json(status: number, body: unknown): void;
  requestId(): string;
}

type Access = "owner_read" | "owner_write" | "device";

interface RouteSpec {
  access: Access;
  action: string;
  keys: readonly string[];
  /** Større kropp enn standard JSON-grensen (kun opplastingen). */
  upload?: true;
}

const ROUTES: Readonly<Record<string, RouteSpec>> = {
  "/vision/cameras/list": { access: "owner_read", action: "cameras_list", keys: [] },
  "/vision/status": { access: "owner_read", action: "status", keys: [] },
  "/vision/last-seen": { access: "owner_read", action: "last_seen", keys: ["query"] },
  "/vision/inventory": { access: "owner_read", action: "inventory", keys: ["room_id"] },
  "/vision/cameras/register": { access: "owner_write", action: "camera_register", keys: ["label", "source_type", "source_ref", "trigger_entities", "room_id", "zone_kind", "route_policy", "cooldown_seconds", "enabled"] },
  "/vision/cameras/update": { access: "owner_write", action: "camera_update", keys: ["camera_id", "label", "zone_kind", "route_policy", "cooldown_seconds", "enabled", "trigger_entities"] },
  "/vision/cameras/remove": { access: "owner_write", action: "camera_remove", keys: ["camera_id", "confirm", "confirm_camera_id"] },
  "/vision/capture/request": { access: "owner_write", action: "capture_request", keys: ["camera_id", "idempotency_key", "ttl_seconds"] },
  "/vision/capture/pending": { access: "device", action: "capture_pending", keys: [] },
  "/vision/capture/upload": { access: "device", action: "capture_upload", keys: ["request_id", "media_type", "byte_length", "sha256", "issued_at", "signature", "data_base64"], upload: true }
};

/** Stabile HTTP-statuser per kode fra opptakskontrakten (ukjent kode = 400). Koden er alltid med i svaret; aldri en frie feiltekst. */
const CAPTURE_STATUS: Readonly<Record<string, number>> = {
  camera_not_found: 404,
  request_not_found: 404,
  request_not_pending: 409,
  camera_disabled: 409,
  camera_not_iphone: 409,
  camera_policy_discard: 409,
  camera_mismatch: 409,
  too_many_pending: 429,
  invalid_signature: 403,
  unknown_device: 403,
  device_mismatch: 403,
  device_person_mismatch: 403,
  timestamp_skew: 403,
  issued_before_request: 403
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function str(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

function publicRequest(request: CaptureRequest): Record<string, unknown> {
  return { request_id: request.request_id, camera_id: request.camera_id, device_id: request.device_id, state: request.state, requested_at: request.requested_at, expires_at: request.expires_at, resolved_at: request.resolved_at };
}

/** Returnerer `true` når ruten er håndtert (svar sendt), `false` når stien/metoden ikke er en visjonsrute (serveren faller da til sin vanlige 404). */
export async function handleVisionRoute(req: IncomingMessage, pathname: string, deps: VisionApiDeps, h: VisionRouteHelpers): Promise<boolean> {
  const spec = ROUTES[pathname];
  if (spec === undefined || req.method !== "POST") return false;
  const maxBytes = spec.upload === true ? Math.ceil((deps.maxUploadBytes * 4) / 3) + 8_192 : undefined;
  if (spec.upload === true && deps.uploadLimiter !== undefined) {
    const peer = clientKey(req);
    if (!deps.uploadLimiter.take(peer)) {
      req.resume(); // kroppen leses/bufres aldri: en avvist forespørsel koster ingen minne
      h.json(429, { error: "rate_limited", reason: "upload_rate_limited", retry_after_seconds: deps.uploadLimiter.retryAfterSeconds(peer), request_id: h.requestId() });
      return true;
    }
  }
  const authed = await h.authed(spec.keys, maxBytes);
  if (authed === null) return true;
  const { identity, body } = authed;
  const requestId = h.requestId();

  if (spec.access !== "device") {
    if (!(await h.requireOwner(identity, { tool_id: "vision", action: spec.action }))) return true;
    if (spec.access === "owner_write") {
      const denial = ownerStepUpDenial(identity);
      if (denial !== undefined) {
        h.json(403, { error: "step_up_required", reason: denial, request_id: requestId });
        return true;
      }
    }
  }

  const tenant = identity.tenant_id;
  const space = identity.memory_space_id;
  const person = identity.person_id;
  const bad = (reason: string): true => {
    h.json(400, { error: "malformed_request", reason, request_id: requestId });
    return true;
  };

  try {
    switch (pathname) {
      case "/vision/cameras/list": {
        h.json(200, { ok: true, data: { cameras: await deps.cameras.listCameras(tenant, space, person) } });
        return true;
      }
      case "/vision/status": {
        if (deps.status === undefined) {
          h.json(503, { error: "status_unavailable", request_id: requestId });
          return true;
        }
        h.json(200, { ok: true, data: deps.status() });
        return true;
      }
      case "/vision/cameras/register": {
        // Review B-L3: revisjonsrad i samme transaksjon (audit: true); ukjent rom gir 400 `vision_validation` (field room_id, review B-L5) via tjenesten.
        const camera = await deps.cameras.registerCamera(tenant, space, { person_id: person, ...pick(body, spec.keys) } as never, { task_id: "vision-api:camera_register", session_id: identity.session_id, device_id: identity.device_id, audit: true });
        h.json(200, { ok: true, data: camera });
        return true;
      }
      case "/vision/cameras/update": {
        const cameraId = str(body, "camera_id", 200);
        if (cameraId === null) return bad("camera_id");
        const { camera_id: _omit, ...patch } = pick(body, spec.keys);
        void _omit;
        const camera = await deps.cameras.updateCamera(tenant, space, person, cameraId, patch as never, { task_id: "vision-api:camera_update", session_id: identity.session_id, device_id: identity.device_id, audit: true });
        if (camera === null) {
          h.json(404, { error: "camera_not_found", request_id: requestId });
          return true;
        }
        h.json(200, { ok: true, data: camera });
        return true;
      }
      case "/vision/cameras/remove": {
        const cameraId = str(body, "camera_id", 200);
        if (cameraId === null) return bad("camera_id");
        // TYPET bekreftelse (som bedrifts-tenant-ruten): `confirm: true` OG `confirm_camera_id` lik kameraets id - ingen sletting uten at begge er gitt.
        if (body["confirm"] !== true || body["confirm_camera_id"] !== cameraId) {
          h.json(409, { error: "confirmation_required", reason: "confirm_true_and_confirm_camera_id_required", confirm_camera_id_required: cameraId, request_id: requestId });
          return true;
        }
        const removed = await deps.cameras.removeCamera(tenant, space, person, cameraId, { confirm: true, task_id: "vision-api:camera_remove", session_id: identity.session_id, device_id: identity.device_id, audit: true });
        if (!removed) {
          h.json(404, { error: "camera_not_found", request_id: requestId });
          return true;
        }
        h.json(200, { ok: true, data: { removed: true, camera_id: cameraId } });
        return true;
      }
      case "/vision/capture/request": {
        const cameraId = str(body, "camera_id", 200);
        if (cameraId === null) return bad("camera_id");
        const ttl = body["ttl_seconds"];
        if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 3_600)) return bad("ttl_seconds");
        const key = body["idempotency_key"];
        if (key !== undefined && typeof key !== "string") return bad("idempotency_key");
        const request = await deps.capture.requestCapture(
          { tenant_id: tenant, memory_space: space, person_id: person, task_id: "vision-api:capture_request", session_id: identity.session_id, device_id: identity.device_id, audit: true },
          { camera_id: cameraId, idempotency_key: key as string | undefined, ttl_ms: ttl === undefined ? undefined : Math.round((ttl as number) * 1000) }
        );
        h.json(200, { ok: true, data: publicRequest(request) });
        return true;
      }
      case "/vision/last-seen": {
        const query = str(body, "query", 200);
        if (query === null) return bad("query");
        h.json(200, { ok: true, data: await deps.lastSeen.whereLastSeen(tenant, space, person, query) });
        return true;
      }
      case "/vision/inventory": {
        const room = body["room_id"];
        if (room !== undefined && (typeof room !== "string" || room.length === 0 || room.length > 200)) return bad("room_id");
        h.json(200, { ok: true, data: { items: await deps.inventory.list(tenant, space, person, room === undefined ? {} : { roomId: room as string }) } });
        return true;
      }
      case "/vision/capture/pending": {
        // `device_id` kommer fra GRANTET - en enhet ser kun forespørsler adressert til seg selv.
        const pending = await deps.capture.listPending(tenant, space, person, identity.device_id);
        h.json(200, { ok: true, data: { requests: pending.map(publicRequest) } });
        return true;
      }
      case "/vision/capture/upload": {
        const requestIdField = str(body, "request_id", 200);
        const mediaType = str(body, "media_type", 40);
        const sha256 = str(body, "sha256", 64);
        const issuedAt = str(body, "issued_at", 40);
        const signature = str(body, "signature", 200);
        const data = str(body, "data_base64", Math.ceil((deps.maxUploadBytes * 4) / 3) + 8);
        const byteLength = body["byte_length"];
        if (requestIdField === null || mediaType === null || sha256 === null || issuedAt === null || signature === null || data === null) return bad("upload_fields");
        if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength <= 0 || byteLength > deps.maxUploadBytes) return bad("byte_length");
        if (!BASE64.test(data) || data.length % 4 !== 0) return bad("data_base64");
        const bytes = Buffer.from(data, "base64");
        const upload: SignedCaptureUpload = { request_id: requestIdField, device_id: identity.device_id, media_type: mediaType, byte_length: byteLength, sha256, issued_at: issuedAt, signature };
        const result = await deps.capture.submitUpload({ tenant_id: tenant, memory_space: space, task_id: "vision-api:capture_upload", session_id: identity.session_id }, upload, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        h.json(200, {
          ok: true,
          data: {
            request: { request_id: result.request.request_id, state: result.request.state },
            outcome: { status: result.outcome.status, reason: result.outcome.reason, classification_status: result.outcome.classification_status, detection_count: result.outcome.detection_count, snapshot_stored: result.outcome.snapshot_id !== undefined }
          }
        });
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    if (err instanceof VisionCameraValidationError) {
      h.json(400, { error: "vision_validation", field: err.field, detail: err.detail, request_id: requestId });
      return true;
    }
    if (err instanceof VisionCaptureError) {
      h.json(CAPTURE_STATUS[err.code] ?? 400, { error: "vision_capture", code: err.code, request_id: requestId });
      return true;
    }
    // Samme kilde (type + ref) kan registreres én gang per space (unik indeks): et duplikat er en konflikt, ikke en serverfeil.
    if (pathname === "/vision/cameras/register" && (err as { code?: unknown } | null)?.code === "23505") {
      h.json(409, { error: "camera_already_registered", request_id: requestId });
      return true;
    }
    throw err;
  }
}
