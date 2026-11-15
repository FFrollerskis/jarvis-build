// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction } from "@jarvis/core";
import { CONTROL_CENTER_READ_TOOLS, failureCategory, isCloudWithheldCenter, type ControlCenterId, type ControlItem, type ControlRiskClass, type ControlStatus } from "@jarvis/executive";
import type { FinanceIntentOptions, ToolGateway } from "@jarvis/tool-gateway";
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

// ---------------------------------------------------------------------------------------------------------------------
// WP-H1/H2: felles hjelpere for sentrene som ble lagt til etter H0 (Finans, Minne, Agenter, Drift, Verdi, Personvern, Sikkerhet). Kun tillegg - H0-hjelperne over er uendret.
// ---------------------------------------------------------------------------------------------------------------------

/** Alle minnerom UTEN health: health er isolert (aldri sammen med andre rom) og leses kun som antall i en egen lesing. */
export const NON_HEALTH_SPACES: readonly MemorySpace[] = ["personal", "business", "project", "home", "guest", "shared"];

/** pg gir `bigint` og `numeric` som strenger; alt som ikke er et endelig tall blir 0 (en teller er aldri NaN). */
export function toInt(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** `null` beholdes som `null` (ukjent er ikke 0); ellers som `toInt`. */
export function toIntOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toInt(value);
}

export function optStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Et kort, trygt kategorinavn fra en tekstkolonne (bokstaver, tall, understrek, kolon, punktum og bindestrek; maks 60 tegn). Alt annet blir `annet` - aldri fri tekst inn i en rapport.
 * Kategorinavn havner også i id-er (`flag:<kilde>:<flagg>`), og registerets redigering rører bevisst ikke id-er (de er strukturelle) - derfor avvises alt som ligner en hemmelighet HER: noe
 * `scanForSecrets` ville endret, og enhver sammenhengende løpe på 24 eller flere bokstaver/tall uten skilletegn (nøkler og tokens har dem, kategorinavn i snake_case har dem ikke).
 */
export function safeCategory(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_:.-]{1,60}$/.test(text)) return "annet";
  if (/[A-Za-z0-9]{24,}/.test(text)) return "annet";
  if (scanForSecrets(text).text !== text) return "annet";
  return text;
}

/**
 * Gjennomgang L5: id-felt fra databasen (samtykke-id, avstemmingskjøring) skal gjennom SAMME filter som `safeCategory`, men et avvist felt får en UNIK reserveverdi (`fallback`, f.eks. `ukjent-2`) i stedet for «annet»:
 * id-er må være unike i en seksjon (en kollisjon ville felt hele senteret, `duplicate_control_item_id`), og en id som ligner en hemmelighet skal aldri ut i en rapport, et element-id eller en etikett (registerets redigering
 * rører bevisst ikke id-er). Gyldige, Jarvis-genererte id-er (`bank-co-<uuid>`, `fin-rec-<uuid>`) passerer uendret.
 */
export function safeRef(value: unknown, fallback: string): string {
  const safe = safeCategory(value);
  return safe === "annet" ? fallback : safe;
}

/**
 * Slår sammen rader som får SAMME nøkkel etter `safeCategory` (to ulike «uvanlige» verdier blir begge «annet»). Id-ene i en seksjon må være unike - en kollisjon ville ellers felt hele senteret
 * (`duplicate_control_item_id`) på grunn av én rar rad. Rekkefølgen beholdes (første forekomst).
 */
export function mergeBy<T>(rows: readonly T[], key: (row: T) => string, merge: (a: T, b: T) => T): T[] {
  const out = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    const prev = out.get(k);
    out.set(k, prev === undefined ? row : merge(prev, row));
  }
  return [...out.values()];
}

/** Strengt flagg: kun den eksakte verdien «on» slår en funksjon på (alt annet, også «true»/«1»/«ON», er AV - samme regel som JARVIS_KNOWLEDGE_CLAIM_WRITES). */
export function flagOn(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  return env[name] === "on";
}

/**
 * WP-H1/H2: flaggene som slår på kontrollsentrene som ble bygget etter H0. ALLE er AV som standard og krever den EKSAKTE verdien «on» (`flagOn`): uten flagg registreres senteret ikke, og står i oversiktens
 * `unregistered`-liste («ikke koblet inn») akkurat som før H1 - H0-oppførselen er uendret. Integrasjoner, Autoritet og AI (H0) har ingen flagg og er alltid på når deres avhengigheter finnes.
 * Objektene bor her (ikke i `register.ts`) slik at `main.ts` kan lese dem uten å røre importlinjen fra fabrikken `register.ts` - den er låst av kildevakten i `e1-review-m3-owner-gate.test.ts`. `register.ts` re-eksporterer dem.
 * Hvert navn MÅ stå i `SERVICE_ENV.api` (`infra/local/service-env.mjs`), ellers når en verdi i `.env` aldri containeren - låst av `wph1-control-env.test.ts`.
 */
export const CONTROL_CENTER_FLAGS = {
  finance: "JARVIS_CONTROL_CENTER_FINANCE",
  memory: "JARVIS_CONTROL_CENTER_MEMORY",
  agent: "JARVIS_CONTROL_CENTER_AGENT",
  operations: "JARVIS_CONTROL_CENTER_OPERATIONS",
  value: "JARVIS_CONTROL_CENTER_VALUE",
  privacy: "JARVIS_CONTROL_CENTER_PRIVACY",
  security: "JARVIS_CONTROL_CENTER_SECURITY"
} as const;

/**
 * WP-H2: to enkelt-funksjoner kontrollsentrene får bak EGNE flagg (AV som standard, kun eksakt «on»; uten flagg finnes verken knappen eller verktøyet):
 *  - `goldenSuite`: golden-suite-knappen (Sikkerhet-senteret + `executive.run_golden_suite`). Lesende, deterministisk, ingen modell.
 *  - `autonomyRevoke`: tilbakekall av eierens autonomi-binding per domene (Autoritet-senteret + `executive.revoke_autonomy_binding`). Eier-kun, step-up, klasse C.
 */
export const CONTROL_FEATURE_FLAGS = {
  goldenSuite: "JARVIS_CONTROL_GOLDEN_SUITE",
  autonomyRevoke: "JARVIS_CONTROL_AUTONOMY_REVOKE"
} as const;

/**
 * Gjennomgang M1: sentrene hvis flagg er PÅ (eksakt «on»), i masterplanens rekkefølge. `main.ts` registrerer per-senter lese-verktøyene (`executive.get_<senter>_center`) KUN for disse - med alle flagg AV er
 * verktøysettet, flatene og utvalget identisk med main.
 */
export function enabledControlCenters(env: Readonly<Record<string, string | undefined>>): ControlCenterId[] {
  return (Object.keys(CONTROL_CENTER_FLAGS) as Array<keyof typeof CONTROL_CENTER_FLAGS>).filter((id) => flagOn(env, CONTROL_CENTER_FLAGS[id]));
}

/**
 * Gjennomgang M1 + L5: sentrene som får et lese-verktøy = flagget er PÅ **og** senteret er faktisk registrert i registeret (`registerControlCenters` registrerer ikke et senter uten sine avhengigheter). Et verktøy for et senter som
 * ikke finnes ville svart «ikke koblet inn» og stått som tilgjengelig i `get_capability_status` - det registreres derfor ikke. `main.ts` kaller denne etter `registerControlCenters`.
 */
export function controlCentersWithTools(env: Readonly<Record<string, string | undefined>>, registry: { has(id: string): boolean }): ControlCenterId[] {
  return enabledControlCenters(env).filter((id) => registry.has(id));
}

/**
 * Gjennomgang L5: verktøynøklene (`executive.get_<senter>_center`) for sentrene som er slått PÅ og som holdes tilbake fra skymodeller (`CLOUD_WITHHELD_CENTERS`: Finans, og i H2 Verdi) - samme sentre som låser en chat-tur
 * lokalt når verktøyet velges. `financeToolIntent` bruker dem så en delegert jobb med senterets ord også holdes lokal (paritet med chatten). Tom liste (alle flagg AV) = nøyaktig oppførselen på main.
 */
export function activeRestrictedControlTools(env: Readonly<Record<string, string | undefined>>): string[] {
  return enabledControlCenters(env)
    .filter((center) => isCloudWithheldCenter(center))
    .flatMap((center) => CONTROL_CENTER_READ_TOOLS.filter((t) => t.center === center).map((t) => `executive.${t.action}`));
}

/** Valgene `financeToolIntent` får fra kallere i apps/api (delegerte jobber): leses fra miljøet ved hvert kall, så en endring av flaggene (krever restart av api) aldri kan gi en foreldet liste. */
export function financeIntentOptions(env: Readonly<Record<string, string | undefined>> = process.env): FinanceIntentOptions {
  return { restrictedTools: activeRestrictedControlTools(env) };
}
