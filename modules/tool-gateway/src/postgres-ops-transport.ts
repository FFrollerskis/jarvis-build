import pg from "pg";
import type { JsonValue } from "@jarvis/contracts";
import { planMigrations } from "@jarvis/core";
import type { ToolTransport } from "./gateway.ts";
import {
  assertDatabaseName,
  assertIdentifier,
  assertPgTimestamp,
  assertPid,
  normalizeSqlForDiagnostics,
  parsePostgresOpsDsn,
  quoteIdent,
  type PostgresOpsConfig
} from "./postgres-ops-target-policy.ts";

/**
 * WP-E1 (UA-5): Postgres-DRIFT som kontrollert mål - diagnostikk (klasse A) og tre smale klasse D-handlinger (terminate / cancel / VACUUM-ANALYZE) mot Jarvis'
 * EGEN database. Ingen SDK utover `pg` (allerede i bruk); egen, kortlevd tilkobling per kall med den dedikerte ops-rollen (`JARVIS_POSTGRES_OPS_URL`).
 *
 * SIKKERHET (ufravikelig):
 *  - Credential (tilkoblingsstrengen) KUN som parameter fra `ToolGateway` - aldri logget, aldri i feilmeldinger (vaskes, og passordet vaskes separat), aldri til modellen.
 *  - Økt-handlinger rammer en økt KUN når pid + backend_start (+ query_start for cancel) + database stemmer, og samme betingelser sitter i ÉN atomisk
 *    SQL-setning sammen med nektelsene (superbruker, ikke-klient, egen tilkobling, beskyttet rolle) - det finnes intet vindu mellom «sjekk» og «handling».
 *  - Spørringstekst normaliseres (literaler fjernes, avkortes) og vises kun for økter i databaser eieren har autorisert/lest (`readable`); alle andre får ingen tekst.
 *  - VACUUM/ANALYZE: identifikatorer valideres, slås opp i katalogen og siteres - aldri en rå interpolasjon. Kun `VACUUM (ANALYZE)`/`ANALYZE` (SHARE UPDATE
 *    EXCLUSIVE; blokkerer ikke lesing/skriving). `VACUUM FULL`/`REINDEX`/`CLUSTER` er DEFERRED (ACCESS EXCLUSIVE = nedetid).
 *  - Mål-AUTORISASJON (database/skjema i eierens lister) håndheves av `ToolGateway` via `parameterAuthorizer` (se postgres-ops-target-policy.ts), ikke her; transporten
 *    kontrollerer likevel databasen mot listen som forsvar i dybden.
 *  - Økt-guardrails per tilkobling: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `application_name = jarvis-ops`.
 */

/** Bevisste, forklarbare feil (nektelser/ugyldig mål) - sendes videre uendret; alt annet fra `pg` passerer `mapError` og vaskes. */
export class PostgresOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresOpsError";
  }
}

export interface PgOpsClient {
  /** `pg.Client` er en EventEmitter - VACUUM på en tabell rollen ikke eier gir bare en NOTICE/WARNING (ingen feil), som må fanges. */
  on?(event: "notice", listener: (notice: { message?: string }) => void): unknown;
  connect(): Promise<unknown>;
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export interface PostgresOpsTransportOptions {
  config: PostgresOpsConfig;
  /** Testsøm. Standard: `pg.Client` mot tilkoblingsstrengen med korte tidsavbrudd. */
  createClient?: (dsn: string) => PgOpsClient;
}

const CONNECT_TIMEOUT_MS = 5_000;
const READ_STATEMENT_TIMEOUT_MS = 20_000;
const VACUUM_STATEMENT_TIMEOUT_MS = 280_000;
const MAX_ROWS = 50;

function defaultClient(dsn: string): PgOpsClient {
  const client = new pg.Client({
    connectionString: dsn, application_name: "jarvis-ops", connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: VACUUM_STATEMENT_TIMEOUT_MS + 10_000, query_timeout: VACUUM_STATEMENT_TIMEOUT_MS + 15_000
  });
  // En tilkobling som dør mellom spørringer skal aldri bli en ubehandlet feil i prosessen.
  client.on("error", () => undefined);
  return client as unknown as PgOpsClient;
}

const PG_TS = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round1 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const json = (v: unknown): JsonValue => v as JsonValue;

/** Vasker credential og passord ut av en feiltekst. */
function scrub(text: string, dsn: string): string {
  let out = text;
  if (dsn.length >= 8) out = out.split(dsn).join("[REDACTED]");
  try {
    const password = decodeURIComponent(new URL(dsn).password);
    if (password.length >= 4) out = out.split(password).join("[REDACTED]");
  } catch {
    // ugyldig DSN er allerede avvist før vi kommer hit
  }
  return out;
}

/** SQLSTATE-klasser vi kan forklare uten å lekke detaljer; alt annet blir en kort, vasket kode. */
function mapError(err: unknown, dsn: string): Error {
  if (err instanceof PostgresOpsError || (err instanceof Error && /^postgres_ops_invalid_/.test(err.message))) return err;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = scrub(typeof e.message === "string" ? e.message : String(err), dsn).replace(/\s+/g, " ").slice(0, 120);
  if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN)$/.test(code) || /timeout exceeded when trying to connect|Connection terminated/i.test(message)) {
    return new Error(`postgres_ops_unreachable:${code || "connect"}`);
  }
  if (code === "28P01" || code === "28000") return new Error("postgres_ops_auth_failed");
  if (code === "42501") return new Error(`postgres_ops_insufficient_privilege:${message}`);
  if (code === "57014") return new Error("postgres_ops_statement_timeout");
  if (code === "55P03") return new Error("postgres_ops_lock_timeout");
  return new Error(`postgres_ops_error:${code || "unknown"}:${message}`);
}

interface Session {
  visibility: "full" | "limited";
  me: string;
  database: string;
  isSuper: boolean;
}

interface BackendRow {
  pid: number;
  datname: string | null;
  usename: string | null;
  application_name: string | null;
  backend_type: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_start: string | null;
  query_start: string | null;
  xact_start: string | null;
  duration_s: number | string | null;
  xact_age_s: number | string | null;
  query: string | null;
  is_superuser: boolean | null;
}

export class PostgresOpsTransport implements ToolTransport {
  constructor(private readonly options: PostgresOpsTransportOptions) {}

  private get config(): PostgresOpsConfig {
    return this.options.config;
  }

  private async withClient<T>(dsn: string, statementTimeoutMs: number, fn: (client: PgOpsClient, session: Session, dsnDatabase: string) => Promise<T>): Promise<T> {
    const { database: dsnDatabase } = parsePostgresOpsDsn(dsn);
    const client = (this.options.createClient ?? defaultClient)(dsn);
    try {
      await client.connect();
      await client.query(`SET statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
      await client.query("SET lock_timeout = 5000");
      await client.query("SET idle_in_transaction_session_timeout = 30000");
      const meta = (await client.query<{ me: string; db: string; monitor: boolean; super: boolean }>(
        `SELECT current_user::text AS me, current_database()::text AS db, pg_has_role(current_user, 'pg_monitor', 'MEMBER') AS monitor,
                COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS super`
      )).rows[0]!;
      const session: Session = { visibility: meta.monitor || meta.super ? "full" : "limited", me: meta.me, database: meta.db, isSuper: meta.super };
      return await fn(client, session, dsnDatabase);
    } catch (err) {
      throw mapError(err, dsn);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Databaser der spørringstekst får vises og lesing er «eid»: eierens autoriserte + tilkoblingens egen. */
  private readable(dsnDatabase: string): ReadonlySet<string> {
    return new Set([...this.config.databases, dsnDatabase]);
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    switch (action) {
      case "get_connections": return this.getConnections(credential);
      case "get_long_running_queries": return this.getLongRunning(parameters, credential);
      case "get_locks": return this.getLocks(credential);
      case "get_table_sizes": return this.getTableSizes(parameters, credential);
      case "get_bloat_estimate": return this.getBloat(parameters, credential);
      case "get_replication_status": return this.getReplication(credential);
      case "get_migration_state": return this.getMigrationState(credential);
      case "get_backend": return this.getBackend(parameters, credential);
      case "get_query_state": return this.getQueryState(parameters, credential);
      case "get_table_stats": return this.getTableStats(parameters, credential);
      case "terminate_backend": return this.terminateBackend(parameters, credential);
      case "cancel_query": return this.cancelQuery(parameters, credential);
      case "vacuum_analyze": return this.vacuumAnalyze(parameters, credential);
      default: throw new PostgresOpsError(`postgres_ops_unsupported_action_${action}`);
    }
  }

  // ---------------------------------------------------------------- diagnostikk (klasse A)

  private getConnections(dsn: string): Promise<{ data: JsonValue }> {
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session) => {
      const max = num((await client.query<{ n: string }>("SELECT current_setting('max_connections') AS n")).rows[0]!.n) ?? 0;
      const rows = (await client.query<{ datname: string | null; usename: string | null; application_name: string | null; state: string | null; n: number }>(
        `SELECT datname, usename, application_name, state, count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2, 3, 4`
      )).rows;
      const by = (key: "datname" | "usename" | "application_name" | "state"): Array<{ name: string; count: number }> => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(r[key] ?? "(ingen)", (m.get(r[key] ?? "(ingen)") ?? 0) + r.n);
        return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 20);
      };
      const total = rows.reduce((s, r) => s + r.n, 0);
      return {
        data: json({
          visibility: session.visibility, connected_as: session.me, database: session.database, max_connections: max, client_backends: total,
          utilization_pct: max > 0 ? Math.round((total / max) * 1000) / 10 : null,
          by_state: by("state"), by_database: by("datname"), by_role: by("usename"), by_application: by("application_name")
        })
      };
    });
  }

  private backendSelect(extraWhere: string, limit: number): string {
    return `SELECT a.pid::int AS pid, a.datname::text AS datname, a.usename::text AS usename, a.application_name::text AS application_name, a.backend_type::text AS backend_type,
                   a.state::text AS state, a.wait_event_type::text AS wait_event_type, a.wait_event::text AS wait_event,
                   ${PG_TS("a.backend_start")} AS backend_start, ${PG_TS("a.query_start")} AS query_start, ${PG_TS("a.xact_start")} AS xact_start,
                   EXTRACT(EPOCH FROM (now() - COALESCE(a.query_start, a.state_change)))::float8 AS duration_s,
                   EXTRACT(EPOCH FROM (now() - a.xact_start))::float8 AS xact_age_s,
                   a.query::text AS query, COALESCE(r.rolsuper, false) AS is_superuser
              FROM pg_stat_activity a LEFT JOIN pg_roles r ON r.rolname = a.usename
             WHERE ${extraWhere}
             ORDER BY duration_s DESC NULLS LAST
             LIMIT ${limit}`;
  }

  private view(row: BackendRow, readable: ReadonlySet<string>): Record<string, JsonValue> {
    const owned = row.datname !== null && readable.has(row.datname);
    const eligible = row.datname !== null && this.config.databases.has(row.datname) && row.backend_type === "client backend" && row.is_superuser !== true
      && !(row.usename !== null && this.config.protectedRoles.has(row.usename));
    return {
      pid: row.pid, database: row.datname, role: row.usename, application_name: row.application_name, backend_type: row.backend_type, state: row.state,
      wait_event_type: row.wait_event_type, wait_event: row.wait_event, backend_start: row.backend_start, query_start: row.query_start, xact_start: row.xact_start,
      duration_s: round1(row.duration_s), xact_age_s: round1(row.xact_age_s), is_superuser: row.is_superuser === true,
      // Tekst KUN for økter i databaser eieren eier/leser - og aldri uten normalisering.
      query: owned ? normalizeSqlForDiagnostics(row.query) : null,
      eligible_for_mutation: eligible
    };
  }

  private getLongRunning(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const minSeconds = parameters["min_seconds"] === undefined ? 30 : parameters["min_seconds"];
    const limit = parameters["limit"] === undefined ? 20 : parameters["limit"];
    if (typeof minSeconds !== "number" || !Number.isFinite(minSeconds) || minSeconds < 1 || minSeconds > 86_400) throw new PostgresOpsError("postgres_ops_invalid_min_seconds");
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new PostgresOpsError("postgres_ops_invalid_limit");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session, dsnDatabase) => {
      const rows = (await client.query<BackendRow>(
        this.backendSelect(
          `a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
           AND ((a.state = 'active' AND now() - a.query_start > make_interval(secs => $1))
             OR (a.state LIKE 'idle in transaction%' AND now() - a.state_change > make_interval(secs => $1)))`, limit),
        [minSeconds]
      )).rows;
      const readable = this.readable(dsnDatabase);
      return { data: json({ visibility: session.visibility, min_seconds: minSeconds, count: rows.length, backends: rows.map((r) => this.view(r, readable)) }) };
    });
  }

  private getLocks(dsn: string): Promise<{ data: JsonValue }> {
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session, dsnDatabase) => {
      const rows = (await client.query<{
        blocked_pid: number; blocked_user: string | null; blocked_db: string | null; blocked_for_s: number | null; wait_event_type: string | null; wait_event: string | null; blocked_query: string | null;
        blocking_pid: number; blocking_user: string | null; blocking_state: string | null; blocking_query: string | null; blocking_xact_age_s: number | null;
      }>(
        `SELECT blocked.pid::int AS blocked_pid, blocked.usename::text AS blocked_user, blocked.datname::text AS blocked_db,
                EXTRACT(EPOCH FROM (now() - blocked.query_start))::float8 AS blocked_for_s, blocked.wait_event_type::text AS wait_event_type, blocked.wait_event::text AS wait_event,
                blocked.query::text AS blocked_query,
                blocking.pid::int AS blocking_pid, blocking.usename::text AS blocking_user, blocking.state::text AS blocking_state, blocking.query::text AS blocking_query,
                EXTRACT(EPOCH FROM (now() - blocking.xact_start))::float8 AS blocking_xact_age_s
           FROM pg_stat_activity blocked
           CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp(pid)
           JOIN pg_stat_activity blocking ON blocking.pid = bp.pid
          WHERE blocked.backend_type = 'client backend'
          ORDER BY blocked_for_s DESC NULLS LAST LIMIT ${MAX_ROWS}`
      )).rows;
      const readable = this.readable(dsnDatabase);
      const text = (db: string | null, sql: string | null): string | null => (db !== null && readable.has(db) ? normalizeSqlForDiagnostics(sql) : null);
      return {
        data: json({
          visibility: session.visibility, count: rows.length,
          blocked: rows.map((r) => ({
            blocked_pid: r.blocked_pid, blocked_role: r.blocked_user, blocked_for_s: round1(r.blocked_for_s), wait_event_type: r.wait_event_type, wait_event: r.wait_event,
            blocked_query: text(r.blocked_db, r.blocked_query),
            blocking_pid: r.blocking_pid, blocking_role: r.blocking_user, blocking_state: r.blocking_state, blocking_xact_age_s: round1(r.blocking_xact_age_s),
            blocking_query: text(r.blocked_db, r.blocking_query)
          }))
        })
      };
    });
  }

  private tableStatsQuery(): string {
    return `SELECT s.schemaname::text AS schema, s.relname::text AS "table", pg_total_relation_size(s.relid)::bigint AS total_bytes, pg_relation_size(s.relid)::bigint AS table_bytes,
                   s.n_live_tup::bigint AS n_live_tup, s.n_dead_tup::bigint AS n_dead_tup,
                   ${PG_TS("s.last_vacuum")} AS last_vacuum, ${PG_TS("s.last_autovacuum")} AS last_autovacuum,
                   ${PG_TS("s.last_analyze")} AS last_analyze, ${PG_TS("s.last_autoanalyze")} AS last_autoanalyze,
                   EXTRACT(EPOCH FROM (now() - GREATEST(s.last_vacuum, s.last_autovacuum)))::float8 AS seconds_since_vacuum,
                   EXTRACT(EPOCH FROM (now() - GREATEST(s.last_analyze, s.last_autoanalyze)))::float8 AS seconds_since_analyze
              FROM pg_stat_user_tables s`;
  }

  private tableView(r: Record<string, unknown>): Record<string, JsonValue> {
    const live = num(r["n_live_tup"]) ?? 0;
    const dead = num(r["n_dead_tup"]) ?? 0;
    return {
      schema: r["schema"] as string, table: r["table"] as string, total_bytes: num(r["total_bytes"]), table_bytes: num(r["table_bytes"]),
      n_live_tup: live, n_dead_tup: dead, dead_ratio: live + dead > 0 ? Math.round((dead / (live + dead)) * 1000) / 1000 : 0,
      last_vacuum: (r["last_vacuum"] as string | null) ?? null, last_autovacuum: (r["last_autovacuum"] as string | null) ?? null,
      last_analyze: (r["last_analyze"] as string | null) ?? null, last_autoanalyze: (r["last_autoanalyze"] as string | null) ?? null,
      seconds_since_vacuum: round1(r["seconds_since_vacuum"]), seconds_since_analyze: round1(r["seconds_since_analyze"])
    };
  }

  private getTableSizes(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const limit = parameters["limit"] === undefined ? 20 : parameters["limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new PostgresOpsError("postgres_ops_invalid_limit");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session) => {
      const rows = (await client.query<Record<string, unknown>>(`${this.tableStatsQuery()} ORDER BY total_bytes DESC, s.relname LIMIT ${limit}`)).rows;
      return { data: json({ database: session.database, count: rows.length, tables: rows.map((r) => this.tableView(r)) }) };
    });
  }

  private getBloat(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const limit = parameters["limit"] === undefined ? 20 : parameters["limit"];
    const minDead = parameters["min_dead_tuples"] === undefined ? 1000 : parameters["min_dead_tuples"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new PostgresOpsError("postgres_ops_invalid_limit");
    if (typeof minDead !== "number" || !Number.isInteger(minDead) || minDead < 0 || minDead > 1_000_000_000) throw new PostgresOpsError("postgres_ops_invalid_min_dead_tuples");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session) => {
      const rows = (await client.query<Record<string, unknown>>(
        `${this.tableStatsQuery()} WHERE s.n_dead_tup >= $1 ORDER BY (s.n_dead_tup::float8 / GREATEST(s.n_live_tup + s.n_dead_tup, 1)) DESC, s.n_dead_tup DESC LIMIT ${limit}`, [minDead]
      )).rows;
      return {
        data: json({
          database: session.database, estimate: true, method: "pg_stat_user_tables.n_dead_tup / (n_live_tup + n_dead_tup) - estimat, ikke byte-nøyaktig bloat",
          min_dead_tuples: minDead, count: rows.length, tables: rows.map((r) => this.tableView(r))
        })
      };
    });
  }

  private getReplication(dsn: string): Promise<{ data: JsonValue }> {
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, session) => {
      const inRecovery = (await client.query<{ r: boolean }>("SELECT pg_is_in_recovery() AS r")).rows[0]!.r;
      const senders = (await client.query<{ application_name: string | null; state: string | null; sync_state: string | null; replay_lag_s: number | null; replay_gap_bytes: string | null }>(
        `SELECT application_name::text, state::text, sync_state::text, EXTRACT(EPOCH FROM replay_lag)::float8 AS replay_lag_s,
                pg_wal_lsn_diff(sent_lsn, replay_lsn)::bigint AS replay_gap_bytes FROM pg_stat_replication ORDER BY application_name LIMIT ${MAX_ROWS}`
      )).rows;
      const slots = (await client.query<{ slot_name: string; slot_type: string; active: boolean; retained_bytes: string | null }>(
        `SELECT slot_name::text, slot_type::text, active,
                pg_wal_lsn_diff(CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END, restart_lsn)::bigint AS retained_bytes
           FROM pg_replication_slots ORDER BY slot_name LIMIT ${MAX_ROWS}`
      )).rows;
      let receiver: Record<string, JsonValue> | null = null;
      if (inRecovery) {
        const w = (await client.query<{ status: string | null; since_last_msg_s: number | null }>(
          "SELECT status::text, EXTRACT(EPOCH FROM (now() - latest_end_time))::float8 AS since_last_msg_s FROM pg_stat_wal_receiver LIMIT 1"
        )).rows[0];
        receiver = w ? { status: w.status, since_last_msg_s: round1(w.since_last_msg_s) } : null;
      }
      return {
        data: json({
          visibility: session.visibility, role: inRecovery ? "standby" : "primary", replicas: senders.length,
          senders: senders.map((s) => ({ application_name: s.application_name, state: s.state, sync_state: s.sync_state, replay_lag_s: round1(s.replay_lag_s), replay_gap_bytes: num(s.replay_gap_bytes) })),
          slots: slots.map((s) => ({ slot_name: s.slot_name, slot_type: s.slot_type, active: s.active, retained_bytes: num(s.retained_bytes) })),
          wal_receiver: receiver,
          note: inRecovery || senders.length > 0 ? null : "ingen replikaer tilkoblet (enkelt-node er et gyldig oppsett)"
        })
      };
    });
  }

  private getMigrationState(dsn: string): Promise<{ data: JsonValue }> {
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client) => {
      const exists = (await client.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present")).rows[0]!.present;
      if (!exists) return { data: json({ initialized: false, in_sync: false, applied: 0, pending_count: null, pending: [], checksum_mismatches: [], unknown_applied: [], latest: null }) };
      // `planMigrations` er skrivebeskyttet og trenger bare `.query` - en enkelt klient duger like godt som en pool.
      const plan = await planMigrations({ query: (sql: string, params?: unknown[]) => client.query(sql, params) } as unknown as pg.Pool);
      const latest = (await client.query<{ name: string; applied_at: string }>(`SELECT name::text, ${PG_TS("applied_at")} AS applied_at FROM schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1`)).rows[0] ?? null;
      return {
        data: json({
          initialized: true, applied: plan.applied, pending_count: plan.pending.length, pending: plan.pending.slice(0, 20),
          checksum_mismatches: plan.checksum_mismatches.slice(0, 20), missing_checksum_count: plan.missing_checksum.length, unknown_applied: plan.unknown_applied.slice(0, 20),
          in_sync: plan.pending.length === 0 && plan.checksum_mismatches.length === 0 && plan.unknown_applied.length === 0, latest
        })
      };
    });
  }

  // ---------------------------------------------------------------- mål-oppslag (preflight/readback)

  private async fetchBackend(client: PgOpsClient, pid: number, database: string, backendStart: string): Promise<BackendRow | null> {
    const rows = (await client.query<BackendRow>(
      this.backendSelect("a.pid = $1 AND a.pid <> pg_backend_pid() AND a.datname = $2 AND a.backend_start = $3::timestamptz", 1), [pid, database, backendStart]
    )).rows;
    return rows[0] ?? null;
  }

  private async getBackend(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const pid = assertPid(parameters["pid"]);
    const database = assertDatabaseName(parameters["database"]);
    const backendStart = assertPgTimestamp(parameters["backend_start"], "backend_start");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, _s, dsnDatabase) => {
      const row = await this.fetchBackend(client, pid, database, backendStart);
      return { data: row === null ? null : json(this.view(row, this.readable(dsnDatabase))) };
    });
  }

  /** Alltid et objekt (også når økten er borte): readback for `cancel_query`, der «borte» er en gyldig etter-tilstand. */
  private async getQueryState(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const pid = assertPid(parameters["pid"]);
    const database = assertDatabaseName(parameters["database"]);
    const backendStart = assertPgTimestamp(parameters["backend_start"], "backend_start");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, _s, dsnDatabase) => {
      const row = await this.fetchBackend(client, pid, database, backendStart);
      return { data: json(row === null ? { present: false } : { present: true, ...this.view(row, this.readable(dsnDatabase)) }) };
    });
  }

  private async getTableStats(parameters: Record<string, JsonValue>, dsn: string): Promise<{ data: JsonValue }> {
    const database = assertDatabaseName(parameters["database"]);
    const schema = assertIdentifier(parameters["schema"], "schema");
    const table = assertIdentifier(parameters["table"], "table");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client, _s, dsnDatabase) => {
      if (database !== dsnDatabase) throw new PostgresOpsError("postgres_ops_database_mismatch");
      const rows = (await client.query<Record<string, unknown>>(`${this.tableStatsQuery()} WHERE s.schemaname = $1 AND s.relname = $2`, [schema, table])).rows;
      return { data: rows[0] ? json(this.tableView(rows[0])) : null };
    });
  }

  // ---------------------------------------------------------------- klasse D

  /** Grunnen til at en økt ikke kan rammes, i prioritert rekkefølge - gir en presis feil før den atomiske setningen (som selv alltid har siste ord). */
  private ineligibleReason(row: BackendRow | null, database: string): string | null {
    if (row === null) return "postgres_backend_not_found";
    if (row.backend_type !== "client backend") return "postgres_backend_not_client";
    if (row.datname === null || row.datname !== database || !this.config.databases.has(row.datname)) return "postgres_database_not_authorized";
    if (row.is_superuser === true) return "postgres_backend_superuser_protected";
    if (row.usename !== null && this.config.protectedRoles.has(row.usename)) return "postgres_backend_role_protected";
    return null;
  }

  private protectedRolesParam(): string[] {
    return [...this.config.protectedRoles];
  }

  private async terminateBackend(parameters: Record<string, JsonValue>, dsn: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const pid = assertPid(parameters["pid"]);
    const database = assertDatabaseName(parameters["database"]);
    const backendStart = assertPgTimestamp(parameters["backend_start"], "backend_start");
    if (!this.config.databases.has(database)) throw new PostgresOpsError("postgres_database_not_authorized");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client) => {
      const reason = this.ineligibleReason(await this.fetchBackend(client, pid, database, backendStart), database);
      if (reason !== null) throw new PostgresOpsError(reason);
      // ÉN atomisk setning: identitet (pid + backend_start + database) og nektelsene avgjøres av SAMME øyeblikksbilde som signalet sendes fra.
      const res = await client.query<{ ok: boolean }>(
        `SELECT pg_terminate_backend(a.pid) AS ok
           FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
          WHERE a.pid = $1 AND a.pid <> pg_backend_pid() AND a.datname = $2 AND a.backend_start = $3::timestamptz
            AND a.backend_type = 'client backend' AND NOT r.rolsuper AND NOT (a.usename = ANY($4::text[]))`,
        [pid, database, backendStart, this.protectedRolesParam()]
      );
      if (res.rows.length === 0) throw new PostgresOpsError("postgres_backend_changed");
      if (res.rows[0]!.ok !== true) throw new PostgresOpsError("postgres_terminate_not_delivered");
      return { external_id: `pid:${pid}`, data: json({ signalled: true, pid, database }) };
    });
  }

  private async cancelQuery(parameters: Record<string, JsonValue>, dsn: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const pid = assertPid(parameters["pid"]);
    const database = assertDatabaseName(parameters["database"]);
    const backendStart = assertPgTimestamp(parameters["backend_start"], "backend_start");
    const queryStart = assertPgTimestamp(parameters["query_start"], "query_start");
    if (!this.config.databases.has(database)) throw new PostgresOpsError("postgres_database_not_authorized");
    return this.withClient(dsn, READ_STATEMENT_TIMEOUT_MS, async (client) => {
      const row = await this.fetchBackend(client, pid, database, backendStart);
      const reason = this.ineligibleReason(row, database);
      if (reason !== null) throw new PostgresOpsError(reason);
      if (row!.state !== "active") throw new PostgresOpsError("postgres_backend_not_active");
      // Kun SPØRRINGEN som ble inspisert avbrytes: en økt som har begynt på en ny spørring siden listingen røres ikke.
      const res = await client.query<{ ok: boolean }>(
        `SELECT pg_cancel_backend(a.pid) AS ok
           FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
          WHERE a.pid = $1 AND a.pid <> pg_backend_pid() AND a.datname = $2 AND a.backend_start = $3::timestamptz AND a.query_start = $4::timestamptz AND a.state = 'active'
            AND a.backend_type = 'client backend' AND NOT r.rolsuper AND NOT (a.usename = ANY($5::text[]))`,
        [pid, database, backendStart, queryStart, this.protectedRolesParam()]
      );
      if (res.rows.length === 0) throw new PostgresOpsError("postgres_query_changed");
      if (res.rows[0]!.ok !== true) throw new PostgresOpsError("postgres_cancel_not_delivered");
      return { external_id: `pid:${pid}`, data: json({ signalled: true, pid, database }) };
    });
  }

  private async vacuumAnalyze(parameters: Record<string, JsonValue>, dsn: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const database = assertDatabaseName(parameters["database"]);
    const schema = assertIdentifier(parameters["schema"], "schema");
    const table = assertIdentifier(parameters["table"], "table");
    const analyzeOnly = parameters["analyze_only"] === true;
    if (parameters["analyze_only"] !== undefined && typeof parameters["analyze_only"] !== "boolean") throw new PostgresOpsError("postgres_ops_invalid_analyze_only");
    if (!this.config.databases.has(database)) throw new PostgresOpsError("postgres_database_not_authorized");
    if (!this.config.schemas.has(schema)) throw new PostgresOpsError("postgres_schema_not_authorized");
    return this.withClient(dsn, VACUUM_STATEMENT_TIMEOUT_MS, async (client, _s, dsnDatabase) => {
      // Én tilkobling = én database: VACUUM virker bare i databasen tilkoblingen står i.
      if (database !== dsnDatabase) throw new PostgresOpsError("postgres_ops_database_mismatch");
      const found = (await client.query<{ relkind: string }>(
        `SELECT c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'm')`,
        [schema, table]
      )).rows[0];
      if (!found) throw new PostgresOpsError("postgres_table_not_found");
      const target = `${quoteIdent(schema)}.${quoteIdent(table)}`;
      // Postgres hopper OVER en tabell rollen ikke eier med kun en advarsel («skipping … only table or database owner can vacuum it») - det er IKKE en utført vedlikeholdsjobb.
      const notices: string[] = [];
      client.on?.("notice", (n) => notices.push(String(n.message ?? "").slice(0, 120)));
      await client.query(analyzeOnly ? `ANALYZE ${target}` : `VACUUM (ANALYZE) ${target}`);
      if (notices.some((m) => /skipping/i.test(m))) throw new PostgresOpsError("postgres_vacuum_skipped_insufficient_privilege");
      return { external_id: `${analyzeOnly ? "analyze" : "vacuum"}:${schema}.${table}`, data: json({ done: true, analyze_only: analyzeOnly, schema, table }) };
    });
  }
}
