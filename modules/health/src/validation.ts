import { HealthObservationInputSchema, METRIC_CANONICAL_UNITS, METRIC_VALUE_BOUNDS, type HealthObservationInput } from "./types.ts";

/**
 * Den ENE valideringen av en helseobservasjon (WP-G2 P1d: trukket ut av `HealthService.ingestObservation` slik at enkeltinntak og det enhetssignerte batch-inntaket aldri kan få to ulike regelsett).
 * Rekkefølgen og meldingene er UENDRET fra den opprinnelige inline-valideringen: skjema (lukket metrikkliste, strengt objekt), gyldig tidsstempel, kanonisk enhet for metrikken, plausibilitetsgrenser.
 */
export type HealthObservationValidation =
  | { ok: true; value: HealthObservationInput }
  | { ok: false; field: string; detail: string };

export function validateHealthObservation(input: unknown): HealthObservationValidation {
  const parsed = HealthObservationInputSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { ok: false, field: firstIssue?.path.join(".") || "input", detail: firstIssue?.message ?? "schema_validation_failed" };
  }
  const value = parsed.data;
  if (Number.isNaN(Date.parse(value.observed_at))) return { ok: false, field: "observed_at", detail: "not_a_valid_iso_datetime" };
  const expectedUnit = METRIC_CANONICAL_UNITS[value.metric_type];
  if (value.unit !== expectedUnit) {
    return { ok: false, field: "unit", detail: `expected '${expectedUnit}' for metric_type '${value.metric_type}', got '${value.unit}'` };
  }
  const bounds = METRIC_VALUE_BOUNDS[value.metric_type];
  if (value.value < bounds.min || value.value > bounds.max) {
    return { ok: false, field: "value", detail: `${value.value} outside plausible range [${bounds.min}, ${bounds.max}] for metric_type '${value.metric_type}'` };
  }
  return { ok: true, value };
}
