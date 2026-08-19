/**
 * pg's default `date` (OID 1082) type parser (pg-types, `parseDate()`)
 * constructs the returned value as `new Date(year, month, day)` - LOCAL
 * time, NOT UTC. Round-tripping that value through `.toISOString()`
 * (which converts to UTC) silently shifts the calendar date backward by
 * one day whenever the host's local timezone offset is not UTC+0 - e.g.
 * `new Date(2026, 0, 10).toISOString()` in Europe/Oslo (UTC+1) yields
 * `"2026-01-09T23:00:00.000Z"`. Reading the value back with the SAME
 * local getters used to construct it reverses this correctly regardless
 * of the host's timezone (HOST FIX #2, D-76 - the UA-4 Growth Core host
 * acceptance failed on Tobias's non-UTC host for exactly this reason,
 * even after HOST FIX #1 already fixed the unrelated `String(Date)`
 * bug in the same comparison).
 *
 * Accepts either the `Date` object pg returns for a `date` column, or an
 * already-ISO-prefixed string (defensive passthrough - e.g. a custom
 * type parser, or a value that was never round-tripped through pg).
 */
export function pgDateToIsoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
