import { randomUUID, verify, type KeyObject } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionCameraService } from "./cameras.ts";
import { inspectImage, VisionImageError } from "./image.ts";
import type { IngestOutcome, VisionIngestPipeline } from "./pipeline.ts";

/**
 * WP-G3 (D-465), P2d: iPhone-kamera PÅ FORESPØRSEL - KUN serverkontrakten. Appen er `BLOCKED_EXTERNAL` (Apple Developer-konto, signering, APNs); en fake enhet i testene
 * (`modules/vision/test/support/fake-device.ts`) følger nøyaktig samme protokoll som appen vil.
 *
 * D-41-revisjon (iPhone): Apple tilbyr INGEN serverside kamera-API - opptak skjer i en egen app på enheten (AVFoundation, krever kamera-tillatelse og at appen er i forgrunnen; et
 * kamera i bakgrunnen uten brukerens viten er ikke mulig på iOS - `unverified`: ikke lest mot Apples dokumentasjon i økten, kun kjent praksis). Derfor er «på forespørsel» her:
 * eieren ber om ETT opptak -> enheten VISER forespørselen og eieren godtar på enheten -> enheten laster opp ETT signert øyeblikksbilde. Jarvis kan aldri slå på et kamera selv.
 *
 * PROTOKOLL (alle steg deterministiske, ingen modell):
 *   1. `requestCapture`: eier (eier-rute, signert enhetsøkt) oppretter en forespørsel (`pending`, levetid 30 s-15 min, standard 5 min, maks 3 åpne per kamera, idempotensnøkkel).
 *   2. `listPending`: appen poller (eller får push - BLOCKED_EXTERNAL) sine åpne forespørsler.
 *   3. `submitUpload`: enheten laster opp ETT bilde + en Ed25519-signatur over (domene, request_id, tenant, person, enhet, sha256, størrelse, media type, tidsstempel). Serveren verifiserer
 *      mot enhetsregisteret (revokert/ukjent enhet = avvist), at enheten tilhører samme person som forespørselen, tidsstempelet (skjevhet ±5 min), bildet (magic bytes, størrelse, hash
 *      lik den signerte) og FORBRUKER forespørselen med en betinget UPDATE (engangs: en gjentatt opplasting er `request_not_pending`). Deretter går bildet gjennom SAMME pipeline som en
 *      HA-hendelse (datapolicy for kameraet, lokal klassifisering, valgfri lagring) - uten utløserhendelse: kun det modellen ser skrives.
 *   Signaturen binder opplastingen til nøyaktig denne forespørselen, denne enheten og disse bytene: den kan ikke gjenbrukes for en annen forespørsel eller et annet bilde.
 */
export type CaptureState = "pending" | "fulfilled" | "expired" | "cancelled" | "rejected";

export interface CaptureRequest {
  request_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  camera_id: string;
  device_id: string;
  state: CaptureState;
  idempotency_key: string | null;
  requested_at: string;
  expires_at: string;
  resolved_at: string | null;
  snapshot_id: string | null;
  upload_sha256: string | null;
  reject_reason: string | null;
  task_id: string;
  session_id: string | null;
}

export class VisionCaptureError extends Error {
  constructor(readonly code: string) {
    super(`vision_capture_error:${code}`);
    this.name = "VisionCaptureError";
  }
}

export const CAPTURE_DEFAULT_TTL_MS = 5 * 60_000;
export const CAPTURE_MIN_TTL_MS = 30_000;
export const CAPTURE_MAX_TTL_MS = 15 * 60_000;
export const CAPTURE_MAX_PENDING_PER_CAMERA = 3;
export const CAPTURE_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const CAPTURE_SIGNATURE_SKEW_MS = 5 * 60_000;
export const CAPTURE_SIGNING_DOMAIN = "jarvis.vision.capture.v1";

/** Delmengden av `DeviceRegistry` (@jarvis/policy) som kontrakten trenger - strukturell, så pakken ikke avhenger av policy-pakken. En revokert enhet gir `undefined`. */
export interface CaptureDeviceRegistry {
  approverFor(deviceId: string, tenantId: string): Promise<{ key: KeyObject; tenant_id: string; person_id: string } | undefined>;
}

export interface SignedCaptureUpload {
  request_id: string;
  device_id: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  /** ISO 8601, satt av enheten. */
  issued_at: string;
  /** Base64 av Ed25519-signaturen over `captureSigningBytes(...)`. */
  signature: string;
}

const SAFE_FIELD = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Kanoniske bytes enheten signerer. Felter er newline-separert med domeneseparasjon og versjon; ingen felt kan inneholde linjeskift (validert). */
export function captureSigningBytes(fields: { request_id: string; tenant_id: string; person_id: string; device_id: string; sha256: string; byte_length: number; media_type: string; issued_at: string }): Uint8Array {
  for (const value of [fields.request_id, fields.tenant_id, fields.person_id, fields.device_id, fields.media_type, fields.issued_at]) {
    if (/[\r\n]/.test(value)) throw new VisionCaptureError("signing_field_invalid");
  }
  return new TextEncoder().encode([CAPTURE_SIGNING_DOMAIN, fields.request_id, fields.tenant_id, fields.person_id, fields.device_id, fields.sha256, String(fields.byte_length), fields.media_type, fields.issued_at].join("\n"));
}

export interface CaptureContext {
  tenant_id: string;
  memory_space: MemorySpace;
  person_id: string;
  task_id: string;
  session_id?: string | undefined;
}

export interface CaptureServiceOptions {
  now?: () => Date;
  maxUploadBytes?: number;
  signatureSkewMs?: number;
}

export class VisionCaptureService {
  private readonly now: () => Date;
  private readonly maxUploadBytes: number;
  private readonly skewMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly cameras: VisionCameraService,
    private readonly pipeline: VisionIngestPipeline,
    private readonly devices: CaptureDeviceRegistry,
    options: CaptureServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxUploadBytes = Math.min(options.maxUploadBytes ?? CAPTURE_MAX_UPLOAD_BYTES, CAPTURE_MAX_UPLOAD_BYTES);
    this.skewMs = options.signatureSkewMs ?? CAPTURE_SIGNATURE_SKEW_MS;
  }

  /** Eierens forespørsel om ETT opptak. Kameraet må være en registrert, påslått iPhone-kilde med en policy som faktisk behandler bilder (ikke `discard`). */
  async requestCapture(ctx: CaptureContext, input: { camera_id: string; idempotency_key?: string | undefined; ttl_ms?: number | undefined }): Promise<CaptureRequest> {
    const camera = await this.cameras.getCamera(ctx.tenant_id, ctx.memory_space, ctx.person_id, input.camera_id);
    if (camera === null) throw new VisionCaptureError("camera_not_found");
    if (camera.source_type !== "iphone") throw new VisionCaptureError("camera_not_iphone");
    if (!camera.enabled) throw new VisionCaptureError("camera_disabled");
    if (camera.route_policy === "discard") throw new VisionCaptureError("camera_policy_discard");
    if (input.idempotency_key !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key)) throw new VisionCaptureError("idempotency_key_invalid");
    const ttl = Math.min(Math.max(Math.floor(input.ttl_ms ?? CAPTURE_DEFAULT_TTL_MS), CAPTURE_MIN_TTL_MS), CAPTURE_MAX_TTL_MS);
    return withMemoryTransaction(this.pool, ctx.tenant_id, [ctx.memory_space], async (client) => {
      // Serialiser forespørsler per kamera (teller + innsetting): to samtidige forespørsler kan ikke begge slippe forbi taket.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`vision-capture:${ctx.tenant_id}:${camera.camera_id}`]);
      await client.query(
        `UPDATE vision_capture_requests SET state = 'expired', resolved_at = now() WHERE tenant_id = $1 AND camera_id = $2 AND state = 'pending' AND expires_at <= now()`,
        [ctx.tenant_id, camera.camera_id]
      );
      const pending = await client.query(`SELECT count(*)::int AS n FROM vision_capture_requests WHERE tenant_id = $1 AND camera_id = $2 AND state = 'pending'`, [ctx.tenant_id, camera.camera_id]);
      const inserted = await client.query(
        `INSERT INTO vision_capture_requests (request_id, tenant_id, memory_space_id, person_id, camera_id, device_id, idempotency_key, expires_at, task_id, session_id)
         SELECT $1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' milliseconds')::interval, $9, $10
          WHERE $11::int < $12::int
         ON CONFLICT (tenant_id, memory_space_id, person_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [`vis-cap-${randomUUID()}`, ctx.tenant_id, ctx.memory_space, ctx.person_id, camera.camera_id, camera.source_ref, input.idempotency_key ?? null, ttl, ctx.task_id, ctx.session_id ?? null, (pending.rows[0] as { n: number }).n, CAPTURE_MAX_PENDING_PER_CAMERA]
      );
      if (inserted.rows[0]) return inserted.rows[0] as CaptureRequest;
      if (input.idempotency_key !== undefined) {
        const existing = await client.query(`SELECT * FROM vision_capture_requests WHERE tenant_id = $1 AND memory_space_id = $2 AND person_id = $3 AND idempotency_key = $4`, [ctx.tenant_id, ctx.memory_space, ctx.person_id, input.idempotency_key]);
        if (existing.rows[0]) return existing.rows[0] as CaptureRequest;
      }
      throw new VisionCaptureError("too_many_pending");
    });
  }

  /** Åpne (ikke utløpte) forespørsler for en enhet - det appen poller. Ingenting annet enn id, kamera og utløp. */
  async listPending(tenantId: string, memorySpace: MemorySpace, personId: string, deviceId: string): Promise<CaptureRequest[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM vision_capture_requests WHERE tenant_id = $1 AND person_id = $2 AND device_id = $3 AND state = 'pending' AND expires_at > now() ORDER BY requested_at ASC`,
        [tenantId, personId, deviceId]
      );
      return rows as CaptureRequest[];
    });
  }

  async cancel(tenantId: string, memorySpace: MemorySpace, personId: string, requestId: string): Promise<boolean> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rowCount } = await client.query(
        `UPDATE vision_capture_requests SET state = 'cancelled', resolved_at = now() WHERE tenant_id = $1 AND person_id = $2 AND request_id = $3 AND state = 'pending'`,
        [tenantId, personId, requestId]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  /** Vedlikehold: merker utløpte forespørsler `expired` og sletter oppgjorte forespørsler eldre enn `olderThanDays` (kun metadata - ingen bilde). */
  async maintain(tenantId: string, memorySpace: MemorySpace, olderThanDays = 7): Promise<{ expired: number; deleted: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const expired = await client.query(`UPDATE vision_capture_requests SET state = 'expired', resolved_at = now() WHERE tenant_id = $1 AND memory_space_id = $2 AND state = 'pending' AND expires_at <= now()`, [tenantId, memorySpace]);
      const deleted = await client.query(
        `DELETE FROM vision_capture_requests WHERE tenant_id = $1 AND memory_space_id = $2 AND state <> 'pending' AND requested_at <= now() - ($3 || ' days')::interval`,
        [tenantId, memorySpace, Math.max(1, Math.floor(olderThanDays))]
      );
      return { expired: expired.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
    });
  }

  /**
   * Enhetens signerte opplasting. Kaster `VisionCaptureError` med en stabil kode ved enhver avvisning FØR noe forbrukes (unntatt feil i selve pipelinen etter forbruk, som gir
   * `rejected` med `pipeline_failed`). Se protokollen i filhodet.
   */
  async submitUpload(ctx: Omit<CaptureContext, "person_id">, upload: SignedCaptureUpload, bytes: Uint8Array): Promise<{ request: CaptureRequest; outcome: IngestOutcome }> {
    if (typeof upload !== "object" || upload === null) throw new VisionCaptureError("upload_malformed");
    if (!SAFE_FIELD.test(upload.request_id ?? "") || !SAFE_FIELD.test(upload.device_id ?? "") || !HEX64.test(upload.sha256 ?? "") || !MEDIA_TYPES.has(upload.media_type)) throw new VisionCaptureError("upload_malformed");
    if (!Number.isInteger(upload.byte_length) || upload.byte_length <= 0 || upload.byte_length > this.maxUploadBytes || bytes.length !== upload.byte_length) throw new VisionCaptureError("upload_size_mismatch");
    if (typeof upload.signature !== "string" || upload.signature.length === 0 || upload.signature.length > 200 || typeof upload.issued_at !== "string" || Number.isNaN(Date.parse(upload.issued_at))) throw new VisionCaptureError("upload_malformed");

    const request = await withMemoryTransaction(this.pool, ctx.tenant_id, [ctx.memory_space], async (client) => {
      const { rows } = await client.query(`SELECT * FROM vision_capture_requests WHERE tenant_id = $1 AND request_id = $2`, [ctx.tenant_id, upload.request_id]);
      return (rows[0] as CaptureRequest | undefined) ?? null;
    });
    if (request === null) throw new VisionCaptureError("request_not_found");
    if (request.device_id !== upload.device_id) throw new VisionCaptureError("device_mismatch");
    if (request.state !== "pending") throw new VisionCaptureError("request_not_pending");

    const device = await this.devices.approverFor(upload.device_id, ctx.tenant_id);
    if (!device || device.tenant_id !== ctx.tenant_id) throw new VisionCaptureError("unknown_device");
    if (device.person_id !== request.person_id) throw new VisionCaptureError("device_person_mismatch");

    let signatureOk = false;
    try {
      signatureOk = verify(
        null,
        captureSigningBytes({ request_id: request.request_id, tenant_id: ctx.tenant_id, person_id: request.person_id, device_id: request.device_id, sha256: upload.sha256, byte_length: upload.byte_length, media_type: upload.media_type, issued_at: upload.issued_at }),
        device.key,
        Buffer.from(upload.signature, "base64")
      );
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) throw new VisionCaptureError("invalid_signature");

    const nowMs = this.now().getTime();
    const issuedMs = Date.parse(upload.issued_at);
    if (Math.abs(nowMs - issuedMs) > this.skewMs) throw new VisionCaptureError("timestamp_skew");
    if (issuedMs < Date.parse(request.requested_at) - this.skewMs) throw new VisionCaptureError("issued_before_request");

    let inspected;
    try {
      inspected = inspectImage(bytes, { maxBytes: this.maxUploadBytes, declaredType: upload.media_type });
    } catch (err) {
      throw new VisionCaptureError(err instanceof VisionImageError ? `image_${err.code}` : "image_invalid");
    }
    if (inspected.sha256 !== upload.sha256 || inspected.byte_length !== upload.byte_length) throw new VisionCaptureError("hash_mismatch");

    const camera = await this.cameras.getCamera(ctx.tenant_id, ctx.memory_space, request.person_id, request.camera_id);
    if (camera === null || camera.source_type !== "iphone" || camera.source_ref !== upload.device_id) throw new VisionCaptureError("camera_mismatch");

    // ENGANGS: betinget forbruk. Kun én samtidig opplasting kan vinne; en reprodusert opplasting finner forespørselen forbrukt.
    const claimed = await withMemoryTransaction(this.pool, ctx.tenant_id, [ctx.memory_space], async (client) => {
      const { rows } = await client.query(
        `UPDATE vision_capture_requests SET state = 'fulfilled', resolved_at = now(), upload_sha256 = $3
          WHERE tenant_id = $1 AND request_id = $2 AND state = 'pending' AND expires_at > now() RETURNING *`,
        [ctx.tenant_id, request.request_id, upload.sha256]
      );
      return (rows[0] as CaptureRequest | undefined) ?? null;
    });
    if (claimed === null) throw new VisionCaptureError("request_not_pending");

    const outcome = await this.pipeline.processCaptured(
      { tenant_id: ctx.tenant_id, memory_space: ctx.memory_space, person_id: request.person_id, task_id: `vision-capture:${request.request_id}`, ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}) },
      camera,
      { source_type: "iphone", source_event_id: request.request_id, base_event_type: null, observed_at: new Date(Math.min(issuedMs, nowMs)).toISOString(), age_ms: 0, skipCooldown: true, getImage: async () => ({ bytes, declared_type: upload.media_type }) }
    );
    const final = await withMemoryTransaction(this.pool, ctx.tenant_id, [ctx.memory_space], async (client) => {
      const failed = outcome.status === "failed";
      const { rows } = await client.query(
        `UPDATE vision_capture_requests SET snapshot_id = $3, state = CASE WHEN $4 THEN 'rejected' ELSE state END, reject_reason = CASE WHEN $4 THEN 'pipeline_failed' ELSE reject_reason END
          WHERE tenant_id = $1 AND request_id = $2 RETURNING *`,
        [ctx.tenant_id, request.request_id, outcome.snapshot_id ?? null, failed]
      );
      return rows[0] as CaptureRequest;
    });
    return { request: final, outcome };
  }
}
