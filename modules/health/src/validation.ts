import { z } from "zod";
import { HealthObservationInputSchema, METRIC_CANONICAL_UNITS, METRIC_VALUE_BOUNDS, type HealthObservationInput } from "./types.ts";

/**
 * STRENG tidsstempel (fiks-runde review B MEDIUM-2): ISO 8601 med sone (`Z` eller ±hh:mm) og en GYLDIG dato (zod avviser `2026-09-31`, `2026-02-30`, tidsstempel uten sone og tekst rundt) - JS `Date.parse` er lenient og godtok strenger
 * som Postgres avviste midt i transaksjonen. Pluss et plausibelt vindu: ikke før år 2000 og ikke mer enn 24 t frem i tid (den finere fremtidssjekken mot databaseklokken står i inntaket).
 */
const STRICT_DATETIME = z.string().datetime({ offset: true });
export const HEALTH_OBSERVED_MIN_MS = Date.UTC(2000, 0, 1);
export const HEALTH_OBSERVED_MAX_AHEAD_MS = 24 * 3_600_000;
/**
 * Størst tillatte tidssone-forskyvning (±14:00, som verdens faktiske soner og som DAV-datoene). Zod godtar ethvert tosifret ±HH(:MM) og Postgres kaster 22009 («time zone displacement out of range») for +16:00 og utover midt i transaksjonen
 * (delta-review B, M2: hele batchen rullet tilbake med en rå pg-feil og 500). Avvises derfor i ALLE former (`Z`, ±HH, ±HHMM, ±HH:MM) FØR transaksjonen; minuttdelen må være 00-59.
 */
export const HEALTH_OBSERVED_MAX_OFFSET_MINUTES = 14 * 60;

/** Forskyvningen i minutter (`Z` = 0) i en streng zod allerede har godtatt, eller `null` hvis den er ugyldig (minutter over 59). */
function offsetMinutes(value: string): number | null {
  const m = /(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/.exec(value);
  if (m === null) return null;
  if (m[1] === undefined) return 0;
  const mm = Number(m[3] ?? "0");
  if (mm > 59) return null;
  const total = Number(m[2]) * 60 + mm;
  return m[1] === "-" ? -total : total;
}

export function isPlausibleObservedAt(value: unknown, nowMs: number = Date.now()): boolean {
  if (typeof value !== "string" || !STRICT_DATETIME.safeParse(value).success) return false;
  const offset = offsetMinutes(value);
  if (offset === null || Math.abs(offset) > HEALTH_OBSERVED_MAX_OFFSET_MINUTES) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= HEALTH_OBSERVED_MIN_MS && ms <= nowMs + HEALTH_OBSERVED_MAX_AHEAD_MS;
}

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
  if (!isPlausibleObservedAt(value.observed_at)) return { ok: false, field: "observed_at", detail: "not_a_valid_iso_datetime" };
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
