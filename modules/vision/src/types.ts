import { z } from "zod";

/**
 * UA-9 Vision & Physical World: provider-nøytral, JARVIS_CANONICAL
 * hendelses-/romobservasjons-kontrakt (D-64, D-153 - Jarvis eier modellen,
 * en leverandør er ALDRI stedet den bor). Dette er et INGESTION-/lese-
 * kontraktlag, IKKE en live iPhone-/Home Assistant-kamera-integrasjon - se
 * `service.ts` for den fulle arkitektur-begrunnelsen. INGEN kode i denne
 * pakken later som den snakker med en ekte kamera-/objektgjenkjennings-
 * kjøretid (verken her eller i `FakeVisionEventSource` - se JSDoc der).
 *
 * Biometrisk ansiktsgjenkjenning er EKSPLISITT UTENFOR dette settet
 * (masterplan v4.0 UA-9: forblir utenfor med mindre separat besluttet og
 * lovlig implementert) - INGEN felt her representerer en biometrisk
 * identitet.
 *
 * BEVISST SMALT, LUKKET MVP-sett (v1) - fem hendelsestyper som dekker
 * masterplanens egne eksempler ("object/event embeddings ... inventory
 * recognition", "doorbell/security events"); settet utvides NÅR en faktisk
 * kilde/brukstilfelle krever det (samme mønster som `MetricTypeSchema` i
 * `@jarvis/health`).
 */
export const VisionEventTypeSchema = z.enum([
  "object_detected",
  "person_present",
  "motion_detected",
  "doorbell_event",
  "security_alert"
]);
export type VisionEventType = z.infer<typeof VisionEventTypeSchema>;

// ---------------------------------------------------------------------
// Retention (eier-konfigurert, Jarvis håndhever - se 055_vision.sql)
// ---------------------------------------------------------------------

export interface VisionRetentionPolicy {
  tenant_id: string;
  memory_space_id: string;
  retention_days: number;
  actor_person_id: string | null;
  updated_at: string;
}

export const SetVisionRetentionPolicyInputSchema = z.object({
  retention_days: z.number().int().positive(),
  actor_person_id: z.string().min(1).optional()
});
export type SetVisionRetentionPolicyInput = z.infer<typeof SetVisionRetentionPolicyInputSchema>;

// ---------------------------------------------------------------------
// Rooms (romassosiasjon - strukturelt parallell til location_zones, UTEN
// geofence-geometri: romgjenkjenning selv skjer i en fremtidig adapter)
// ---------------------------------------------------------------------

export interface VisionRoom {
  room_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  name: string;
  created_at: string;
}

export const CreateVisionRoomInputSchema = z.object({
  person_id: z.string().min(1),
  name: z.string().min(1)
});
export type CreateVisionRoomInput = z.infer<typeof CreateVisionRoomInputSchema>;

// ---------------------------------------------------------------------
// Event observations (rå, leverandør-nøytrale, allerede klassifiserte
// hendelser - ALDRI rå bilde-/videobytes, se 055_vision.sql sitt filhode)
// ---------------------------------------------------------------------

/**
 * Rå input for ÉN hendelse - formen en `VisionEventSource`-adapter
 * (fremtidig iPhone-kamera/Home Assistant, eller `FakeVisionEventSource` i
 * tester) produserer, OG formen `VisionService.ingestObservation()` tar
 * imot direkte. `source_type`/`source_instance_id` er en POINTER til hvilken
 * adapter/enhet hendelsen kom fra.
 *
 * `source_event_id` (ARKITEKT-REVIEW-FIKS, PR #83, P1) - PÅKREVD, kilde-
 * produsert STABIL identitet for denne ENE hendelsen (adapterens egen
 * unike ID/sekvensnøkkel), ALDRI generert av Jarvis selv. Dette er
 * dedupe-grunnlaget `055_vision.sql` sin
 * `vision_event_observations_source_dedupe_key` håndhever strukturelt -
 * uten en kilde-stabil identitet kan et overlappende poll-vindu, en
 * transport-retry, eller en krasjet delvis batch som prøves på nytt IKKE
 * skilles fra en genuint NY hendelse, og ville tidligere skrevet en stille
 * duplikat-rad (se `service.ts`).
 *
 * `snapshot_ref` (ARKITEKT-REVIEW-FIKS, PR #83, P1) - FORBUDT i denne
 * P0-sliceen (se `055_vision.sql` sin `CHECK`-kommentar for begrunnelsen:
 * ingen levetids-eid snapshot-lagringsadapter finnes ennå som faktisk
 * sletter det RETTE eksterne objektet når en observasjon purges/eraseres).
 * Feltet finnes bevisst IKKE i dette schemaet - en fremtidig slice som
 * bygger en ekte snapshot-lagring legger det til igjen SAMMEN MED
 * transaksjonell/kompenserende sletting av det refererte objektet.
 */
export const VisionObservationInputSchema = z
  .object({
    event_type: VisionEventTypeSchema,
    room_id: z.string().min(1).optional(),
    object_label: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    source_event_id: z.string().min(1),
    /** ISO 8601-tidsstempel for NÅR hendelsen faktisk skjedde (kan avvike fra `recorded_at`, som er når Jarvis mottok den). */
    observed_at: z.string().min(1),
    source_type: z.string().min(1),
    source_instance_id: z.string().min(1).optional()
  })
  .strict();
export type VisionObservationInput = z.infer<typeof VisionObservationInputSchema>;

/** Én permanent rad i `vision_event_observations` (append-only, se `055_vision.sql`). */
export interface VisionEventObservation {
  observation_id: string;
  tenant_id: string;
  memory_space_id: string;
  person_id: string;
  room_id: string | null;
  event_type: VisionEventType;
  object_label: string | null;
  confidence: number | null;
  snapshot_ref: null;
  source_type: string;
  source_instance_id: string | null;
  source_event_id: string;
  observed_at: string;
  recorded_at: string;
  retention_expires_at: string | null;
}

/**
 * Provider-nøytral adapterkontrakt (§ byggeordren: "en fremtidig iPhone-
 * kamera-/Home Assistant-adapter skal kunne skrives mot en STABIL kontrakt
 * uten å røre denne tjenestens internfunksjoner"). D-64: Jarvis eier denne
 * kontrakten - en fremtidig `HomeAssistantCameraEventSource`/
 * `IPhoneCameraEventSource` (IKKE bygget her - krever fysisk kamera-
 * maskinvare + en faktisk objektklassifiseringsmodell koblet til, som IKKE
 * finnes i dette miljøet) implementerer DENNE, uendrede, grensen.
 * `fetchRecent()` returnerer rå, IKKE-validerte, men ALLEREDE klassifiserte
 * `VisionObservationInput`-objekter (selve bildeinferensen skjer i
 * adapteren/en oppstrøms modell-pipeline, ALDRI her) -
 * `VisionService.ingestObservation()`/`ingestFromSource()` validerer og
 * skriver dem, ALDRI adapteren selv (samme "kilde produserer data,
 * tjenesten avgjør gyldighet"-grense som `HealthMetricSource`).
 */
export interface VisionEventSourceFetchOptions {
  personId: string;
  /** Kun hendelser med `observed_at` >= dette (ms siden epoch) - `undefined` betyr "ingen nedre grense" (adapteren avgjør selv et rimelig standardvindu). */
  sinceMs?: number;
}

export interface VisionEventSource {
  readonly name: string;
  fetchRecent(options: VisionEventSourceFetchOptions): Promise<VisionObservationInput[]>;
}
