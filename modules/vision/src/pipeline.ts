import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import type { VisionCamera } from "./cameras.ts";
import type { VisionClassifier, VisionDetection } from "./classifier.ts";
import type { VisionEmbeddingService } from "./embeddings.ts";
import { DEFAULT_MAX_IMAGE_BYTES, inspectImage, type InspectedImage } from "./image.ts";
import type { SightingInput, VisionInventoryService } from "./inventory.ts";
import { isInventoryLabel } from "./labels.ts";
import { routeVisionEvent, type VisionRouteReason } from "./policy.ts";
import { SnapshotInProgressError, type VisionSnapshotRow, type VisionSnapshotService } from "./snapshots.ts";
import type { CapturedImage, VisionSource, VisionSourceCamera } from "./source.ts";
import type { VisionService } from "./service.ts";
import type { VisionClassificationStatus, VisionEventType, VisionObservationInput } from "./types.ts";

/**
 * WP-G3 (D-465): `VisionIngestPipeline` - orkestreringen kilde -> datapolicy -> (bilde) -> lokal klassifisering -> hendelser + valgfritt bilde + vektorer + inventar.
 *
 * Rekkefølgen er bevisst og hver beslutning er deterministisk (ingen LLM velger hva som skjer med et bilde):
 *   1. DATAPOLICY (policy.ts) avgjør FØR noe hentes: forkast / bare hendelsen / klassifiser / klassifiser + lagre. Bildet forlater aldri maskinen (egress: «none»).
 *   2. IDEMPOTENS FØR KOSTNAD: en kilde-hendelse som allerede er skrevet (kilde + eksternt hendelses-id) gir `duplicate` uten at bildet hentes eller modellen kalles. Samtidige
 *      likelydende hendelser i prosessen serialiseres, og databasens unike nøkkel (055) avgjør den siste kappløpet.
 *   3. FLOMVERN: minste tid mellom to behandlede hendelser av samme type fra samme kamera (`cooldown_seconds`).
 *   4. BILDET: ETT øyeblikksbilde, hentet bare hvis policyen ber om det OG hendelsen er fersk nok til at et bilde «nå» betyr noe (`maxSnapshotAgeMs`). Validert av `inspectImage`
 *      (magic bytes/størrelse) - en kilde som sender noe annet enn jpeg/png/webp gir en hendelse uten bilde, aldri en feil som stopper pollingen.
 *   5. KLASSIFISERING (classifier.ts): kun lokal modell, ubetrodd utdata, lukket event_type-delsett. Modellen utilgjengelig eller svaret avvist: hendelsen skrives likevel (type fra
 *      utløseren, ingen objekter) med `classification_status`.
 *   6. LAGRING (kun `store_snapshot` i hjemmesonen): pending-rad -> bytes -> committet SAMMEN med hendelsene (snapshots.ts). Feiler skrivingen, skrives hendelsene uten bilde.
 *   7. ATOMISK SKRIVING: hendelsen, objekthendelsene, bildepekeren, vektorene og inventaret committes i ÉN transaksjon (alt eller ingenting). Embedding beregnes FØR transaksjonen (en tregere
 *      modellserver holder aldri en databasetransaksjon åpen) og er ikke fatal hvis den feiler (`backfillMissing` fyller etter). Unntak fra «alt eller ingenting» (review delta D1): en etikett
 *      som ikke kan bli INVENTAR hoppes over for den raden (note `inventory_label_invalid`/`inventory_label_rejected`, se `recordInventory`) - inventaret er avledet, hendelsen er sannheten.
 *   8. MERKING (regel 4): alle rader bærer person/tenant/space, kilde og `task_id` (+ `session_id`); proveniens for klassifiseringen (`classifier`) og status lagres.
 * Per-hendelse-feil kaster aldri ut av pipelinen (en sensor som feiler skal ikke stoppe de andre): de gir `status: "failed"` med en stabil feilkode - aldri innhold.
 */
export interface IngestContext {
  tenant_id: string;
  memory_space: MemorySpace;
  person_id: string;
  task_id: string;
  session_id?: string | undefined;
}

export type IngestStatus = "recorded" | "duplicate" | "discarded" | "cooldown" | "failed";

export interface IngestOutcome {
  status: IngestStatus;
  reason: VisionRouteReason | "duplicate" | "cooldown" | "camera_scope_mismatch" | "pipeline_error";
  observation_ids: string[];
  snapshot_id?: string;
  classification_status: VisionClassificationStatus;
  detection_count: number;
  /** Stabile koder for ikke-fatale avvik (ingen bilde, modell utilgjengelig, embedding feilet ...) og for `failed`. */
  notes: string[];
}

export interface CapturedEventSpec {
  source_type: string;
  /** Kildens STABILE hendelses-id. Objekthendelser utledes som `<id>#obj:<navn>` / `<id>#person`. */
  source_event_id: string;
  /** Hendelsestypen fra utløseren; `null` = ingen utløserhendelse (opptak på forespørsel: kun det modellen ser skrives). */
  base_event_type: VisionEventType | null;
  observed_at: string;
  /** Alder på utløseren (ms). `0` for et opptak som ble tatt nå. */
  age_ms: number;
  /** Henter bildet LAT (kalles kun hvis policyen ber om det). */
  getImage: () => Promise<CapturedImage>;
  /** Hopp over flomvernet (opptak på forespørsel er eierens eksplisitte handling). */
  skipCooldown?: boolean;
}

export interface VisionPipelineOptions {
  pool: pg.Pool;
  vision: VisionService;
  /** Lokal visjonsmodell. Uten den klassifiseres ingenting (hendelser skrives uten objekter, og bilder hentes ikke med mindre de skal lagres). */
  classifier?: VisionClassifier | undefined;
  snapshots?: VisionSnapshotService | undefined;
  embeddings?: VisionEmbeddingService | undefined;
  inventory?: VisionInventoryService | undefined;
  /** `JARVIS_VISION_ENABLED` - hovedbryter. */
  enabled: boolean;
  /** `JARVIS_VISION_STORE_SNAPSHOTS` - lagring av bilder (krever også `snapshots`). */
  storeSnapshots: boolean;
  now?: () => Date;
  /** Eldre utløsere får ikke bilde (et bilde «nå» sier ikke noe om hendelsen). Standard 60 s. */
  maxSnapshotAgeMs?: number;
  maxImageBytes?: number;
}

export interface PollSummary {
  events_seen: number;
  recorded: number;
  duplicates: number;
  discarded: number;
  cooldown: number;
  failed: number;
  /** Kilden feilet som helhet (f.eks. HA nede): én kort kode, ingen innhold. */
  source_error?: string;
}

class DuplicateRaceError extends Error {
  constructor() {
    super("vision_duplicate_race");
  }
}

const MAX_OBJECTS_PER_EVENT = 8;
const INVENTORY_SAVEPOINT = "vision_inventory";
const INVENTORY_LABEL_CHECK = "vision_inventory_items_object_label_check";

/** Stabil kode, ingen duplikater (to objekter i samme hendelse kan gi samme avvik). */
function addNote(notes: string[], code: string): void {
  if (!notes.includes(code)) notes.push(code);
}

/** Kun etikett-CHECK-en i inventartabellen (SQLSTATE 23514 + constraintnavn) - ikke en annen CHECK, og aldri FK/RLS/tilkoblingsfeil. */
function isInventoryLabelViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e !== null && typeof e === "object" && e.code === "23514" && e.constraint === INVENTORY_LABEL_CHECK;
}

function errorCode(err: unknown): string {
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (typeof pgCode === "string" && /^[0-9A-Z]{5}$/.test(pgCode)) return `db_${pgCode.toLowerCase()}`;
  const message = (err as Error | null)?.message;
  if (typeof message === "string") {
    const m = /^([a-z0-9_]{3,60})(?::|$)/.exec(message);
    if (m) return m[1] as string;
  }
  const name = (err as Error | null)?.name;
  return typeof name === "string" && name !== "Error" && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name.toLowerCase() : "pipeline_error";
}

export class VisionIngestPipeline {
  private readonly now: () => Date;
  private readonly maxSnapshotAgeMs: number;
  private readonly maxImageBytes: number;
  private readonly lastProcessed = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: VisionPipelineOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 60_000;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  private outcome(partial: Partial<IngestOutcome> & Pick<IngestOutcome, "status" | "reason">): IngestOutcome {
    return { observation_ids: [], classification_status: "not_applicable", detection_count: 0, notes: [], ...partial };
  }

  /** Hele flyten for ÉN kilde-hendelse. Kaster aldri (se filhodet). */
  async processCaptured(ctx: IngestContext, camera: VisionCamera, spec: CapturedEventSpec): Promise<IngestOutcome> {
    if (camera.tenant_id !== ctx.tenant_id || camera.memory_space_id !== ctx.memory_space || camera.person_id !== ctx.person_id) {
      return this.outcome({ status: "failed", reason: "camera_scope_mismatch", notes: ["camera_scope_mismatch"] });
    }
    const decision = routeVisionEvent({
      source_kind: "event_snapshot",
      zone_kind: camera.zone_kind,
      route_policy: camera.route_policy,
      camera_enabled: camera.enabled,
      event_type: spec.base_event_type ?? "object_detected",
      global: {
        enabled: this.options.enabled,
        classification_enabled: this.options.classifier !== undefined,
        snapshot_storage_enabled: this.options.storeSnapshots && this.options.snapshots !== undefined
      }
    });
    if (!decision.record_event) return this.outcome({ status: "discarded", reason: decision.reason });

    const lockKey = `${ctx.tenant_id}|${ctx.memory_space}|${ctx.person_id}|${spec.source_type}|${camera.camera_id}|${spec.source_event_id}`;
    if (this.inFlight.has(lockKey)) return this.outcome({ status: "duplicate", reason: "duplicate" });
    this.inFlight.add(lockKey);
    try {
      if (spec.base_event_type !== null) {
        const existing = await this.options.vision.findBySourceEvent(ctx.tenant_id, ctx.memory_space, ctx.person_id, {
          source_type: spec.source_type, source_instance_id: camera.camera_id, source_event_id: spec.source_event_id
        });
        if (existing !== null) return this.outcome({ status: "duplicate", reason: "duplicate", observation_ids: [existing.observation_id] });
      }
      const cooldownKey = `${camera.camera_id}|${spec.base_event_type ?? "capture"}`;
      const nowMs = this.now().getTime();
      if (spec.skipCooldown !== true) {
        const last = this.lastProcessed.get(cooldownKey);
        if (last !== undefined && nowMs - last < camera.cooldown_seconds * 1000) return this.outcome({ status: "cooldown", reason: "cooldown" });
      }
      this.lastProcessed.set(cooldownKey, nowMs);
      return await this.run(ctx, camera, spec, decision);
    } catch (err) {
      if (err instanceof DuplicateRaceError) return this.outcome({ status: "duplicate", reason: "duplicate" });
      const code = errorCode(err);
      console.error(JSON.stringify({ msg: "vision_pipeline_failed", camera_id: camera.camera_id, code }));
      return this.outcome({ status: "failed", reason: "pipeline_error", notes: [code] });
    } finally {
      this.inFlight.delete(lockKey);
    }
  }

  private async run(ctx: IngestContext, camera: VisionCamera, spec: CapturedEventSpec, decision: ReturnType<typeof routeVisionEvent>): Promise<IngestOutcome> {
    const notes: string[] = [];
    let image: (InspectedImage & { bytes: Uint8Array }) | null = null;
    if (decision.fetch_image) {
      if (spec.age_ms > this.maxSnapshotAgeMs) {
        notes.push("stale_event_no_snapshot");
      } else {
        try {
          const captured = await spec.getImage();
          const inspected = inspectImage(captured.bytes, { maxBytes: this.maxImageBytes, declaredType: captured.declared_type });
          image = { ...inspected, bytes: captured.bytes };
        } catch (err) {
          notes.push(`image_${errorCode(err)}`);
        }
      }
    }

    let classification_status: VisionClassificationStatus = "not_applicable";
    let classifier: string | null = null;
    let detections: VisionDetection[] = [];
    if (image !== null && decision.classify && this.options.classifier !== undefined) {
      const result = await this.options.classifier.classify({
        tenant_id: ctx.tenant_id,
        task_id: ctx.task_id,
        ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
        image: { bytes: image.bytes, media_type: image.media_type },
        trigger: spec.base_event_type ?? "object_detected",
        room_name: camera.room_id === null ? null : await this.roomName(ctx, camera.room_id)
      });
      if (result.status === "classified") {
        classification_status = "classified";
        classifier = result.classifier;
        detections = result.detections.slice(0, MAX_OBJECTS_PER_EVENT);
        if (result.dropped > 0) notes.push(`model_dropped_${Math.min(result.dropped, 99)}`);
      } else if (result.status === "model_unavailable") {
        classification_status = "model_unavailable";
        notes.push(`model_unavailable:${result.reason}`);
      } else {
        classification_status = "model_rejected";
        classifier = result.classifier ?? null;
        notes.push(`model_rejected:${result.reason}`);
      }
    }

    // Bilde-lagring (kun når policyen sier det). Feil gir en hendelse uten bilde - aldri tap av hendelsen.
    let snapshot: VisionSnapshotRow | null = null;
    let snapshotNeedsMark = false;
    if (image !== null && decision.store_image && this.options.snapshots !== undefined) {
      try {
        const begun = await this.options.snapshots.begin(ctx.tenant_id, ctx.memory_space, ctx.person_id, {
          camera_id: camera.camera_id, source_type: spec.source_type, source_instance_id: camera.camera_id, source_event_id: spec.source_event_id,
          media_type: image.media_type, byte_length: image.byte_length, sha256: image.sha256, task_id: ctx.task_id, session_id: ctx.session_id
        });
        snapshot = begun.row;
        if (!begun.existing) {
          await this.options.snapshots.writeBytes(begun.row, image.bytes);
          snapshotNeedsMark = true;
        }
      } catch (err) {
        snapshot = null;
        notes.push(err instanceof SnapshotInProgressError ? "snapshot_in_progress" : `snapshot_${errorCode(err)}`);
      }
    }
    // Bildebytes trengs ikke lenger: slipp referansen før databasearbeidet (ingenting i resten av flyten leser dem).
    image = null;

    // Embeddings FØR transaksjonen (modellserveren kan være treg og skal ikke holde en transaksjon åpen).
    const objectDetections = detections.filter((d) => d.event_type === "object_detected" && d.object_label !== null);
    const vectors = new Map<string, number[]>();
    if (this.options.embeddings !== undefined && objectDetections.length > 0) {
      for (const detection of objectDetections) {
        try {
          vectors.set(
            detection.object_label as string,
            await this.options.embeddings.embed(this.options.embeddings.descriptorFor({ event_type: "object_detected", object_label: detection.object_label }))
          );
        } catch {
          notes.push("embedding_failed");
        }
      }
    }

    const written: string[] = [];
    try {
      await withMemoryTransaction(this.options.pool, ctx.tenant_id, [ctx.memory_space], async (client) => {
        if (snapshot !== null && snapshotNeedsMark) {
          await this.options.snapshots?.markStoredInTransaction(client, ctx.tenant_id, ctx.memory_space, ctx.person_id, snapshot.snapshot_id);
        }
        const extras = {
          snapshot_ref: snapshot?.snapshot_id ?? null, task_id: ctx.task_id, session_id: ctx.session_id ?? null, classification_status, classifier
        };
        const common = {
          source_type: spec.source_type, source_instance_id: camera.camera_id, observed_at: spec.observed_at, ...(camera.room_id !== null ? { room_id: camera.room_id } : {})
        };
        if (spec.base_event_type !== null) {
          const base: VisionObservationInput = { ...common, event_type: spec.base_event_type, source_event_id: spec.source_event_id };
          const result = await this.options.vision.ingestWithinTransaction(client, ctx.tenant_id, ctx.memory_space, ctx.person_id, base, extras);
          // Et kappløp mot en annen skriver (samme nøkkel): ruller hele transaksjonen tilbake og melder `duplicate`.
          if (!result.inserted) throw new DuplicateRaceError();
          written.push(result.observation.observation_id);
        }
        const retentionDays = await this.options.vision.retentionDaysInTransaction(client, ctx.tenant_id, ctx.memory_space);
        for (const detection of detections) {
          const label = detection.object_label;
          const input: VisionObservationInput = {
            ...common,
            event_type: detection.event_type,
            confidence: detection.confidence,
            ...(label !== null ? { object_label: label } : {}),
            source_event_id: `${spec.source_event_id}${detection.event_type === "person_present" ? "#person" : `#obj:${label}`}`
          };
          const result = await this.options.vision.ingestWithinTransaction(client, ctx.tenant_id, ctx.memory_space, ctx.person_id, input, extras);
          if (!result.inserted) continue;
          written.push(result.observation.observation_id);
          if (label === null) continue;
          const vector = vectors.get(label);
          if (vector !== undefined && this.options.embeddings !== undefined) {
            await this.options.embeddings.storeInTransaction(client, { observationId: result.observation.observation_id, tenantId: ctx.tenant_id, memorySpace: ctx.memory_space }, vector);
          }
          if (camera.room_id !== null && this.options.inventory !== undefined) {
            await this.recordInventory(client, notes, this.options.inventory, {
              tenantId: ctx.tenant_id, memorySpace: ctx.memory_space, personId: ctx.person_id, roomId: camera.room_id, objectLabel: label, confidence: detection.confidence,
              observedAt: spec.observed_at, observationId: result.observation.observation_id, sourceType: spec.source_type, sourceInstanceId: camera.camera_id,
              taskId: ctx.task_id, sessionId: ctx.session_id, retentionDays
            });
          }
        }
      });
    } catch (err) {
      // Transaksjonen rullet tilbake: et pending-bilde uten hendelser skal ikke bli stående (kompenserende sletting; gravstein via trigger).
      if (snapshot !== null && snapshotNeedsMark) {
        await this.options.snapshots?.abandon(ctx.tenant_id, ctx.memory_space, ctx.person_id, snapshot.snapshot_id).catch(() => undefined);
      }
      throw err;
    }
    return this.outcome({
      status: "recorded",
      reason: decision.reason,
      observation_ids: written,
      ...(snapshot !== null && snapshotNeedsMark ? { snapshot_id: snapshot.snapshot_id } : {}),
      classification_status,
      detection_count: detections.length,
      notes
    });
  }

  /**
   * Inventar for ÉN observasjon - aldri på bekostning av hendelsen (review delta D1). Inventaret er en AVLEDET tilstand, hendelsene er sannheten; at en etikett ikke kan bli inventar skal derfor
   * aldri rulle tilbake basishendelsen (HA ville ellers forsøkt den samme hendelsen på hver poll til den ble for gammel for bilde, og et iPhone-opptak ble avvist). To lag:
   *   1. FORHÅNDSSJEKK (`isInventoryLabel`, speiler CHECK-en i 135): en etikett uten inventarform hoppes over uten å røre databasen (note `inventory_label_invalid`).
   *   2. SAVEPOINT rundt selve skrivingen: avviser databasen etiketten likevel (CHECK-en er strammet inn i en senere migrasjon, eller JS-regelen har drevet fra SQL), rulles KUN inventarskrivingen
   *      tilbake (note `inventory_label_rejected`), og hendelsene, vektoren og bildepekeren i samme transaksjon består. Enhver ANNEN feil (FK, RLS, tilkobling ...) kastes videre og ruller hele
   *      hendelsen tilbake som før - savepointet er ikke et «svelg alt».
   */
  private async recordInventory(client: pg.PoolClient, notes: string[], inventory: VisionInventoryService, input: SightingInput): Promise<void> {
    if (!isInventoryLabel(input.objectLabel)) {
      addNote(notes, "inventory_label_invalid");
      return;
    }
    await client.query(`SAVEPOINT ${INVENTORY_SAVEPOINT}`);
    try {
      await inventory.recordSightingInTransaction(client, input);
    } catch (err) {
      if (!isInventoryLabelViolation(err)) throw err;
      await client.query(`ROLLBACK TO SAVEPOINT ${INVENTORY_SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${INVENTORY_SAVEPOINT}`);
      addNote(notes, "inventory_label_rejected");
      return;
    }
    await client.query(`RELEASE SAVEPOINT ${INVENTORY_SAVEPOINT}`);
  }

  private async roomName(ctx: IngestContext, roomId: string): Promise<string | null> {
    try {
      const rooms = await this.options.vision.listRooms(ctx.tenant_id, ctx.memory_space, ctx.person_id);
      return rooms.find((room) => room.room_id === roomId)?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Én poll-runde for en kilde og de gitte (påslåtte) kameraene. Eldste hendelse først. Aldri et kast: kildefeil blir `source_error`. */
  async pollSource(ctx: IngestContext, source: VisionSource, cameras: readonly VisionCamera[]): Promise<PollSummary> {
    const summary: PollSummary = { events_seen: 0, recorded: 0, duplicates: 0, discarded: 0, cooldown: 0, failed: 0 };
    if (!this.options.enabled) return summary;
    const sourceCameras: VisionSourceCamera[] = cameras
      .filter((camera) => camera.enabled && camera.source_type === source.source_type)
      .map((camera) => ({ camera_id: camera.camera_id, source_ref: camera.source_ref, trigger_entities: camera.trigger_entities }));
    if (sourceCameras.length === 0) return summary;
    let events: Awaited<ReturnType<VisionSource["pollEvents"]>>;
    try {
      events = await source.pollEvents(sourceCameras, this.now());
    } catch (err) {
      summary.source_error = errorCode(err);
      console.error(JSON.stringify({ msg: "vision_source_poll_failed", source: source.source_type, code: summary.source_error }));
      return summary;
    }
    events.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    for (const event of events) {
      summary.events_seen += 1;
      const camera = cameras.find((c) => c.camera_id === event.source_instance_id);
      const sourceCamera = sourceCameras.find((c) => c.camera_id === event.source_instance_id);
      if (camera === undefined || sourceCamera === undefined) continue;
      const outcome = await this.processCaptured(ctx, camera, {
        source_type: event.source_type, source_event_id: event.source_event_id, base_event_type: event.event_type, observed_at: event.observed_at, age_ms: event.age_ms,
        getImage: () => source.fetchSnapshot(sourceCamera, this.maxImageBytes)
      });
      if (outcome.status === "recorded") summary.recorded += 1;
      else if (outcome.status === "duplicate") summary.duplicates += 1;
      else if (outcome.status === "discarded") summary.discarded += 1;
      else if (outcome.status === "cooldown") summary.cooldown += 1;
      else summary.failed += 1;
    }
    return summary;
  }
}
