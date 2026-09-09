import { z } from "zod";
import { MemorySpaceSchema } from "@jarvis/contracts";

/**
 * UA-8 Personal Digital Twin - Personal Context Engine v1 (se
 * `049_context_engine.sql` for det fulle designresonnementet).
 *
 * Fire kontekst-dimensjoner - IKKE en femte "timestamp/timezone"-dimensjon:
 * tidspunkt er ALLTID kjent via `observed_at`/systemklokken og trenger derfor
 * ingen egen lagret rad. `place` sin form holdes BEVISST generisk
 * (`.catchall`) - dette modulen eier KUN lagringsformen for sted, ALDRI
 * stedslogikk; en fremtidig `modules/location/` skal kunne skrive gjennom
 * SAMME `recordObservation()`-API uten en skjemaendring her.
 */
export const ContextDimensionSchema = z.enum(["place", "device", "meeting", "activity"]);
export type ContextDimension = z.infer<typeof ContextDimensionSchema>;

/**
 * D-41-prinsippet anvendt internt: en 'deterministic'-observasjon (fra en
 * enhet-heartbeat, en sesjons-gjenopptakelse, en kalender-synk) skal ALDRI
 * stille overskrives av en 'inferred' (gjettet/avledet) observasjon for
 * SAMME dimensjon - se `ContextEngine.recordObservation()` sin
 * presedens-regel i `service.ts`.
 */
export const ContextBasisSchema = z.enum(["deterministic", "inferred"]);
export type ContextBasis = z.infer<typeof ContextBasisSchema>;

/**
 * Sted - generisk, forward-kompatibel form. Denne pakken definerer KUN
 * hvordan en stedsobservasjon SER UT når den lagres - selve
 * stedsbestemmelsen (GPS/wifi/manuell) eies av et FREMTIDIG `modules/location/`
 * (bygges ikke her, se byggeordrens avgrensning).
 */
export const PlaceContextValueSchema = z
  .object({
    label: z.string().min(1).optional(),
    place_id: z.string().min(1).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    timezone: z.string().min(1).optional()
  })
  .catchall(z.unknown());
export type PlaceContextValue = z.infer<typeof PlaceContextValueSchema>;

/**
 * Aktiv enhet/kanal - avledet LIVE fra den EKSISTERENDE `sessions`-tabellen
 * (`SessionService`, `@jarvis/core`) via `recordDeviceObservationFromSession()`,
 * ALDRI en duplisert enhets-tilstandsmotor.
 */
export const DeviceContextValueSchema = z
  .object({
    device_id: z.string().min(1),
    channel: z.string().min(1),
    session_id: z.string().min(1).optional()
  })
  .strict();
export type DeviceContextValue = z.infer<typeof DeviceContextValueSchema>;

/**
 * Møte-/kalenderkontekst - avledet LIVE fra `business_activities`
 * (`activity_type = 'meeting'`, skrevet av
 * `modules/business/src/business-event-sync.ts` sin Calendar-synk).
 *
 * ÆRLIG GAP (se byggeordrens rapportpunkt 3): `business_activities` lagrer
 * KUN `occurred_at` (møtestart) - INGEN sluttidspunkt/varighet. "Pågår møtet
 * akkurat nå?" kan derfor IKKE besvares med sikkerhet - kun tilnærmes med en
 * antatt varighet. `end_time_known` er ALLTID `false` i v1 og eksponeres
 * eksplisitt til kalleren (regel: aldri stille behandle en gjetning som et
 * faktum) - status skiller derfor BEVISST 'starting_soon' (vi VET
 * starttidspunktet er i nær fremtid) fra 'recently_started_duration_unknown'
 * (møtet har startet, men vi vet IKKE om det fortsatt pågår).
 */
export const MeetingContextStatusSchema = z.enum(["none", "starting_soon", "recently_started_duration_unknown"]);
export type MeetingContextStatus = z.infer<typeof MeetingContextStatusSchema>;

export const MeetingContextValueSchema = z
  .object({
    status: MeetingContextStatusSchema,
    /** Peker til `business_activities.activity_id` - ALDRI en kopi av møtetittel/beskrivelse. */
    activity_id: z.string().min(1).optional(),
    starts_at: z.string().min(1).optional(),
    end_time_known: z.boolean()
  })
  .strict();
export type MeetingContextValue = z.infer<typeof MeetingContextValueSchema>;

/**
 * Aktivitetsstate - BEVISST generisk (ingen deterministisk avledningskilde
 * finnes for denne dimensjonen i denne sliceen, se byggeordrens rapportpunkt
 * 6) - tilgjengelig via `recordObservation()` for en FREMTIDIG kilde
 * (enhet-sensor, kalender-avledet "i møte", eksplisitt eier-satt state).
 */
export const ActivityContextValueSchema = z
  .object({
    state: z.string().min(1),
    detail: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type ActivityContextValue = z.infer<typeof ActivityContextValueSchema>;

export const CONTEXT_VALUE_SCHEMAS: Record<ContextDimension, z.ZodTypeAny> = {
  place: PlaceContextValueSchema,
  device: DeviceContextValueSchema,
  meeting: MeetingContextValueSchema,
  activity: ActivityContextValueSchema
};

export interface ContextObservationRow {
  observation_id: string;
  tenant_id: string;
  person_id: string;
  memory_space_id: string;
  dimension: ContextDimension;
  value: Record<string, unknown>;
  basis: ContextBasis;
  source_type: string;
  source_instance_id: string | null;
  confidence: number | null;
  observed_at: string;
  created_at: string;
  updated_at: string;
}

/** Én dimensjons snapshot slik den returneres til kalleren av `getCurrentContext()` - ALDRI uten `basis`/`stale`. */
export interface ContextDimensionSnapshot {
  value: Record<string, unknown>;
  basis: ContextBasis;
  source_type: string;
  source_instance_id: string | null;
  confidence: number | null;
  observed_at: string;
  /** `true` naar `now - observed_at` overstiger dimensjonens konfigurerte maks-alder - se `DEFAULT_MAX_AGE_MS`. */
  stale: boolean;
}

export interface PersonContextSnapshot {
  tenant_id: string;
  person_id: string;
  memory_space_id: string;
  generated_at: string;
  dimensions: Record<ContextDimension, ContextDimensionSnapshot | null>;
}

export interface RecordObservationInput {
  tenant_id: string;
  person_id: string;
  memory_space: z.infer<typeof MemorySpaceSchema>;
  dimension: ContextDimension;
  value: Record<string, unknown>;
  basis: ContextBasis;
  /** Pointer til opphavet - ALDRI innhold. F.eks. "device", "session", "business_activity", "location_service". */
  source_type: string;
  source_instance_id?: string;
  confidence?: number;
  /** ISO-tidsstempel for NAAR observasjonen faktisk gjelder - default `now()` naar utelatt. */
  observed_at?: string;
  /** Kun for audit-sporbarhet (`writeAudit`) - ALDRI del av selve kontekstverdien. */
  session_id?: string;
  device_id?: string;
}

export type RecordObservationIgnoredReason = "deterministic_precedence";

export interface RecordObservationResult {
  /** `false` naar en 'inferred'-observasjon ble forkastet fordi en 'deterministic' observasjon allerede finnes for samme dimensjon (se `service.ts`). */
  applied: boolean;
  reason?: RecordObservationIgnoredReason;
  observation: ContextObservationRow;
}
