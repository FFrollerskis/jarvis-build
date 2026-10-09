// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import { failureCategory, type ControlItem, type ControlStatus } from "@jarvis/executive";

/**
 * WP-H0: felles hjelpere for kontrollsentrene i denne mappen (Integration, Authority, AI og sentrene andre bygger på samme kontrakt). Alt her er LESING og ren funksjon - ingenting skriver.
 */

/** Appens pool (jarvis_app-rollen). `connect` trengs kun av `tenantRows` (tenant-skopet lesing under RLS). */
export type ControlCenterPool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

/** Tenant-skopet lesing: ALLTID via `withTenantTransaction` under identitetens egen tenant (RLS), aldri en fast eller parameterstyrt tenant. */
export function tenantRows<T extends object = Record<string, unknown>>(pool: ControlCenterPool, tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return withTenantTransaction(pool as pg.Pool, tenantId, async (client) => (await client.query(sql, params)).rows as T[]);
}

/** Flere tenant-skopede lesinger i ÉN transaksjon (samme RLS-kontekst). */
export function tenantRead<T>(pool: ControlCenterPool, tenantId: string, run: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool as pg.Pool, tenantId, async (client) => run(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]));
}

/** Lesing fra tabeller UTEN tenant-skopet (f.eks. `scheduler_state`, `owner_control_state`): kun eksplisitt valgte, globale driftstabeller. */
export async function globalRows<T extends object = Record<string, unknown>>(pool: ControlCenterPool, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

export type Settled<T> = { ok: true; value: T } | { ok: false; category: string };

/** Fail-soft lesing: en kilde som feiler blir en feilKATEGORI (aldri meldingen), så ett uleselig sted gjør kun de berørte tallene ukjente - ikke hele senteret. */
export async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, category: failureCategory(err) };
  }
}

/** Dato/tidsstempel fra pg (Date, ISO-streng eller `timestamptz::text`) til ISO-8601, eller null. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, nowMs - t);
}

/** «for 3 t siden» - deterministisk norsk relativ tid. Manglende tidspunkt gir «aldri målt». */
export function relativeNo(iso: string | null | undefined, nowMs: number): string {
  const age = ageMs(iso, nowMs);
  if (age === null) return "aldri målt";
  const min = Math.floor(age / 60_000);
  if (min < 1) return "nå";
  if (min < 60) return `for ${min} min siden`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `for ${hours} t siden`;
  return `for ${Math.floor(hours / 24)} d siden`;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Gjør en liste til en kort, avkortet kommaseparert streng (for skalare fakta). */
export function joinFact(values: readonly string[], max = 280): string {
  const text = values.join(", ");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const SEVERITY: Readonly<Record<ControlStatus, number>> = { FAIL: 0, WARN: 1, UNKNOWN: 2, OK: 3 };

/** Det som trenger oppmerksomhet først: FAIL, WARN, UNKNOWN, så OK; likt nivå sorteres på visningsnavn (stabilt, norsk). */
export function bySeverityThenLabel(a: ControlItem, b: ControlItem): number {
  return SEVERITY[a.status] - SEVERITY[b.status] || a.label.localeCompare(b.label, "nb");
}
