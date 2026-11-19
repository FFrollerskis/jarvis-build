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
 *
 * WP-G2 (D-464) P1d, migrasjon 128: LUKKET utvidelse fra 4 til 10 metrikker (listen er fortsatt lukket - en ny metrikk er en migrasjon + en verifisert rad i `METRIC_HEALTHKIT_SOURCE` + en test, aldri en konfigurasjon).
 * De seks nye er hver verifisert mot Apples offisielle dokumentasjon 2026-11-18; se `METRIC_HEALTHKIT_SOURCE`.
 */
export const MetricTypeSchema = z.enum([
  "heart_rate", "steps", "sleep_duration_minutes", "weight_kg",
  "resting_heart_rate", "heart_rate_variability_ms", "oxygen_saturation_percent", "respiratory_rate", "active_energy_kcal", "exercise_minutes"
]);
export type MetricType = z.infer<typeof MetricTypeSchema>;

/** Ett kanonisk enhet per `metric_type` (v1: ingen multi-enhet-støtte, f.eks. lb vs kg - konvertering er en FREMTIDIG utvidelse, ikke bygget her; appen konverterer FØR den sender). */
export const METRIC_CANONICAL_UNITS: Readonly<Record<MetricType, string>> = Object.freeze({
  heart_rate: "bpm",
  steps: "count",
  sleep_duration_minutes: "minutes",
  weight_kg: "kg",
  resting_heart_rate: "bpm",
  heart_rate_variability_ms: "ms",
  oxygen_saturation_percent: "percent",
  respiratory_rate: "breaths_per_min",
  active_energy_kcal: "kcal",
  exercise_minutes: "minutes"
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
  weight_kg: { min: 1, max: 500 },
  resting_heart_rate: { min: 20, max: 220 },
  heart_rate_variability_ms: { min: 0, max: 2000 },
  // 50-100: HealthKit gir oksygenmetning som en BRØK (0.0-1.0, `HKUnit.percent()`); appen skal gange med 100. En brøk som ved en feil sendes uten omregning (f.eks. 0.97) faller under grensen og AVVISES synlig i stedet for å lagres feil.
  oxygen_saturation_percent: { min: 50, max: 100 },
  respiratory_rate: { min: 1, max: 100 },
  // Kumulative målinger (energi, treningsminutter) kommer som delprøver med start/slutt: grensene gjelder ÉN prøve.
  active_energy_kcal: { min: 0, max: 10_000 },
  exercise_minutes: { min: 0, max: 1440 }
});

/**
 * WP-G2 (D-464) P1d: kilde-sporbarhet for den LUKKEDE metrikklisten mot Apples OFFISIELLE HealthKit-dokumentasjon (hentet 2026-11-18, `developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/<identifikator>`).
 * VERIFISERT mot dokumentasjonen: identifikatoren finnes, enhetsfamilien og aggregeringsstilen (discrete/cumulative) står som angitt, og `HKUnit.percent()` er en verdi mellom 0.0 og 1.0.
 * IKKE verifisert (appen finnes ikke, `BLOCKED_EXTERNAL`): de konkrete `HKUnit`-konstruktørene appen bruker for omregningen til Jarvis' kanoniske enhet (`app_conversion`), og at samme `uuid` beholdes når en prøve synkroniseres mellom enheter.
 * `sleep_duration_minutes` er en KATEGORI-prøve (`HKCategoryTypeIdentifier.sleepAnalysis`, verdiene i `HKCategoryValueSleepAnalysis`) - appen summerer søvnvarigheten (`allAsleepValues`; stadiene overlapper ikke hverandre) til minutter.
 */
export const HEALTHKIT_DOC_VERIFIED_AT = "2026-11-18";
export interface MetricHealthKitSource {
  /** HealthKit-identifikator (Swift-navn). */
  healthkit_identifier: string;
  aggregation: "discrete" | "cumulative" | "category_derived";
  /** Enhetsfamilien Apple oppgir (ikke nødvendigvis Jarvis' kanoniske enhet). */
  apple_unit_family: string;
  /** Appens omregning til Jarvis' kanoniske enhet (ubekreftet: appen er BLOCKED_EXTERNAL). */
  app_conversion: string;
}
export const METRIC_HEALTHKIT_SOURCE: Readonly<Record<MetricType, MetricHealthKitSource>> = Object.freeze({
  heart_rate: { healthkit_identifier: "HKQuantityTypeIdentifier.heartRate", aggregation: "discrete", apple_unit_family: "count/time", app_conversion: "count/min -> bpm (ingen omregning)" },
  steps: { healthkit_identifier: "HKQuantityTypeIdentifier.stepCount", aggregation: "cumulative", apple_unit_family: "count", app_conversion: "ingen omregning; delprøver (kan slås sammen av HealthKit)" },
  sleep_duration_minutes: {
    healthkit_identifier: "HKCategoryTypeIdentifier.sleepAnalysis", aggregation: "category_derived", apple_unit_family: "kategori-prøver (start/slutt)",
    app_conversion: "summer varigheten av prøvene i HKCategoryValueSleepAnalysis.allAsleepValues for natten, i minutter"
  },
  weight_kg: { healthkit_identifier: "HKQuantityTypeIdentifier.bodyMass", aggregation: "discrete", apple_unit_family: "mass", app_conversion: "-> kg" },
  resting_heart_rate: {
    healthkit_identifier: "HKQuantityTypeIdentifier.restingHeartRate", aggregation: "discrete", apple_unit_family: "count/time",
    app_conversion: "count/min -> bpm; Apple kan SLETTE og erstatte tidligere estimater samme/forrige dag (send slettede prøver i `deleted_external_sample_ids`)"
  },
  heart_rate_variability_ms: {
    healthkit_identifier: "HKQuantityTypeIdentifier.heartRateVariabilitySDNN", aggregation: "discrete", apple_unit_family: "time (typisk millisekunder)", app_conversion: "-> ms (SDNN, ikke RMSSD)"
  },
  oxygen_saturation_percent: {
    healthkit_identifier: "HKQuantityTypeIdentifier.oxygenSaturation", aggregation: "discrete", apple_unit_family: "percent (HKUnit.percent(): 0.0-1.0)", app_conversion: "brøk 0.0-1.0 -> prosent 0-100 (gang med 100)"
  },
  respiratory_rate: { healthkit_identifier: "HKQuantityTypeIdentifier.respiratoryRate", aggregation: "discrete", apple_unit_family: "count/time", app_conversion: "count/min -> breaths_per_min" },
  active_energy_kcal: { healthkit_identifier: "HKQuantityTypeIdentifier.activeEnergyBurned", aggregation: "cumulative", apple_unit_family: "energy", app_conversion: "-> kcal; delprøver (kan slås sammen av HealthKit)" },
  exercise_minutes: { healthkit_identifier: "HKQuantityTypeIdentifier.appleExerciseTime", aggregation: "cumulative", apple_unit_family: "time", app_conversion: "-> minutes" }
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
