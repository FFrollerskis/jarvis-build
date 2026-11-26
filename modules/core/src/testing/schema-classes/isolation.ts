import { randomUUID, createHash } from "node:crypto";
import type { Catalog, CatalogColumn, Queryable } from "./catalog.ts";

/**
 * WP-MC8a K4: NEGATIV ORG-A/B-FIXTURE. For en ORG_OWNED-tabell seedes rader for to tenants (A og B), og med RUNTIME-rollen (aldri en superbruker) bevises:
 *  - LESING:     under kontekst A gir B-rader 0 treff (filtrert OG ufiltrert telling), egne A-rader er synlige (kontroll), og uten tenant-kontekst ses ingenting,
 *  - INSERT:     en B-rad under kontekst A avvises av RLS (WITH CHECK), mens en egen A-rad godtas (kontroll),
 *  - UPDATE:     B-rader kan ikke endres (0 rader), A-rader kan (kontroll), og en A-rad kan ikke flyttes til tenant B (WITH CHECK),
 *  - DELETE:     B-rader kan ikke slettes (0 rader), A-rader kan (kontroll).
 * Hver kontroll (egen tenant virker) gjør beviset ikke-vakuøst: et angrep som feiler fordi tabellen er utilgjengelig for alle, eller fordi raden er ugyldig,
 * regnes ikke som et RLS-bevis. Mangler runtime-rollen GRANT for en operasjon, rapporteres den ærlig som `denied_by_grant` (ikke «bevist av RLS»).
 *
 * Radene lages enten av en tabellspesifikk `RowFactory` (gyldige rader, f.eks. mot en database med alle constraints), eller AUTOMATISK fra katalogen mot en
 * fixture-database der datagyldighets-constraints (CHECK/FK) er fjernet og brukertriggere er av (`stripForIsolation`): RLS, policyer, GRANT, eierskap og
 * FORCE er uberørt, og `fingerprintRls` beviser at de er identiske med den strenge databasen.
 */

export interface IsolationContext {
  readonly tenantA: string;
  readonly tenantB: string;
  /** Verdi for minnerom-kolonnen (`memory_space_id`/`space`) og for `jarvis.memory_spaces` i kontekst A/B. */
  readonly space: string;
}

export const DEFAULT_ISOLATION_CONTEXT: IsolationContext = { tenantA: "iso-tenant-a", tenantB: "iso-tenant-b", space: "personal" };

/** Kjører `fn` som RUNTIME-rollen i en transaksjon med tenant-kontekst satt server-side (null = ingen kontekst). Alt rulles alltid tilbake. */
export type RunAsRuntime = <T>(tenant: string | null, fn: (q: Queryable) => Promise<T>) => Promise<T>;

export interface IsolationEnv {
  /** Superbruker/BYPASSRLS: seeder og kontrollerer data. Brukes aldri til selve angrepene. */
  readonly admin: Queryable;
  readonly asRuntime: RunAsRuntime;
  readonly catalog: Catalog;
  readonly ctx: IsolationContext;
}

export interface RowFactoryArgs {
  readonly tenant: string;
  readonly space: string;
  /** Unik per rad (kjøring): bruk den i primærnøkler og unike felt. */
  readonly seq: number;
  /** Admin-tilkobling: opprett foreldrerader (FK, policyer som slår opp andre tabeller) her før raden returneres. */
  readonly admin: Queryable;
  /** Den automatisk syntetiserte raden (NOT NULL-fyll, tenant, minnerom) for en vilkårlig tabell, samme `seq` og tenant - med valgfrie overstyringer. */
  readonly auto: (table: string, overrides?: RowValues) => RowValues;
  /** Setter inn en foreldrerad som admin (idempotent: ON CONFLICT DO NOTHING). */
  readonly seedParent: (table: string, values: RowValues) => Promise<void>;
}
export type RowValues = Readonly<Record<string, unknown>>;
export type RowFactory = (args: RowFactoryArgs) => Promise<RowValues> | RowValues;

export type ProofState = "proven" | "denied_by_grant" | `failed:${string}`;

export interface TableIsolationReport {
  readonly table: string;
  readonly mode: "auto" | "factory";
  readonly read: ProofState;
  readonly noContext: ProofState;
  readonly insert: ProofState;
  readonly update: ProofState;
  readonly updateMove: ProofState;
  readonly delete: ProofState;
  readonly ok: boolean;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const OPS = ["read", "noContext", "insert", "update", "updateMove", "delete"] as const;
const fail = (why: string): ProofState => `failed:${why}`;
export const isFailed = (s: ProofState): boolean => s.startsWith("failed:");

// --- runnere -----------------------------------------------------------------------------------------------------------------------------

export interface PoolLike {
  connect(): Promise<Queryable & { release(err?: boolean | Error): void }>;
}

/** Ekte innlogging som runtime-medlem (en pool): `BEGIN; set_config(.., true); fn; ROLLBACK`. Samme kontekstmekanisme som produksjonskoden. */
export function poolRunner(pool: PoolLike, space: string): RunAsRuntime {
  return async (tenant, fn) => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      if (tenant !== null) await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [tenant, space]);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      client.release(broken);
    }
  };
}

/** For en allerede åpen transaksjon (mutanter): `SAVEPOINT; SET LOCAL ROLE <runtime-medlem>; set_config; fn; ROLLBACK TO SAVEPOINT`. Uforpliktet DDL i transaksjonen er synlig. */
export function savepointRunner(client: Queryable, role: string, space: string): RunAsRuntime {
  let n = 0;
  return async (tenant, fn) => {
    n += 1;
    const sp = `iso_sp_${n}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await client.query(`SET LOCAL ROLE ${q(role)}`);
      if (tenant !== null) await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [tenant, space]);
      return await fn(client);
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    }
  };
}

/** Oppretter et LOGIN-medlem av runtime-rollen (NOSUPERUSER, NOBYPASSRLS) for isolasjonsangrepene. Navn og passord er kun for en kortlivet testdatabase. */
export async function createRuntimeLogin(admin: Queryable, name: string, password: string, runtimeRole = "jarvis_app"): Promise<void> {
  await admin.query(`CREATE ROLE ${q(name)} LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await admin.query(`GRANT ${q(runtimeRole)} TO ${q(name)}`);
}

// --- fixture-database uten datagyldighets-constraints -------------------------------------------------------------------------------------

export interface StripSummary {
  readonly tables: number;
  readonly checksDropped: number;
  readonly foreignKeysDropped: number;
  readonly exclusionsDropped: number;
  readonly triggersDisabled: string[];
  /** Andre `jarvis.*`-innstillinger de avslåtte triggerne leser (ikke isolasjon; f.eks. erasure-flagget). */
  readonly otherSettingsRead: string[];
  /** Brukertriggere som LESER isolasjons-innstillingene (`jarvis.tenant_id`/`jarvis.memory_spaces`) og derfor holdes PÅ. */
  readonly triggersKept: string[];
}

/**
 * Fjerner CHECK/FK/exclusion-constraints og slår av brukertriggere (som ikke leser `jarvis.*`) i en KORTLIVET fixture-database, slik at automatisk syntetiserte rader
 * (bare NOT NULL-fyll) kan settes inn for alle tabeller. Rører ALDRI RLS, policyer, GRANT, eierskap eller FORCE (se `fingerprintRls`). Kall aldri mot en ekte database.
 */
export async function stripForIsolation(admin: Queryable): Promise<StripSummary> {
  const constraints = (
    await admin.query(
      `SELECT c.relname AS tbl, k.conname::text AS name, k.contype::text AS kind FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND k.contype IN ('c','f','x') ORDER BY 1, 2`
    )
  ).rows;
  const counts = { c: 0, f: 0, x: 0 };
  // Fremmednøkler først (de kan avhenge av unike constraints vi beholder, men aldri av CHECK).
  for (const kind of ["f", "c", "x"] as const) {
    for (const row of constraints.filter((r) => r["kind"] === kind)) {
      await admin.query(`ALTER TABLE ${q(String(row["tbl"]))} DROP CONSTRAINT ${q(String(row["name"]))}`);
      counts[kind] += 1;
    }
  }
  const triggers = (
    await admin.query(
      `SELECT c.relname AS tbl, t.tgname::text AS name, p.prosrc AS src FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1, 2`
    )
  ).rows;
  const disabled: string[] = [];
  const kept: string[] = [];
  const otherSettings = new Set<string>();
  for (const t of triggers) {
    const label = `${String(t["tbl"])}.${String(t["name"])}`;
    const src = String(t["src"] ?? "");
    // En trigger som leser ISOLASJONS-innstillingene kan være en del av isolasjonen og holdes PÅ; andre `jarvis.*`-innstillinger (f.eks. erasure-flagget) er ikke isolasjon.
    if (/jarvis\.(tenant_id|memory_spaces)/.test(src)) {
      kept.push(label);
      continue;
    }
    for (const m of src.matchAll(/jarvis\.[a-z_]+/g)) otherSettings.add(m[0]);
    await admin.query(`ALTER TABLE ${q(String(t["tbl"]))} DISABLE TRIGGER ${q(String(t["name"]))}`);
    disabled.push(label);
  }
  const tables = Number((await admin.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")).rows[0]?.["n"]);
  return { tables, checksDropped: counts.c, foreignKeysDropped: counts.f, exclusionsDropped: counts.x, triggersDisabled: disabled, otherSettingsRead: [...otherSettings].sort(), triggersKept: kept };
}

/** Kanonisk fingeravtrykk av ALT som avgjør isolasjon: RLS-flagg, eier, runtime-privilegier (tabell og kolonne), policyer, SECURITY DEFINER-funksjoner. */
export function fingerprintRls(catalog: Catalog): { digest: string; lines: string[] } {
  const lines: string[] = [];
  for (const rel of catalog.relations) lines.push(`rel|${rel.schema}.${rel.name}|${rel.kind}|owner=${rel.owner}|rls=${rel.rlsEnabled}|force=${rel.rlsForced}|ownerMember=${rel.runtimeIsOwnerMember}`);
  for (const p of catalog.tablePrivileges) lines.push(`priv|${p.table}|${[p.select, p.insert, p.update, p.delete, p.truncate, p.references, p.trigger].map(Number).join("")}`);
  for (const c of catalog.columns) lines.push(`col|${c.table}.${c.name}|${[c.runtime.select, c.runtime.insert, c.runtime.update, c.runtime.references].map(Number).join("")}|${c.notNull ? "nn" : "n"}|${c.generated || c.identity ? "gen" : "plain"}`);
  for (const p of catalog.policies) lines.push(`pol|${p.table}|${p.name}|${p.permissive ? "P" : "R"}|${p.command}|${[...p.roles].sort().join(",")}|${p.appliesToRuntime}|${p.using ?? "-"}|${p.withCheck ?? "-"}`);
  for (const f of catalog.functions) if (f.securityDefiner) lines.push(`def|${f.signature}|${f.owner}|${f.config.join(",")}|${f.publicExecute}|${f.runtimeExecute}`);
  lines.sort();
  return { digest: createHash("sha256").update(lines.join("\n")).digest("hex"), lines };
}

// --- radsyntese ------------------------------------------------------------------------------------------------------------------------

/** Minnerom-kolonnen RESTRICTIVE-policyen leser (`<kolonne> = ANY (string_to_array(current_setting('jarvis.memory_spaces' ...))`), eller null. */
export function spaceColumnOf(catalog: Catalog, table: string): string | null {
  for (const p of catalog.policies) {
    if (p.table !== table) continue;
    for (const expr of [p.using, p.withCheck]) {
      const m = expr === null ? null : /\b([a-z_][a-z0-9_]*) = ANY \(string_to_array\(current_setting\('jarvis\.memory_spaces'/.exec(expr);
      if (m !== null) return m[1] as string;
    }
  }
  return null;
}

/** Fyllverdi (tekst-format; Postgres tolker mot kolonnetypen) for en NOT NULL-kolonne uten egen semantikk. Null = ingen kjent fyllverdi (trenger fabrikk). */
export function fillerFor(type: string, name: string, seq: number): string | null {
  const t = type.toLowerCase();
  if (t.endsWith("[]")) return "{}";
  if (t === "text" || t.startsWith("character") || t === "name") return `iso-${seq}-${name}`.slice(0, 200);
  if (t === "integer" || t === "bigint") return String(seq);
  if (t === "smallint") return String(seq % 30_000);
  if (t.startsWith("numeric") || t === "double precision" || t === "real") return "0";
  if (t === "boolean") return "false";
  if (t === "jsonb" || t === "json") return "{}";
  if (t.startsWith("timestamp")) return new Date(Date.UTC(2026, 0, 1, 0, 0, seq % 86_000)).toISOString();
  if (t === "date") return new Date(Date.UTC(2026, 0, 1 + (seq % 3000))).toISOString().slice(0, 10);
  if (t === "uuid") return randomUUID();
  if (t === "tsvector") return "";
  if (t === "bytea") return "\\x00";
  return null;
}

interface RowPlan {
  readonly columns: string[];
  readonly values: unknown[];
}

function synthesizeRow(catalog: Catalog, table: string, tenant: string, space: string, seq: number, onlyColumns: ReadonlySet<string> | null): RowPlan | { readonly missing: string } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const spaceCol = spaceColumnOf(catalog, table);
  for (const col of catalog.columns.filter((c) => c.table === table)) {
    if (col.generated || col.identity) continue;
    if (onlyColumns !== null && !onlyColumns.has(col.name)) continue;
    let value: string | null;
    if (col.name === "tenant_id") value = tenant;
    else if (col.name === spaceCol) value = space;
    else if (col.notNull) {
      value = fillerFor(col.type, col.name, seq);
      if (value === null) return { missing: `${col.name} (${col.type})` };
    } else continue;
    columns.push(col.name);
    values.push(value);
  }
  return { columns, values };
}

const insertSql = (table: string, columns: readonly string[]): string => `INSERT INTO ${q(table)} (${columns.map(q).join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`;

function factoryArgs(env: IsolationEnv, tenant: string, seq: number): RowFactoryArgs {
  return {
    tenant,
    space: env.ctx.space,
    seq,
    admin: env.admin,
    auto: (table, overrides = {}) => {
      const plan = synthesizeRow(env.catalog, table, tenant, env.ctx.space, seq, null);
      if ("missing" in plan) throw new Error(`isolation_auto_row_impossible:${table}: ${plan.missing}`);
      return { ...Object.fromEntries(plan.columns.map((c, i) => [c, plan.values[i]])), ...overrides };
    },
    seedParent: async (table, values) => {
      const columns = Object.keys(values);
      await env.admin.query(`${insertSql(table, columns)} ON CONFLICT DO NOTHING`, columns.map((c) => values[c]));
    }
  };
}

async function rowFor(env: IsolationEnv, table: string, tenant: string, seq: number, factory: RowFactory | undefined, runtimeOnly: boolean): Promise<RowPlan | { readonly missing: string }> {
  if (factory !== undefined) {
    const row = await factory(factoryArgs(env, tenant, seq));
    const columns = Object.keys(row);
    if (row["tenant_id"] !== tenant) return { missing: `fabrikken satte tenant_id=${String(row["tenant_id"])} (forventet ${tenant})` };
    return { columns, values: columns.map((c) => row[c]) };
  }
  const allowed = runtimeOnly ? new Set(env.catalog.columns.filter((c) => c.table === table && c.runtime.insert).map((c) => c.name)) : null;
  return synthesizeRow(env.catalog, table, tenant, env.ctx.space, seq, allowed);
}

/** Setter inn én rad per tenant (A: seq 1, B: seq 2) som admin. Idempotent (ON CONFLICT DO NOTHING); feil gir en lesbar melding. */
export async function seedIsolationRows(env: IsolationEnv, table: string, factory?: RowFactory): Promise<void> {
  for (const [tenant, seq] of [[env.ctx.tenantA, 1], [env.ctx.tenantB, 2]] as const) {
    const plan = await rowFor(env, table, tenant, seq, factory, false);
    if ("missing" in plan) throw new Error(`isolation_seed_impossible:${table}: ${plan.missing} - gi tabellen en RowFactory`);
    try {
      await env.admin.query(`${insertSql(table, plan.columns)} ON CONFLICT DO NOTHING`, plan.values);
    } catch (err) {
      throw new Error(`isolation_seed_failed:${table} (${tenant}): ${(err as Error).message}`);
    }
  }
}

// --- angrep og bevis ----------------------------------------------------------------------------------------------------------------------

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: "rls" | "grant" | "other"; readonly message: string; readonly code: string };

async function attempt<T>(run: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = String((err as { code?: unknown }).code ?? "");
    if (/row-level security/i.test(message)) return { ok: false, kind: "rls", message, code };
    if (/permission denied/i.test(message)) return { ok: false, kind: "grant", message, code };
    return { ok: false, kind: "other", message, code };
  }
}

/** SQLSTATE 23505. RLS WITH CHECK evalueres FØR indeksinnsetting, så en unik-brudd-feil på en egen-tenant-rad beviser at RLS slapp raden gjennom (tabeller med én rad per tenant). */
const isUniqueViolation = (o: { readonly code: string }): boolean => o.code === "23505";

const countOf = async (db: Queryable, table: string, tenant: string | null): Promise<number> => {
  const r = tenant === null ? await db.query(`SELECT count(*)::int AS n FROM ${q(table)}`) : await db.query(`SELECT count(*)::int AS n FROM ${q(table)} WHERE tenant_id = $1`, [tenant]);
  return Number(r.rows[0]?.["n"]);
};

function updatableColumn(columns: readonly CatalogColumn[]): CatalogColumn | undefined {
  const candidates = columns.filter((c) => c.runtime.update && !c.generated && !c.identity);
  return candidates.find((c) => c.name !== "tenant_id") ?? candidates[0];
}

/** Kjører alle bevisene for én tabell. Forutsetter at `seedIsolationRows` er kjørt. Kaster aldri på et RLS-brudd: bruddet står i rapporten. */
export async function checkTableIsolation(env: IsolationEnv, table: string, factory?: RowFactory): Promise<TableIsolationReport> {
  const { admin, asRuntime, ctx, catalog } = env;
  const A = ctx.tenantA;
  const B = ctx.tenantB;
  const columns = catalog.columns.filter((c) => c.table === table);
  const adminA = await countOf(admin, table, A);
  const adminB = await countOf(admin, table, B);
  const state: Record<(typeof OPS)[number], ProofState> = { read: "proven", noContext: "proven", insert: "proven", update: "proven", updateMove: "proven", delete: "proven" };
  if (adminA < 1 || adminB < 1) {
    for (const op of OPS) state[op] = fail(`ingen seed-rader (A=${adminA}, B=${adminB})`);
  } else {
    // LESING (+ symmetri B->A og ufiltrert telling).
    const own = await attempt(asRuntime(A, (c) => countOf(c, table, A)));
    const foreign = await attempt(asRuntime(A, (c) => countOf(c, table, B)));
    const unfiltered = await attempt(asRuntime(A, (c) => countOf(c, table, null)));
    const reverse = await attempt(asRuntime(B, (c) => countOf(c, table, A)));
    if (!own.ok && own.kind === "grant") state.read = "denied_by_grant";
    else if (!own.ok) state.read = fail(`egen lesing feilet: ${own.message}`);
    else if (own.value !== adminA) state.read = fail(`kontroll: kontekst A ser ${own.value} av ${adminA} egne rader`);
    else if (!foreign.ok || foreign.value !== 0) state.read = fail(foreign.ok ? `LEKKASJE: kontekst A leser ${foreign.value} rad(er) tilhørende B` : `lesing av B feilet uventet: ${foreign.message}`);
    else if (!unfiltered.ok || unfiltered.value !== adminA) state.read = fail(unfiltered.ok ? `LEKKASJE: ufiltrert telling under A gir ${unfiltered.value}, forventet ${adminA}` : `ufiltrert lesing feilet: ${unfiltered.message}`);
    else if (!reverse.ok || reverse.value !== 0) state.read = fail(reverse.ok ? `LEKKASJE: kontekst B leser ${reverse.value} rad(er) tilhørende A` : `lesing B->A feilet uventet: ${reverse.message}`);

    // UTEN KONTEKST: ingenting synlig, ingenting kan settes inn.
    const none = await attempt(asRuntime(null, (c) => countOf(c, table, null)));
    if (!none.ok && none.kind === "grant") state.noContext = "denied_by_grant";
    else if (!none.ok) state.noContext = fail(`uten kontekst: ${none.message}`);
    else if (none.value !== 0) state.noContext = fail(`LEKKASJE: uten tenant-kontekst ses ${none.value} rad(er)`);

    // INSERT: kontroll (egen tenant) + angrep (annen tenant).
    const insertable = columns.some((c) => c.runtime.insert);
    const requiredWithoutGrant = columns.some((c) => c.notNull && !c.hasDefault && !c.generated && !c.identity && !c.runtime.insert);
    const control = insertable ? await rowFor(env, table, A, 10, factory, true) : { missing: "ingen INSERT-rettighet" };
    const attack = insertable ? await rowFor(env, table, B, 11, factory, true) : { missing: "ingen INSERT-rettighet" };
    if (!insertable || (factory === undefined && requiredWithoutGrant)) {
      state.insert = "denied_by_grant";
    } else if ("missing" in control || "missing" in attack) {
      state.insert = fail(`kan ikke lage rad: ${"missing" in control ? control.missing : (attack as { missing: string }).missing}`);
    } else {
      const ok1 = await attempt(asRuntime(A, (c) => c.query(insertSql(table, control.columns), control.values)));
      const bad = await attempt(asRuntime(A, (c) => c.query(insertSql(table, attack.columns), attack.values)));
      const noCtx = await attempt(asRuntime(null, (c) => c.query(insertSql(table, control.columns), control.values)));
      if (!ok1.ok && ok1.kind === "grant") state.insert = "denied_by_grant";
      else if (!ok1.ok && !isUniqueViolation(ok1)) state.insert = fail(`kontroll-insert (egen tenant) feilet: ${ok1.message}`);
      else if (bad.ok) state.insert = fail("LEKKASJE: insert av en B-rad under kontekst A ble godtatt (WITH CHECK mangler eller er for vid)");
      else if (bad.kind !== "rls") state.insert = fail(`angreps-insert avvist av noe annet enn RLS: ${bad.message}`);
      else if (noCtx.ok) state.insert = fail("LEKKASJE: insert uten tenant-kontekst ble godtatt");
      else if (noCtx.kind !== "rls") state.insert = fail(`insert uten kontekst avvist av noe annet enn RLS: ${noCtx.message}`);
    }

    // UPDATE: kontroll + angrep, og flytting av en A-rad til B.
    const col = updatableColumn(columns);
    if (col === undefined) {
      state.update = "denied_by_grant";
    } else {
      const sql = `UPDATE ${q(table)} SET ${q(col.name)} = ${q(col.name)} WHERE tenant_id = $1`;
      const mine = await attempt(asRuntime(A, (c) => c.query(sql, [A])));
      const theirs = await attempt(asRuntime(A, (c) => c.query(sql, [B])));
      if (!mine.ok && mine.kind === "grant") state.update = "denied_by_grant";
      else if (!mine.ok) state.update = fail(`kontroll-update feilet: ${mine.message}`);
      else if ((mine.value.rowCount ?? 0) < 1) state.update = fail("kontroll: egen A-rad kunne ikke oppdateres (0 rader)");
      else if (!theirs.ok) state.update = fail(`angreps-update feilet uventet: ${theirs.message}`);
      else if ((theirs.value.rowCount ?? 0) !== 0) state.update = fail(`LEKKASJE: UPDATE endret ${theirs.value.rowCount} rad(er) tilhørende B`);
    }
    const tenantCol = columns.find((c) => c.name === "tenant_id");
    if (tenantCol === undefined || !tenantCol.runtime.update) {
      state.updateMove = "denied_by_grant";
    } else {
      const move = await attempt(asRuntime(A, (c) => c.query(`UPDATE ${q(table)} SET tenant_id = $1 WHERE tenant_id = $2`, [B, A])));
      if (move.ok) state.updateMove = fail(`LEKKASJE: ${move.value.rowCount ?? 0} A-rad(er) ble flyttet til tenant B (WITH CHECK mangler)`);
      else if (move.kind === "grant") state.updateMove = "denied_by_grant";
      else if (move.kind !== "rls") state.updateMove = fail(`flytting avvist av noe annet enn RLS: ${move.message}`);
    }

    // DELETE: kontroll + angrep.
    const del = (tenant: string) => attempt(asRuntime(A, (c) => c.query(`DELETE FROM ${q(table)} WHERE tenant_id = $1`, [tenant])));
    const mineDel = await del(A);
    const theirsDel = await del(B);
    if (!mineDel.ok && mineDel.kind === "grant") state.delete = "denied_by_grant";
    else if (!mineDel.ok) state.delete = fail(`kontroll-delete feilet: ${mineDel.message}`);
    else if ((mineDel.value.rowCount ?? 0) < 1) state.delete = fail("kontroll: egen A-rad kunne ikke slettes (0 rader)");
    else if (!theirsDel.ok) state.delete = fail(`angreps-delete feilet uventet: ${theirsDel.message}`);
    else if ((theirsDel.value.rowCount ?? 0) !== 0) state.delete = fail(`LEKKASJE: DELETE slettet ${theirsDel.value.rowCount} rad(er) tilhørende B`);
  }
  const ok = OPS.every((op) => !isFailed(state[op]));
  return { table, mode: factory === undefined ? "auto" : "factory", ...state, ok };
}

/** Seeder (idempotent) og kjører alle bevisene; kaster med en samlet, lesbar melding hvis noe feiler. Gjenbrukbar fra enhver pakkes tester. */
export async function assertTenantIsolation(env: IsolationEnv, table: string, factory?: RowFactory): Promise<TableIsolationReport> {
  await seedIsolationRows(env, table, factory);
  const report = await checkTableIsolation(env, table, factory);
  if (!report.ok) throw new Error(`tenant_isolation_failed:${table}\n${formatReport(report)}`);
  return report;
}

export function formatReport(r: TableIsolationReport): string {
  return OPS.map((op) => `  ${op}: ${r[op]}`).join("\n");
}

export interface IsolationSummary {
  readonly tables: number;
  readonly behavioral: number;
  /** Alle seks bevis er `proven` (ingen operasjon avvist av GRANT). */
  readonly fullyProven: number;
  /** Minst én operasjon er `denied_by_grant` (appen har ikke rettigheten; ingen RLS-bevis for den delen). */
  readonly withGrantDenials: number;
  readonly failed: string[];
  readonly grantDenials: Array<{ table: string; ops: string[] }>;
}

export function summarizeIsolation(reports: readonly TableIsolationReport[]): IsolationSummary {
  const failed = reports.filter((r) => !r.ok).map((r) => r.table);
  const grantDenials = reports
    .map((r) => ({ table: r.table, ops: OPS.filter((op) => r[op] === "denied_by_grant") as string[] }))
    .filter((d) => d.ops.length > 0);
  const fullyProven = reports.filter((r) => r.ok && OPS.every((op) => r[op] === "proven")).length;
  return { tables: reports.length, behavioral: reports.filter((r) => r.ok).length, fullyProven, withGrantDenials: grantDenials.length, failed, grantDenials };
}
