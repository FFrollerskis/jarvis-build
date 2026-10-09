// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { failureCategory, type ControlItem, type ControlRiskClass, type ControlStatus } from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { withMemoryTransaction } from "@jarvis/memory";

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

/**
 * Tenant-skopet lesing av tabeller med RESTRICTIVE minnerom-RLS (situasjoner, autonomi-policyer, minne): `jarvis.memory_spaces` MÅ settes eksplisitt, ellers er tabellen usynlig (default deny).
 * `health` er isolert (aldri sammen med andre rom) - kall derfor `health` i sin egen lesing.
 */
export function tenantSpaceRead<T>(
  pool: ControlCenterPool, tenantId: string, spaces: readonly MemorySpace[],
  run: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>
): Promise<T> {
  return withMemoryTransaction(pool as pg.Pool, tenantId, spaces, async (client) => run(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]));
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

/** «om 3 min» - deterministisk norsk tid frem til et fremtidig tidspunkt. Passert eller manglende tidspunkt gir «nå»/«ukjent». */
export function untilNo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "ukjent";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "ukjent";
  const sec = Math.floor((t - nowMs) / 1000);
  if (sec <= 0) return "nå";
  if (sec < 90) return `om ${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `om ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `om ${hours} t`;
  return `om ${Math.round(hours / 24)} d`;
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

export function statusCount(items: readonly ControlItem[], s: ControlStatus): number {
  return items.filter((i) => i.status === s).length;
}

/** «2 feil, 1 advarsel, 3 ikke målt, 40 i orden» - deterministisk norsk telling til seksjonssammendrag. */
export function countsNo(items: readonly ControlItem[]): string {
  const parts = [
    statusCount(items, "FAIL") > 0 ? `${statusCount(items, "FAIL")} feil` : "",
    statusCount(items, "WARN") > 0 ? `${statusCount(items, "WARN")} advarsel` : "",
    statusCount(items, "UNKNOWN") > 0 ? `${statusCount(items, "UNKNOWN")} ikke målt` : "",
    statusCount(items, "OK") > 0 ? `${statusCount(items, "OK")} i orden` : ""
  ].filter((p) => p !== "");
  return parts.length > 0 ? parts.join(", ") : "ingen";
}

/** Risikoklassen til en registrert handling, lest fra verktøydefinisjonen (aldri en kopi). Ukjent handling regnes som D (strengest). */
export function riskOf(gateway: Pick<ToolGateway, "get">, toolId: string, action: string): ControlRiskClass {
  return gateway.get(toolId, action)?.capability_class ?? "D";
}
