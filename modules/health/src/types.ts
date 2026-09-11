import { z } from "zod";

/**
 * UA-8 Personal Digital Twin: provider-nøytral, JARVIS_CANONICAL helse-
 * observasjons-kontrakt (D-64 - Jarvis eier modellen, en leverandør er
 * ALDRI stedet den bor). Dette er et INGESTION-/lese-kontraktlag - se
 * `service.ts` for den fulle arkitektur-begrunnelsen. INGEN kode i denne
 * pakken later som den snakker med en ekte Apple Health-kjøretid (verken
 * her eller i `FakeHealthMetricSource` - se JSDoc der).
 *
 * BEVISST SMALT, LUKKET MVP-sett (v1) - IKKE et forsøk på å modellere hele
 * Apple HealthKit sin ontologi (hundrevis av `HKQuantityType`/
 * `HKCategoryType`-varianter, korrelasjoner, kilde-metadata osv). Kun de
 * fire mest grunnleggende, universelt forståtte målingene er inkludert;
 * settet utvides NÅR en faktisk kilde/brukstilfelle krever det (samme
 * mønster som `consent_decisions.purpose`/`operations_vendors.category` -
 * se `049_health.sql`).
 */
export const MetricTypeSchema = z.enum(["heart_rate", "steps", "sleep_duration_minutes", "weight_kg"]);
export type MetricType = z.infer<typeof MetricTypeSchema>;

/** Ett kanonisk enhet per `metric_type` (v1: ingen multi-enhet-støtte, f.eks. lb vs kg - konvertering er en FREMTIDIG utvidelse, ikke bygget her). */
export const METRIC_CANONICAL_UNITS: Readonly<Record<MetricType, string>> = Object.freeze({
  heart_rate: "bpm",
  steps: "count",
  sleep_duration_minutes: "minutes",
  weight_kg: "kg"
});

/**
 * MVP-fornuftige plausibilitetsgrenser per `metric_type` - IKKE en påstand
 * om medisinsk presisjon eller et forsøk på å dekke ekstreme, men reelle,
 * fysiologiske utfall. Formålet er å strukturelt avvise åpenbart korrupt/
 * feilsendt data (f.eks. en negativ hjertefrekvens, eller et "steps"-tall i
 * milliardene fra en defekt kilde) FØR det når `health_metric_observations`
 * - se `HealthObservationValidationError` i `service.ts`.
 */
export const METRIC_VALUE_BOUNDS: Readonly<Record<MetricType, { min: number; max: number }>> = Object.freeze({
  heart_rate: { min: 1, max: 300 },
  steps: { min: 0, max: 200_000 },
  sleep_duration_minutes: { min: 0, max: 1440 },
  weight_kg: { min: 1, max: 500 }
});

/**
 * Rå input for ÉN observasjon - formen en `HealthMetricSource`-adapter
 * (fremtidig Apple Health, eller `FakeHealthMetricSource` i tester)
 * produserer, OG formen `HealthService.ingestObservation()` tar imot
 * direkte. `source_type`/`source_instance_id` er en POINTER til hvilken
 * adapter/enhet observasjonen kom fra - ALDRI en duplisert kopi av rå
 * leverandør-payload et annet sted (se `service.ts`).
 */
export const HealthObservationInputSchema = z
  .object({
    metric_type: MetricTypeSchema,
    value: z.number().finite(),
    unit: z.string().min(1),
    /** ISO 8601-tidsstempel for NÅR målingen faktisk skjedde (kan avvike fra `recorded_at`, som er når Jarvis mottok den). */
    observed_at: z.string().min(1),
    source_type: z.string().min(1),
    source_instance_id: z.string().min(1).optional()
  })
  .strict();
export type HealthObservationInput = z.infer<typeof HealthObservationInputSchema>;

/** Én permanent rad i `health_metric_observations` (append-only, se `049_health.sql`). */
export interface HealthMetricObservation {
  observation_id: string;
  tenant_id: string;
  memory_space_id: "health";
  person_id: string;
  metric_type: MetricType;
  value: number;
  unit: string;
  source_type: string;
  source_instance_id: string | null;
  observed_at: string;
  recorded_at: string;
  retention_expires_at: string | null;
}

/** Eier-konfigurert retention-vindu for én tenant sitt 'health'-space (se `049_health.sql` sin migrasjons-kommentar). */
export interface HealthRetentionPolicy {
  tenant_id: string;
  memory_space_id: "health";
  retention_days: number;
  actor_person_id: string | null;
  updated_at: string;
}

export interface SetHealthRetentionPolicyInput {
  retention_days: number;
  actor_person_id?: string;
}

/**
 * Provider-nøytral adapterkontrakt (§ byggeordren: "en fremtidig Apple
 * Health / annen leverandør-adapter skal kunne skrives mot en STABIL
 * kontrakt uten å røre denne tjenestens internfunksjoner"). D-64: Jarvis
 * eier denne kontrakten - en fremtidig `AppleHealthMetricSource` (IKKE
 * bygget her - krever en fysisk iPhone + Apple Health-entitlement som
 * IKKE finnes i dette miljøet) implementerer DENNE, uendrede, grensen.
 * `fetchRecent()` returnerer rå, IKKE-validerte `HealthObservationInput`-
 * objekter - `HealthService.ingestObservation()`/`ingestFromSource()`
 * validerer og skriver dem, ALDRI adapteren selv (samme "kilde produserer
 * data, tjenesten avgjør gyldighet"-grense som `ConsentTransport`/
 * `GrowthTransport`).
 */
export interface HealthMetricSourceFetchOptions {
  personId: string;
  /** Kun observasjoner med `observed_at` >= dette (ms siden epoch) - `undefined` betyr "ingen nedre grense" (adapteren avgjør selv et rimelig standardvindu). */
  sinceMs?: number;
}

export interface HealthMetricSource {
  readonly name: string;
  fetchRecent(options: HealthMetricSourceFetchOptions): Promise<HealthObservationInput[]>;
}
