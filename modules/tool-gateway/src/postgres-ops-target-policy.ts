import { scanForSecrets } from "@jarvis/core";

/**
 * WP-E1 (UA-5 Developer & Cloud Control Plane, D-41/D-64): mål-autorisasjon og deterministisk inndata-validering for Postgres-DRIFT (`postgres_ops`).
 * SAMME oppdeling som Docker/GCE/Cloudflare: transporten (`postgres-ops-transport.ts`) transporterer, mål-autorisasjonen håndheves av
 * `ToolGateway.execute()` selv via `ToolDefinition.parameterAuthorizer` - aldri en regel inni transporten som kan omgås.
 *
 * D-64 Core-vs-Adapter: databasen er Jarvis' EGEN kjerne (`JARVIS_CANONICAL`); dette er ikke en leverandør-adapter men et DRIFTSVERKTØY mot Jarvis' egen
 * Postgres. Ingen tredjepart blir domenekjerne (`CORE_DEPENDENCY_DECISION_REQUIRED=false`). Verktøyet bruker en EGEN, dedikert tilkobling
 * (`JARVIS_POSTGRES_OPS_URL`, en login-rolle eieren oppretter med `pg_monitor` + `pg_signal_backend` - se docs/runbooks/POSTGRES_OPS.md), ALDRI app-poolen
 * (`jarvis_runtime`) og aldri superbrukeren.
 *
 * MÅL-MODELL («kun mot tenant-eide mål», fail-closed i alle retninger):
 *  - Klasse D (terminate/cancel/vacuum) krever at databasen står EKSAKT i `JARVIS_POSTGRES_OPS_DATABASES` (typisk bare Jarvis-databasen). Tom liste = ingen
 *    skriving. Infisical- og Langfuse-databasene (`infisical`/`langfuse`, tredjeparts-eide) står ikke der med mindre eieren selv legger dem inn.
 *  - Lesing er alltid tillatt for databasen i tilkoblingsstrengen + de autoriserte; spørringstekst vises KUN for økter i slike databaser.
 *  - En backend nås bare med BÅDE pid OG `backend_start` (pid-gjenbruk mellom listing og handling kan ellers ramme en uskyldig økt), og transporten
 *    nekter superbruker-økter, ikke-klient-økter (autovacuum, WAL-sendere …), egen tilkobling og beskyttede roller.
 *  - VACUUM/ANALYZE rører bare tabeller i `JARVIS_POSTGRES_OPS_SCHEMAS` (standard `public`) som finnes i katalogen - identifikatorer interpoleres aldri uten
 *    streng validering og sitering.
 */

export type PostgresOpsMutationAction = "terminate_backend" | "cancel_query" | "vacuum_analyze";

export const POSTGRES_OPS_MUTATION_ACTIONS: readonly PostgresOpsMutationAction[] = ["terminate_backend", "cancel_query", "vacuum_analyze"];

const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** Mikrosekund-ISO slik transporten leverer `backend_start`/`query_start` (eksakt tekstlikhet, ingen avrunding til ms). */
const PG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MAX_PID = 2_147_483_647;

export interface PostgresOpsConfig {
  /** Databaser Jarvis får utføre klasse D-drift mot (`JARVIS_POSTGRES_OPS_DATABASES`). Tom = ingen skriving. */
  databases: ReadonlySet<string>;
  /** Skjemaer VACUUM/ANALYZE får røre (`JARVIS_POSTGRES_OPS_SCHEMAS`, standard `public`). */
  schemas: ReadonlySet<string>;
  /** Roller hvis forbindelser aldri kan avbrytes/termineres (`JARVIS_POSTGRES_OPS_PROTECTED_ROLES`) - i tillegg til ALLE superbrukere. */
  protectedRoles: ReadonlySet<string>;
}

function parseList(raw: string | undefined | null, pattern: RegExp): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const value = part.trim();
    // En ugyldig enkeltoppføring HOPPES OVER (aldri en løs/gjettet autorisasjon for resten av listen).
    if (value.length > 0 && pattern.test(value)) out.add(value);
  }
  return out;
}

export function parsePostgresOpsConfig(raw: { databases?: string | undefined; schemas?: string | undefined; protectedRoles?: string | undefined } = {}): PostgresOpsConfig {
  const schemas = parseList(raw.schemas, IDENT);
  return {
    databases: parseList(raw.databases, DB_NAME),
    schemas: schemas.size > 0 ? schemas : new Set(["public"]),
    protectedRoles: parseList(raw.protectedRoles, IDENT)
  };
}

function reject(code: string, detail?: unknown): never {
  throw new Error(`postgres_ops_invalid_${code}${detail === undefined ? "" : `:${String(detail).slice(0, 60)}`}`);
}

export function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PID;
}

export function assertPid(value: unknown): number {
  if (!isPid(value)) reject("pid", value);
  return value as number;
}

export function isPgTimestamp(value: unknown): value is string {
  return typeof value === "string" && PG_TS.test(value) && !Number.isNaN(Date.parse(value));
}

export function assertPgTimestamp(value: unknown, label: string): string {
  if (!isPgTimestamp(value)) reject(label, typeof value === "string" ? value.slice(0, 40) : typeof value);
  return value as string;
}

export function assertDatabaseName(value: unknown): string {
  if (typeof value !== "string" || !DB_NAME.test(value)) reject("database", typeof value === "string" ? value.slice(0, 40) : typeof value);
  return value as string;
}

export function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) reject(label, typeof value === "string" ? value.slice(0, 40) : typeof value);
  return value as string;
}

/** Siterer en (allerede validert) identifikator. Valideringen avviser `"`, så doblingen er et ekstra belte. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export interface PostgresOpsTargetAuthorization {
  allowed: boolean;
  reason: string;
}

/**
 * Fail-closed: ugyldige inndata -> nektet; database/skjema utenfor eierens liste -> nektet; ellers tillatt. Kjøres av `ToolGateway.execute()` FØR noen I/O
 * (transporten kontrollerer i tillegg selve økten/tabellen mot katalogen).
 */
export function authorizePostgresOpsTarget(
  action: PostgresOpsMutationAction,
  parameters: Record<string, unknown>,
  config: PostgresOpsConfig
): PostgresOpsTargetAuthorization {
  if (!POSTGRES_OPS_MUTATION_ACTIONS.includes(action)) return { allowed: false, reason: "postgres_ops_action_unknown" };
  const database = parameters["database"];
  if (typeof database !== "string" || !DB_NAME.test(database)) return { allowed: false, reason: "missing_or_invalid_database" };
  if (!config.databases.has(database)) return { allowed: false, reason: "postgres_database_not_authorized" };
  if (action === "vacuum_analyze") {
    const schema = parameters["schema"];
    const table = parameters["table"];
    if (typeof schema !== "string" || !IDENT.test(schema)) return { allowed: false, reason: "missing_or_invalid_schema" };
    if (!config.schemas.has(schema)) return { allowed: false, reason: "postgres_schema_not_authorized" };
    if (typeof table !== "string" || !IDENT.test(table)) return { allowed: false, reason: "missing_or_invalid_table" };
    return { allowed: true, reason: "owner_configured_database_and_schema" };
  }
  if (!isPid(parameters["pid"])) return { allowed: false, reason: "missing_or_invalid_pid" };
  if (!isPgTimestamp(parameters["backend_start"])) return { allowed: false, reason: "missing_or_invalid_backend_start" };
  if (action === "cancel_query" && !isPgTimestamp(parameters["query_start"])) return { allowed: false, reason: "missing_or_invalid_query_start" };
  return { allowed: true, reason: "owner_configured_database" };
}

/**
 * Tilkoblingsstrengen er en HEMMELIGHET (inneholder passord) og leses bare fra credential-kjeden. Her valideres kun formen, og databasenavnet hentes ut
 * (aldri passordet). Avviser alt som ikke er en ren `postgres(ql)://`-URL.
 */
export function parsePostgresOpsDsn(dsn: string): { database: string; host: string } {
  if (typeof dsn !== "string" || !/^postgres(?:ql)?:\/\//i.test(dsn)) throw new Error("postgres_ops_dsn_invalid");
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("postgres_ops_dsn_invalid");
  }
  // Egne tilkoblingsparametre (options=-c …, application_name, sslrootcert=fil …) kunne endre økten under oss - kun passordløse standardfelt støttes.
  if (url.search.length > 0 && /[?&](options|application_name|search_path|target_session_attrs|passfile|service)=/i.test(url.search)) throw new Error("postgres_ops_dsn_unsupported_parameter");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DB_NAME.test(database)) throw new Error("postgres_ops_dsn_database_invalid");
  if (url.hostname.length === 0) throw new Error("postgres_ops_dsn_invalid");
  return { database, host: url.hostname };
}

/**
 * Spørringstekst er fritekst fra applikasjonen og kan inneholde DATA (kundenavn, e-post, tokens i literaler). For diagnostikk vises derfor KUN strukturen:
 * kommentarer fjernes, streng-/dollar-siterte literaler og tall erstattes med `?`, IN-lister slås sammen, tekst avkortes - og resultatet går i tillegg
 * gjennom den sentrale hemmelighetsskanneren. Deterministisk og tapsbringende med vilje.
 */
export function normalizeSqlForDiagnostics(sql: string | null | undefined, max = 200): string | null {
  if (sql === null || sql === undefined) return null;
  if (sql.startsWith("<")) return sql.slice(0, 40); // «<insufficient privilege>» o.l.
  let text = sql;
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/--[^\n\r]*/g, " ");
  text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "?");
  // E'…' kan inneholde \' (escapet sitat) - egen regel FØRST, ellers lekker halen av literalen.
  text = text.replace(/[eE]'(?:[^'\\]|\\[\s\S]|'')*'/g, "?");
  text = text.replace(/[bBxXnN]?'(?:[^']|'')*'/g, "?");
  // Et sitat som fortsatt står igjen betyr en literal vi ikke kunne avgrense sikkert (f.eks. standard_conforming_strings=off): kutt alt fra første sitat - aldri vis halen.
  const stray = text.indexOf("'");
  if (stray >= 0) text = `${text.slice(0, stray)}?`;
  text = text.replace(/\b0[xX][0-9A-Fa-f]+\b/g, "?");
  text = text.replace(/(?<![\w$.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$])/g, "?");
  text = text.replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)");
  text = text.replace(/\s+/g, " ").trim();
  const scanned = scanForSecrets(text).text;
  return scanned.length > max ? `${scanned.slice(0, max)}…` : scanned;
}

export type PostgresOpsCapabilityStatus = "IMPLEMENTED" | "PARTIAL" | "DEFERRED";

export interface PostgresOpsCapability {
  capability: string;
  status: PostgresOpsCapabilityStatus;
  /** Risikoklasse for handlingen (A-D) - styrer HVORDAN den utføres, aldri OM eieren har kapabiliteten (D-41). */
  risk: "A" | "B" | "C" | "D" | "-";
  /** Nødvendig databaserolle-medlemskap/privilegium for ops-rollen. */
  privilege: string;
  note: string;
}

/**
 * D-41-matrise (regel 11): hver kapabilitet er bygget, delvis bygget eller eksplisitt DEFERRED med begrunnelse. Postgres er dokumentert i sin egen manual
 * (predefinerte roller `pg_monitor`/`pg_signal_backend`, `pg_terminate_backend`, VACUUM); testet mot EKTE Postgres 16 (embedded) som minste-privilegium-rolle.
 */
export const POSTGRES_OPS_CAPABILITIES: readonly PostgresOpsCapability[] = [
  { capability: "Tilkoblinger: antall per tilstand/database/rolle/applikasjon mot max_connections", status: "IMPLEMENTED", risk: "A", privilege: "pg_monitor", note: "uten pg_monitor ser rollen bare egne økter (visibility=limited meldes)" },
  { capability: "Lange spørringer og åpne transaksjoner (varighet, ventehendelse, normalisert spørringstekst)", status: "IMPLEMENTED", risk: "A", privilege: "pg_monitor", note: "literaler fjernes og teksten avkortes; kun økter i autoriserte databaser får tekst" },
  { capability: "Låser: hvem blokkerer hvem (pg_blocking_pids)", status: "IMPLEMENTED", risk: "A", privilege: "pg_monitor", note: "" },
  { capability: "Tabellstørrelse og bloat-estimat (døde tupler / levende, siste vacuum/analyze)", status: "PARTIAL", risk: "A", privilege: "pg_monitor", note: "bloat er et ESTIMAT fra pg_stat_user_tables (ikke byte-nøyaktig); pgstattuple kreves for eksakt tall og er ikke installert" },
  { capability: "Replikasjonsstatus (pg_stat_replication, slots, WAL-mottaker)", status: "IMPLEMENTED", risk: "A", privilege: "pg_monitor", note: "enkelt-node-oppsett (NAS) viser ingen replikaer - det er et gyldig, ikke et feil, svar" },
  { capability: "Migrasjonstilstand (anvendt/ventende/endret sjekksum/ukjent) via planMigrations", status: "IMPLEMENTED", risk: "A", privilege: "SELECT på schema_migrations", note: "skrivebeskyttet - endrer aldri schema_migrations" },
  { capability: "Avbryt spørring (pg_cancel_backend) på en identifisert økt", status: "IMPLEMENTED", risk: "D", privilege: "pg_signal_backend", note: "krever pid + backend_start + query_start fra en fersk listing; ingen reversering (klienten kan prøve på nytt)" },
  { capability: "Terminer økt (pg_terminate_backend) på en identifisert økt", status: "IMPLEMENTED", risk: "D", privilege: "pg_signal_backend", note: "krever pid + backend_start fra en fersk listing; nekter superbruker-/ikke-klient-/egen/beskyttet økt; ingen reversering (applikasjonen kobler til på nytt)" },
  { capability: "VACUUM (ANALYZE) / ANALYZE på én navngitt tabell i autorisert skjema", status: "PARTIAL", risk: "D", privilege: "eier av tabellen (PG16 har ingen pg_maintain)", note: "bygget og testet, men FORUTSETTER at ops-rollen eier tabellen: i standardoppsettet (tabeller eid av admin-rollen) hopper Postgres over VACUUM med en advarsel, og verktøyet rapporterer postgres_vacuum_skipped_insufficient_privilege (aldri en påstått suksess). Eierskifte er en eierbeslutning - se docs/runbooks/POSTGRES_OPS.md. Tar kun SHARE UPDATE EXCLUSIVE-lås (blokkerer ikke lesing/skriving)" },
  { capability: "VACUUM FULL, REINDEX, CLUSTER, DDL, ALTER SYSTEM, rolle-/privilegiestyring, slette replikasjonsslot", status: "DEFERRED", risk: "-", privilege: "(eier/superbruker)", note: "tar ACCESS EXCLUSIVE-lås (nedetid) eller er irreversible; krever vedlikeholdsvindu og egen eierbeslutning - aldri autonomt" },
  { capability: "Terminere/avbryte økter i databaser eieren ikke har autorisert (infisical, langfuse …)", status: "DEFERRED", risk: "-", privilege: "-", note: "tredjeparts-eide databaser er bevisst utenfor «tenant-eide mål»; eieren kan legge dem i JARVIS_POSTGRES_OPS_DATABASES" },
  { capability: "Backup/restore", status: "DEFERRED", risk: "-", privilege: "-", note: "dekkes av ops/backup (WP-C2) og BACKUP_RESTORE_RUNBOOK.md, ikke av dette verktøyet" }
];
