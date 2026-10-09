import { describe, expect, it } from "vitest";
import {
  POSTGRES_OPS_CAPABILITIES,
  POSTGRES_OPS_MUTATION_ACTIONS,
  assertDatabaseName,
  assertIdentifier,
  assertPgTimestamp,
  assertPid,
  authorizePostgresOpsTarget,
  normalizeSqlForDiagnostics,
  parsePostgresOpsConfig,
  parsePostgresOpsDsn,
  quoteIdent
} from "../src/postgres-ops-target-policy.ts";

/**
 * WP-E1: ren, deterministisk mål-policy for Postgres-drift. Alt her feiler LUKKET: ugyldig inndata, ukjent database/skjema, pid-gjenbruk (backend_start) og
 * lekkasje av data via spørringstekst.
 */
const TS = "2026-10-09T12:00:00.123456Z";
const config = parsePostgresOpsConfig({ databases: "jarvis", schemas: "public", protectedRoles: "jarvis_migrate" });

describe("A: konfig (JARVIS_POSTGRES_OPS_*)", () => {
  it("tom konfig = ingen databaser (ingen skriving) og skjema public som eneste standard", () => {
    const c = parsePostgresOpsConfig();
    expect([...c.databases]).toEqual([]);
    expect([...c.schemas]).toEqual(["public"]);
    expect([...c.protectedRoles]).toEqual([]);
  });

  it("ugyldige enkeltoppføringer hoppes over (aldri en løs autorisasjon), gyldige beholdes", () => {
    const c = parsePostgresOpsConfig({ databases: "jarvis, evil;drop, , -x, ok_db$1", schemas: "app, bad schema, 1abc", protectedRoles: "r1,\"quoted\",r_2" });
    expect([...c.databases].sort()).toEqual(["jarvis", "ok_db$1"]);
    expect([...c.schemas]).toEqual(["app"]);
    expect([...c.protectedRoles].sort()).toEqual(["r1", "r_2"]);
  });
});

describe("B: validatorer", () => {
  it("pid: kun heltall 1..2^31-1", () => {
    expect(assertPid(4242)).toBe(4242);
    for (const bad of [0, -1, 1.5, "12", null, undefined, 2 ** 31, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => assertPid(bad), String(bad)).toThrow(/postgres_ops_invalid_pid/);
  });

  it("backend_start/query_start: kun mikrosekund-ISO i UTC (eksakt tekstlikhet mot serveren)", () => {
    expect(assertPgTimestamp(TS, "backend_start")).toBe(TS);
    expect(assertPgTimestamp("2026-10-09T12:00:00Z", "backend_start")).toBe("2026-10-09T12:00:00Z");
    for (const bad of ["2026-10-09 12:00:00+00", "2026-10-09T12:00:00+02:00", "2026-13-40T99:00:00Z", "'; DROP TABLE x;--", "", 1_760_000_000_000, null]) {
      expect(() => assertPgTimestamp(bad, "backend_start"), String(bad)).toThrow(/postgres_ops_invalid_backend_start/);
    }
  });

  it("database og identifikatorer: lukket tegnsett, ingen siteringstegn/mellomrom/semikolon", () => {
    expect(assertDatabaseName("jarvis")).toBe("jarvis");
    expect(assertIdentifier("my_table$1", "table")).toBe("my_table$1");
    for (const bad of ["", "a b", 'a"b', "a;b", "1abc", "x".repeat(64), "a.b", "--", "a\nb"]) expect(() => assertIdentifier(bad, "table"), bad).toThrow(/postgres_ops_invalid_table/);
    expect(() => assertDatabaseName("a b")).toThrow();
    expect(quoteIdent("tbl")).toBe('"tbl"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("C: mål-autorisasjon (kjøres av ToolGateway FØR noen I/O)", () => {
  const base = { pid: 4242, database: "jarvis", backend_start: TS };

  it("terminate/cancel/vacuum tillates kun med komplette, gyldige parametre i autorisert database/skjema", () => {
    expect(authorizePostgresOpsTarget("terminate_backend", base, config)).toMatchObject({ allowed: true });
    expect(authorizePostgresOpsTarget("cancel_query", { ...base, query_start: TS }, config)).toMatchObject({ allowed: true });
    expect(authorizePostgresOpsTarget("vacuum_analyze", { database: "jarvis", schema: "public", table: "tasks" }, config)).toMatchObject({ allowed: true });
  });

  it("database utenfor eierens liste nektes, også uten konfig (tom liste = ingen skriving)", () => {
    expect(authorizePostgresOpsTarget("terminate_backend", { ...base, database: "infisical" }, config)).toEqual({ allowed: false, reason: "postgres_database_not_authorized" });
    expect(authorizePostgresOpsTarget("terminate_backend", base, parsePostgresOpsConfig())).toEqual({ allowed: false, reason: "postgres_database_not_authorized" });
    expect(authorizePostgresOpsTarget("vacuum_analyze", { database: "langfuse", schema: "public", table: "t" }, config).allowed).toBe(false);
  });

  it("manglende/ugyldig pid, backend_start, query_start, database, skjema og tabell nektes med presis årsak", () => {
    expect(authorizePostgresOpsTarget("terminate_backend", { ...base, pid: "1" }, config).reason).toBe("missing_or_invalid_pid");
    expect(authorizePostgresOpsTarget("terminate_backend", { ...base, backend_start: "i går" }, config).reason).toBe("missing_or_invalid_backend_start");
    expect(authorizePostgresOpsTarget("cancel_query", base, config).reason).toBe("missing_or_invalid_query_start");
    expect(authorizePostgresOpsTarget("terminate_backend", { pid: 1, backend_start: TS }, config).reason).toBe("missing_or_invalid_database");
    expect(authorizePostgresOpsTarget("terminate_backend", { ...base, database: "ja; DROP" }, config).reason).toBe("missing_or_invalid_database");
    expect(authorizePostgresOpsTarget("vacuum_analyze", { database: "jarvis", schema: "pg_catalog", table: "pg_class" }, config).reason).toBe("postgres_schema_not_authorized");
    expect(authorizePostgresOpsTarget("vacuum_analyze", { database: "jarvis", schema: "public", table: 'x"; DROP TABLE y;--' }, config).reason).toBe("missing_or_invalid_table");
    expect(authorizePostgresOpsTarget("vacuum_analyze", { database: "jarvis", schema: "public" }, config).reason).toBe("missing_or_invalid_table");
  });

  it("ukjent handling nektes", () => {
    expect(authorizePostgresOpsTarget("drop_database" as never, base, config)).toEqual({ allowed: false, reason: "postgres_ops_action_unknown" });
    expect(POSTGRES_OPS_MUTATION_ACTIONS).toEqual(["terminate_backend", "cancel_query", "vacuum_analyze"]);
  });
});

describe("D: spørringstekst vises aldri med data", () => {
  it("literaler, tall, kommentarer, dollar-siterte strenger og IN-lister fjernes - strukturen står igjen", () => {
    expect(normalizeSqlForDiagnostics("SELECT * FROM users WHERE email = 'tobias@example.com' AND id = 42 AND score > 3.5")).toBe("SELECT * FROM users WHERE email = ? AND id = ? AND score > ?");
    expect(normalizeSqlForDiagnostics("UPDATE t SET note = $tag$hemmelig tekst$tag$ -- kommentar med token abc\nWHERE id IN (1, 2, 3)")).toBe("UPDATE t SET note = ? WHERE id IN (?)");
    expect(normalizeSqlForDiagnostics("/* trace-id: x */ SELECT 1")).toBe("SELECT ?");
    expect(normalizeSqlForDiagnostics("INSERT INTO m (a) VALUES ('it''s a secret')")).toBe("INSERT INTO m (a) VALUES (?)");
    expect(normalizeSqlForDiagnostics("SELECT * FROM t WHERE id = $1 AND x = E'a\\'b'")).toBe("SELECT * FROM t WHERE id = $1 AND x = ?");
  });

  it("ingen hemmelighet fra literaler overlever, og tekst avkortes", () => {
    const out = normalizeSqlForDiagnostics("SELECT set_config('app.token', 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', false)") ?? "";
    expect(out).not.toContain("sk-ant");
    expect(out).toBe("SELECT set_config(?, ?, false)");
    const long = normalizeSqlForDiagnostics(`SELECT ${"kolonne, ".repeat(100)} FROM t`, 60) ?? "";
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });

  it("null/udefinert gir null, og «<insufficient privilege>» passerer som tekst (ikke en spørring)", () => {
    expect(normalizeSqlForDiagnostics(null)).toBeNull();
    expect(normalizeSqlForDiagnostics(undefined)).toBeNull();
    expect(normalizeSqlForDiagnostics("<insufficient privilege>")).toBe("<insufficient privilege>");
  });
});

describe("E: tilkoblingsstreng (hemmelighet) valideres uten å eksponere passordet", () => {
  it("godtar ren postgres(ql)://-URL og returnerer kun database + vert", () => {
    expect(parsePostgresOpsDsn("postgresql://jarvis_ops:s3cr3tPass@postgres:5432/jarvis")).toEqual({ database: "jarvis", host: "postgres" });
    expect(parsePostgresOpsDsn("postgres://u:p@127.0.0.1/db_1")).toEqual({ database: "db_1", host: "127.0.0.1" });
  });

  it("avviser feil skjema, manglende database og parametre som kan endre økten", () => {
    for (const bad of ["mysql://u:p@h/db", "http://u:p@h/db", "", "postgresql://u:p@h/", "postgresql://u:p@h/db?options=-c%20search_path%3Devil", "postgresql://u:p@h/db?application_name=x", "postgresql://u:p@h/a%20b"]) {
      expect(() => parsePostgresOpsDsn(bad), bad).toThrow(/postgres_ops_dsn/);
    }
  });
});

describe("F: kapabilitetsmatrisen (D-41) er ærlig", () => {
  it("hver rad har klasse og status; de tre D-handlingene er bygget (VACUUM er PARTIAL: krever tabell-eierskap), farlige vedlikeholdsoperasjoner er DEFERRED med begrunnelse", () => {
    const built = POSTGRES_OPS_CAPABILITIES.filter((c) => c.status !== "DEFERRED" && c.risk === "D");
    expect(built).toHaveLength(3);
    expect(built.filter((c) => c.status === "PARTIAL").map((c) => c.capability)).toEqual([expect.stringMatching(/VACUUM/)]);
    expect(built.find((c) => /VACUUM/.test(c.capability))!.note).toMatch(/eier tabellen/);
    const deferred = POSTGRES_OPS_CAPABILITIES.filter((c) => c.status === "DEFERRED");
    expect(deferred.some((c) => /VACUUM FULL/.test(c.capability))).toBe(true);
    for (const c of deferred) expect(c.note.length, c.capability).toBeGreaterThan(20);
  });
});
