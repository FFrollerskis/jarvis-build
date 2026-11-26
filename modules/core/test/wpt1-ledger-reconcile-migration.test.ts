import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, withTenantTransaction } from "../src/index.ts";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-T1 K5 (migrasjon 154, JARVIS-103): ledger-statusene `unknown_outcome`/`needs_resolution`, avstemmings- og avgjørelseskolonnene og databasevernet (trigger `tool_executions_guard`) på en EKSISTERENDE database (rader fra før migrasjonen)
 * og som app-rolle. Bevis: eldre rader er uberørt (alle nye kolonner NULL), CHECK-ene og triggeren håndhever tilstandsmaskinen uavhengig av applikasjonskoden (gulv på alder, riktig utgangsstatus, fullstendig og samsvarende avgjørelse, re-arm
 * nullstiller), de eksisterende overgangene er UENDRET, runtime-rollen får kun de nye kolonnene (aldri identitet/digest/DELETE), tenant-isolasjonen er uendret, og retensjonen sletter aldri de nye statusene.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const DIGEST = "d".repeat(64);
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let applied: string[] = [];
const A = "tenant-t1k5a";
const B = "tenant-t1k5b";
let seq = 0;
const key = (label: string): string => `k5-${label}-${(seq += 1)}`;

beforeAll(async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const legacyDir = await mkdtemp(join(tmpdir(), "jarvis-t1k5-legacy-"));
  const fullDir = await mkdtemp(join(tmpdir(), "jarvis-t1k5-full-"));
  for (const f of files) {
    await copyFile(join(MIGRATIONS_DIR, f), join(fullDir, f));
    if (Number(f.slice(0, 3)) < 154) await copyFile(join(MIGRATIONS_DIR, f), join(legacyDir, f));
  }
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1k5-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);

  // 1) Eksisterende database: alt FØR 154 (inkl. 153), med ledger-rader i alle statuser som fantes da.
  await runMigrations(admin, legacyDir);
  expect(((await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tool_executions' AND column_name = 'status_before_reconcile'`)).rows[0] as { n: number }).n).toBe(0);
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}', 'K5A', 'person'), ('${B}', 'K5B', 'person');
    INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, postcondition_reason, request_digest, executed_at) VALUES
      ('${A}', 'legacy-succeeded', 'calendar', 'create_event', 'succeeded', NULL, '${DIGEST}', now() - interval '90 days'),
      ('${A}', 'legacy-failed', 'calendar', 'create_event', 'failed', 'tool_failed:x', NULL, now() - interval '90 days'),
      ('${A}', 'legacy-unverified', 'email', 'send', 'unverified', 'postcondition_unverified:no_provider_id', NULL, now() - interval '3 days'),
      ('${A}', 'legacy-reserved', 'email', 'send', 'reserved', NULL, NULL, now() - interval '3 days'),
      ('${B}', 'legacy-b', 'calendar', 'create_event', 'succeeded', NULL, NULL, now());
  `);

  // 2) Oppgrader: 154 anvendes på de eksisterende dataene.
  applied = await runMigrations(admin, fullDir);
  await admin.query(`CREATE ROLE jarvis_t1k5 LOGIN PASSWORD 'pw2'`);
  await admin.query(`GRANT jarvis_app TO jarvis_t1k5`);
  app = new pg.Pool({ ...base, user: "jarvis_t1k5", password: "pw2", max: 4 });
  app.on("error", () => undefined);
}, 300_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

type Row = Record<string, unknown>;
const rowOf = async (k: string, tenant = A): Promise<Row> => (await admin.query("SELECT * FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [tenant, k])).rows[0] as Row;
/** Setter inn en rad (administrator: INSERT styres kun av CHECK-ene) med alder i minutter. */
async function insert(k: string, status: string, ageMinutes: number, extra: Record<string, unknown> = {}, tenant = A): Promise<void> {
  const cols: Record<string, unknown> = { tenant_id: tenant, idempotency_key: k, tool_id: "calendar", action: "create_event", status, ...extra };
  const names = Object.keys(cols);
  const values = Object.values(cols);
  await admin.query(
    `INSERT INTO tool_executions (${names.join(", ")}, executed_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}, now() - make_interval(mins => $${names.length + 1}::int))`,
    [...values, ageMinutes]
  );
}
const asApp = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => withTenantTransaction(app, tenant, fn);
/** Sveipets overgang (som app-rollen): `from` -> `to` med avstemmingsfeltene satt. */
const reconcile = (k: string, to: "unknown_outcome" | "needs_resolution", before: "reserved" | "unverified", tenant = A) =>
  asApp(tenant, (c) => c.query(
    `UPDATE tool_executions SET status = $3, status_before_reconcile = $4, reconciled_at = now(), reconcile_basis = 'ttl_exceeded' WHERE tenant_id = $1 AND idempotency_key = $2`, [tenant, k, to, before]
  ));
/** Eierens avgjørelse (som app-rollen). */
const resolve = (k: string, status: string, resolution: string | null, tenant = A, by: string | null = "person-owner", at: "now" | null = "now") =>
  asApp(tenant, (c) => c.query(
    `UPDATE tool_executions SET status = $3, resolved_at = ${at === null ? "NULL" : "now()"}, resolved_by = $4, resolution = $5 WHERE tenant_id = $1 AND idempotency_key = $2`, [tenant, k, status, by, resolution]
  ));
/** En rad som allerede er `unknown_outcome` (gammel reserved, flyttet av sveipet). */
async function unknownRow(label: string): Promise<string> {
  const k = key(label);
  await insert(k, "reserved", 120);
  await reconcile(k, "unknown_outcome", "reserved");
  return k;
}
async function needsResolutionRow(label: string): Promise<string> {
  const k = key(label);
  await insert(k, "unverified", 300, { postcondition_reason: "postcondition_unverified:readback_failed" });
  await reconcile(k, "needs_resolution", "unverified");
  return k;
}

describe("A: migrasjon 154 på en eksisterende database", () => {
  it("154 er anvendt, de seks nye kolonnene er nullbare, og indeksen og triggeren finnes", async () => {
    expect(applied.some((f) => f.startsWith("154_"))).toBe(true);
    const cols = (await admin.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'tool_executions'
        AND column_name IN ('status_before_reconcile','reconciled_at','reconcile_basis','resolved_at','resolved_by','resolution') ORDER BY column_name`
    )).rows;
    expect(cols).toEqual([
      { column_name: "reconcile_basis", data_type: "text", is_nullable: "YES" },
      { column_name: "reconciled_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "resolution", data_type: "text", is_nullable: "YES" },
      { column_name: "resolved_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "resolved_by", data_type: "text", is_nullable: "YES" },
      { column_name: "status_before_reconcile", data_type: "text", is_nullable: "YES" }
    ]);
    const idx = (await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'tool_executions_open_idx'`)).rows[0] as { indexdef: string };
    expect(idx.indexdef).toContain("(tenant_id, executed_at)");
    expect(idx.indexdef).toContain("unknown_outcome");
    expect(idx.indexdef).toContain("needs_resolution");
    const triggers = (await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'tool_executions'::regclass AND NOT tgisinternal`)).rows.map((r) => (r as { tgname: string }).tgname);
    expect(triggers).toContain("tool_executions_guard");
  });

  it("ALLE eldre rader er uberørte: status, årsak og digest bevart, alle nye kolonner NULL", async () => {
    const rows = (await admin.query(
      `SELECT idempotency_key, status, postcondition_reason, request_digest, status_before_reconcile, reconciled_at, reconcile_basis, resolved_at, resolved_by, resolution
         FROM tool_executions WHERE idempotency_key LIKE 'legacy-%' ORDER BY idempotency_key`
    )).rows as Row[];
    expect(rows.map((r) => [r["idempotency_key"], r["status"]])).toEqual([
      ["legacy-b", "succeeded"], ["legacy-failed", "failed"], ["legacy-reserved", "reserved"], ["legacy-succeeded", "succeeded"], ["legacy-unverified", "unverified"]
    ]);
    for (const r of rows) {
      for (const col of ["status_before_reconcile", "reconciled_at", "reconcile_basis", "resolved_at", "resolved_by", "resolution"]) expect(r[col], `${String(r["idempotency_key"])}.${col}`).toBeNull();
    }
    expect(rows.find((r) => r["idempotency_key"] === "legacy-succeeded")?.["request_digest"]).toBe(DIGEST);
    expect(rows.find((r) => r["idempotency_key"] === "legacy-unverified")?.["postcondition_reason"]).toBe("postcondition_unverified:no_provider_id");
  });

  it("en ny kjøring av migratoren er et no-op (ingen filer anvendes på nytt)", async () => {
    expect(await runMigrations(admin)).toEqual([]);
  });
});

describe("B: CHECK-ene (gjelder også en direkte INSERT, uavhengig av triggeren)", () => {
  it("statusmengden er de seks, og en ukjent status avvises", async () => {
    await expect(insert(key("bogus"), "done", 0)).rejects.toThrow(/tool_executions_status_check/);
    await insert(key("ok-unknown"), "unknown_outcome", 0, { status_before_reconcile: "reserved", reconciled_at: new Date(), reconcile_basis: "reserved_ttl_exceeded" });
    await insert(key("ok-needs"), "needs_resolution", 0, { status_before_reconcile: "unverified", reconciled_at: new Date(), reconcile_basis: "unverified_ttl_exceeded" });
  });

  it("de nye statusene har alltid en avstemming bak seg, og kommer fra riktig utgangsstatus", async () => {
    const at = new Date();
    await expect(insert(key("u1"), "unknown_outcome", 0)).rejects.toThrow(/tool_executions_(unknown_outcome_ck|reconcile_complete)/);
    await expect(insert(key("u2"), "unknown_outcome", 0, { status_before_reconcile: "unverified", reconciled_at: at, reconcile_basis: "x" })).rejects.toThrow(/tool_executions_unknown_outcome_ck/);
    await expect(insert(key("n1"), "needs_resolution", 0)).rejects.toThrow(/tool_executions_(needs_resolution_ck|reconcile_complete)/);
    await expect(insert(key("n2"), "needs_resolution", 0, { status_before_reconcile: "reserved", reconciled_at: at, reconcile_basis: "x" })).rejects.toThrow(/tool_executions_needs_resolution_ck/);
  });

  it("avstemmingsfeltene hører sammen (alle tomme eller alle satt), og formatene gjelder", async () => {
    const at = new Date();
    await expect(insert(key("c1"), "reserved", 0, { reconciled_at: at })).rejects.toThrow(/tool_executions_reconcile_complete/);
    await expect(insert(key("c2"), "reserved", 0, { reconcile_basis: "x" })).rejects.toThrow(/tool_executions_reconcile_complete/);
    await expect(insert(key("c3"), "reserved", 0, { status_before_reconcile: "reserved" })).rejects.toThrow(/tool_executions_reconcile_complete/);
    await expect(insert(key("c4"), "reserved", 0, { status_before_reconcile: "succeeded", reconciled_at: at, reconcile_basis: "x" })).rejects.toThrow(/tool_executions_status_before_reconcile_ck/);
    for (const bad of ["Upper", "has space", "", "1starts_with_digit", "x".repeat(81), "æøå"]) {
      await expect(insert(key("c5"), "reserved", 0, { status_before_reconcile: "reserved", reconciled_at: at, reconcile_basis: bad }), JSON.stringify(bad)).rejects.toThrow(/tool_executions_reconcile_basis_ck/);
    }
  });

  it("avgjørelsesfeltene hører sammen, har gyldige verdier og stemmer med statusen (executed <-> succeeded, not_executed <-> failed)", async () => {
    const at = new Date();
    await expect(insert(key("r1"), "failed", 0, { resolved_at: at })).rejects.toThrow(/tool_executions_resolution_complete/);
    await expect(insert(key("r2"), "failed", 0, { resolved_at: at, resolved_by: "p", resolution: "retry" })).rejects.toThrow(/tool_executions_resolution_ck/);
    await expect(insert(key("r3"), "failed", 0, { resolved_at: at, resolved_by: "", resolution: "not_executed" })).rejects.toThrow(/tool_executions_resolved_by_ck/);
    await expect(insert(key("r4"), "failed", 0, { resolved_at: at, resolved_by: "x".repeat(201), resolution: "not_executed" })).rejects.toThrow(/tool_executions_resolved_by_ck/);
    await expect(insert(key("r5"), "failed", 0, { resolved_at: at, resolved_by: "p", resolution: "executed" })).rejects.toThrow(/tool_executions_resolution_status_ck/);
    await expect(insert(key("r6"), "succeeded", 0, { resolved_at: at, resolved_by: "p", resolution: "not_executed" })).rejects.toThrow(/tool_executions_resolution_status_ck/);
    await insert(key("r7"), "failed", 0, { resolved_at: at, resolved_by: "p", resolution: "not_executed" });
    await insert(key("r8"), "succeeded", 0, { resolved_at: at, resolved_by: "p", resolution: "executed" });
  });
});

describe("C: triggeren `tool_executions_guard` - inn i de nye statusene (som app-rollen)", () => {
  it("reserved -> unknown_outcome: avvist under gulvet (10 min), tillatt over; raden er uendret etter et avvist forsøk", async () => {
    const young = key("young"); const old = key("old"); const edge = key("edge");
    await insert(young, "reserved", 5);
    await insert(old, "reserved", 11);
    await insert(edge, "reserved", 9);
    await expect(reconcile(young, "unknown_outcome", "reserved")).rejects.toThrow(/tool_executions_reconcile_too_early/);
    await expect(reconcile(edge, "unknown_outcome", "reserved")).rejects.toThrow(/tool_executions_reconcile_too_early/);
    expect((await rowOf(young))["status"]).toBe("reserved");
    await reconcile(old, "unknown_outcome", "reserved");
    expect(await rowOf(old)).toMatchObject({ status: "unknown_outcome", status_before_reconcile: "reserved", reconcile_basis: "ttl_exceeded" });
  });

  it("unverified -> needs_resolution: avvist under gulvet (1 time), tillatt over", async () => {
    const young = key("young"); const old = key("old");
    await insert(young, "unverified", 30);
    await insert(old, "unverified", 61);
    await expect(reconcile(young, "needs_resolution", "unverified")).rejects.toThrow(/tool_executions_reconcile_too_early/);
    await reconcile(old, "needs_resolution", "unverified");
    expect((await rowOf(old))["status"]).toBe("needs_resolution");
  });

  it("kun riktig utgangsstatus: alle andre kombinasjoner avvises (reserved->needs_resolution, unverified->unknown_outcome, avsluttede og ukjente)", async () => {
    const reserved = key("r"); const unverified = key("u"); const succeeded = key("s"); const failed = key("f");
    await insert(reserved, "reserved", 500); await insert(unverified, "unverified", 500); await insert(succeeded, "succeeded", 500); await insert(failed, "failed", 500);
    await expect(reconcile(reserved, "needs_resolution", "unverified")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    await expect(reconcile(unverified, "unknown_outcome", "reserved")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    await expect(reconcile(succeeded, "unknown_outcome", "reserved")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    await expect(reconcile(succeeded, "needs_resolution", "unverified")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    await expect(reconcile(failed, "unknown_outcome", "reserved")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    await expect(reconcile(failed, "needs_resolution", "unverified")).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    for (const [k, status] of [[reserved, "reserved"], [unverified, "unverified"], [succeeded, "succeeded"], [failed, "failed"]] as const) expect((await rowOf(k))["status"]).toBe(status);
  });

  it("avstemmingsfeltene må være satt og stemme med utgangsstatusen (ellers avvist av triggeren/CHECK)", async () => {
    const a = key("a"); const b = key("b"); const c = key("c");
    await insert(a, "reserved", 500); await insert(b, "reserved", 500); await insert(c, "reserved", 500);
    await expect(asApp(A, (cl) => cl.query(`UPDATE tool_executions SET status = 'unknown_outcome' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, a]))).rejects.toThrow(/tool_executions_reconcile_incomplete/);
    await expect(asApp(A, (cl) => cl.query(
      `UPDATE tool_executions SET status = 'unknown_outcome', status_before_reconcile = 'unverified', reconciled_at = now(), reconcile_basis = 'x' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, b]
    ))).rejects.toThrow(/tool_executions_reconcile_incomplete/);
    await expect(asApp(A, (cl) => cl.query(`UPDATE tool_executions SET status = 'unknown_outcome', status_before_reconcile = 'reserved', reconciled_at = now() WHERE tenant_id = $1 AND idempotency_key = $2`, [A, c]))).rejects.toThrow(/tool_executions_reconcile_incomplete/);
  });

  it("avstemmingen rører aldri det opprinnelige beviset (årsak, før-/etter-tilstand, ekstern id, tidspunkt)", async () => {
    const k = key("evidence");
    await insert(k, "unverified", 300, { postcondition_reason: "postcondition_unverified:no_provider_id", external_id: "ext-1", before_state: JSON.stringify({ a: 1 }), after_state: JSON.stringify({ b: 2 }) });
    const before = await rowOf(k);
    await reconcile(k, "needs_resolution", "unverified");
    const after = await rowOf(k);
    for (const col of ["postcondition_reason", "external_id", "before_state", "after_state", "executed_at", "tool_id", "action", "request_digest"]) expect(after[col], col).toEqual(before[col]);
  });
});

describe("D: triggeren - ut av de nye statusene og avgjørelsesfeltene", () => {
  it("ut av unknown_outcome/needs_resolution går kun til succeeded/failed, aldri tilbake til reserved/unverified (og aldri over til den andre nye statusen)", async () => {
    const u = await unknownRow("u"); const n = await needsResolutionRow("n");
    for (const target of ["reserved", "unverified"]) {
      await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET status = $3 WHERE tenant_id = $1 AND idempotency_key = $2`, [A, u, target])), `unknown->${target}`).rejects.toThrow(/tool_executions_invalid_resolution_transition/);
      await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET status = $3 WHERE tenant_id = $1 AND idempotency_key = $2`, [A, n, target])), `needs->${target}`).rejects.toThrow(/tool_executions_invalid_resolution_transition/);
    }
    await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET status = 'needs_resolution' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, u]))).rejects.toThrow(/tool_executions_invalid_reconcile_transition/);
    expect((await rowOf(u))["status"]).toBe("unknown_outcome");
    expect((await rowOf(n))["status"]).toBe("needs_resolution");
  });

  it("ut av en ny status uten en fullstendig avgjørelse avvises (status alene, eller en halv avgjørelse)", async () => {
    const u = await unknownRow("u"); const n = await needsResolutionRow("n");
    for (const k of [u, n]) {
      for (const status of ["succeeded", "failed"]) {
        await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET status = $3 WHERE tenant_id = $1 AND idempotency_key = $2`, [A, k, status])), `${k}->${status}`).rejects.toThrow(/tool_executions_resolution_incomplete/);
      }
      await expect(resolve(k, "failed", "not_executed", A, null)).rejects.toThrow(/tool_executions_resolution_(incomplete|complete)/);
      await expect(resolve(k, "failed", "not_executed", A, "person-owner", null)).rejects.toThrow(/tool_executions_resolution_(incomplete|complete)/);
      await expect(resolve(k, "failed", null)).rejects.toThrow(/tool_executions_resolution_(incomplete|complete)/);
    }
  });

  it("avgjørelsen må stemme med statusen: executed = succeeded, not_executed = failed (begge veier)", async () => {
    const u = await unknownRow("u"); const n = await needsResolutionRow("n");
    for (const k of [u, n]) {
      await expect(resolve(k, "succeeded", "not_executed")).rejects.toThrow(/tool_executions_resolution_status_(mismatch|ck)/);
      await expect(resolve(k, "failed", "executed")).rejects.toThrow(/tool_executions_resolution_status_(mismatch|ck)/);
    }
    await resolve(u, "succeeded", "executed");
    await resolve(n, "failed", "not_executed");
    expect(await rowOf(u)).toMatchObject({ status: "succeeded", resolution: "executed", resolved_by: "person-owner", status_before_reconcile: "reserved" });
    expect(await rowOf(n)).toMatchObject({ status: "failed", resolution: "not_executed", resolved_by: "person-owner", status_before_reconcile: "unverified" });
    expect((await rowOf(u))["resolved_at"]).toBeInstanceOf(Date);
  });

  it("de samme avgjørelsene gjelder `needs_resolution` -> succeeded og `unknown_outcome` -> failed (alle fire kombinasjoner)", async () => {
    const u1 = await unknownRow("u1"); const u2 = await unknownRow("u2"); const n1 = await needsResolutionRow("n1"); const n2 = await needsResolutionRow("n2");
    await resolve(u1, "succeeded", "executed"); await resolve(u2, "failed", "not_executed"); await resolve(n1, "succeeded", "executed"); await resolve(n2, "failed", "not_executed");
    expect(await Promise.all([u1, u2, n1, n2].map(async (k) => (await rowOf(k))["status"]))).toEqual(["succeeded", "failed", "succeeded", "failed"]);
  });

  it("avgjørelsesfeltene kan ikke settes uten en overgang til succeeded/failed fra en ikke-endelig status", async () => {
    const reserved = key("res"); const done = key("done"); const failed = key("failed");
    await insert(reserved, "reserved", 500); await insert(done, "succeeded", 500); await insert(failed, "failed", 500);
    // Samme status (ingen overgang):
    await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET resolved_at = now(), resolved_by = 'p', resolution = 'executed' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, reserved]))).rejects.toThrow(/tool_executions_invalid_resolution_transition/);
    // En avsluttet rad kan ikke avgjøres i ettertid:
    await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET resolved_at = now(), resolved_by = 'p', resolution = 'executed' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, done]))).rejects.toThrow(/tool_executions_invalid_resolution_transition/);
    await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET resolved_at = now(), resolved_by = 'p', resolution = 'not_executed' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, failed]))).rejects.toThrow(/tool_executions_invalid_resolution_transition/);
    // En avgjort rad kan ikke skrives om til en annen avgjørelse:
    const k = await unknownRow("redo");
    await resolve(k, "succeeded", "executed");
    await expect(resolve(k, "failed", "not_executed")).rejects.toThrow(/tool_executions_(invalid_resolution_transition|resolution_status)/);
    expect((await rowOf(k))["resolution"]).toBe("executed");
  });

  it("avgjørelse direkte fra `unverified` (før utløp) og fra en eldre `reserved` er tillatt; en ung `reserved` kan aldri avgjøres", async () => {
    const unverified = key("unv"); const oldReserved = key("oldres"); const youngReserved = key("youngres"); const edgeReserved = key("edgeres");
    await insert(unverified, "unverified", 5); await insert(oldReserved, "reserved", 11); await insert(youngReserved, "reserved", 3); await insert(edgeReserved, "reserved", 9);
    await resolve(unverified, "succeeded", "executed");
    await resolve(oldReserved, "failed", "not_executed");
    await expect(resolve(youngReserved, "failed", "not_executed")).rejects.toThrow(/tool_executions_resolve_too_early/);
    await expect(resolve(edgeReserved, "succeeded", "executed")).rejects.toThrow(/tool_executions_resolve_too_early/);
    expect((await rowOf(youngReserved))["status"]).toBe("reserved");
    expect(await rowOf(unverified)).toMatchObject({ status: "succeeded", resolution: "executed", status_before_reconcile: null });
  });
});

describe("E: re-arm og uendrede overganger", () => {
  it("failed -> reserved (retry) NULLSTILLER avstemmings- og avgjørelsesfeltene, selv om UPDATE forsøker å sette dem", async () => {
    const k = await needsResolutionRow("rearm");
    await resolve(k, "failed", "not_executed");
    expect(await rowOf(k)).toMatchObject({ status: "failed", resolution: "not_executed" });
    await asApp(A, (c) => c.query(
      `UPDATE tool_executions SET status = 'reserved', executed_at = now(), resolved_at = now(), resolved_by = 'forged', resolution = 'executed', reconcile_basis = 'forged' WHERE tenant_id = $1 AND idempotency_key = $2`, [A, k]
    ));
    expect(await rowOf(k)).toMatchObject({
      status: "reserved", status_before_reconcile: null, reconciled_at: null, reconcile_basis: null, resolved_at: null, resolved_by: null, resolution: null
    });
  });

  it("de eksisterende overgangene er UENDRET: reserved -> succeeded/failed/unverified, failed -> reserved, og unverified -> succeeded/failed uten avgjørelse (som før 154)", async () => {
    const r1 = key("r1"); const r2 = key("r2"); const r3 = key("r3"); const f = key("f"); const u1 = key("u1"); const u2 = key("u2");
    for (const k of [r1, r2, r3]) await insert(k, "reserved", 0);
    await insert(f, "failed", 0); await insert(u1, "unverified", 0); await insert(u2, "unverified", 0);
    const set = (k: string, status: string) => asApp(A, (c) => c.query(`UPDATE tool_executions SET status = $3, executed_at = now() WHERE tenant_id = $1 AND idempotency_key = $2`, [A, k, status]));
    await set(r1, "succeeded"); await set(r2, "failed"); await set(r3, "unverified"); await set(f, "reserved"); await set(u1, "succeeded"); await set(u2, "failed");
    expect(await Promise.all([r1, r2, r3, f, u1, u2].map(async (k) => (await rowOf(k))["status"]))).toEqual(["succeeded", "failed", "unverified", "reserved", "succeeded", "failed"]);
  });

  it("gateway-ferdigstilling av en rad som er flyttet til unknown_outcome rører den ikke (UPDATE ... WHERE status = 'reserved' treffer 0 rader)", async () => {
    const k = await unknownRow("finalize");
    const result = await asApp(A, (c) => c.query(`UPDATE tool_executions SET status = 'succeeded', external_id = 'late' WHERE idempotency_key = $1 AND status = 'reserved'`, [k]));
    expect(result.rowCount).toBe(0);
    expect(await rowOf(k)).toMatchObject({ status: "unknown_outcome", external_id: null });
  });
});

describe("F: rettigheter, tenant-isolasjon og retensjon", () => {
  it("app-rollen kan skrive KUN de nye kolonnene i tillegg til de gamle: identitet, digest, tenant og nøkkel er fortsatt ikke skrivbare, og DELETE er ikke gitt", async () => {
    const k = key("grants");
    await insert(k, "reserved", 0, { request_digest: DIGEST });
    for (const col of ["tool_id", "action", "request_digest", "tenant_id", "idempotency_key"]) {
      await expect(asApp(A, (c) => c.query(`UPDATE tool_executions SET ${col} = ${col} WHERE idempotency_key = $1`, [k])), col).rejects.toThrow(/permission denied/i);
    }
    await expect(asApp(A, (c) => c.query(`DELETE FROM tool_executions WHERE idempotency_key = $1`, [k]))).rejects.toThrow(/permission denied/i);
    await asApp(A, (c) => c.query(`UPDATE tool_executions SET postcondition_reason = 'x' WHERE idempotency_key = $1`, [k]));
  });

  it("tenant-isolasjon (FORCE RLS) er uendret: en annen tenant ser og avgjør aldri raden", async () => {
    const k = await needsResolutionRow("rls");
    const seen = await asApp(B, (c) => c.query(`SELECT idempotency_key, status FROM tool_executions WHERE idempotency_key = $1`, [k]));
    expect(seen.rows).toEqual([]);
    const attempted = await resolve(k, "succeeded", "executed", B);
    expect(attempted.rowCount).toBe(0);
    expect((await rowOf(k))["status"]).toBe("needs_resolution");
  });

  it("retensjonen sletter ALDRI unknown_outcome/needs_resolution/reserved/unverified (uansett alder), men fortsatt gamle succeeded/failed - også etter avgjørelse", async () => {
    const unknown = await unknownRow("ret-unknown"); const needs = await needsResolutionRow("ret-needs");
    const resolvedOk = key("ret-resolved");
    await insert(resolvedOk, "unverified", 300 * 24 * 60);
    await resolve(resolvedOk, "failed", "not_executed");
    // Eldre enn retensjonsvinduet (180 dager):
    for (const k of [unknown, needs]) await admin.query(`UPDATE tool_executions SET executed_at = now() - interval '400 days' WHERE idempotency_key = $1`, [k]);
    await admin.query(`UPDATE tool_executions SET executed_at = now() - interval '400 days' WHERE idempotency_key IN ('legacy-succeeded', 'legacy-failed', 'legacy-unverified', 'legacy-reserved')`);
    await asApp(A, (c) => c.query(`SELECT * FROM prune_operational_data()`));
    const left = (await admin.query(`SELECT idempotency_key, status FROM tool_executions WHERE idempotency_key = ANY($1)`, [[unknown, needs, resolvedOk, "legacy-unverified", "legacy-reserved", "legacy-succeeded", "legacy-failed"]])).rows as Array<{ idempotency_key: string; status: string }>;
    const byKey = new Map(left.map((r) => [r.idempotency_key, r.status]));
    expect(byKey.get(unknown)).toBe("unknown_outcome");
    expect(byKey.get(needs)).toBe("needs_resolution");
    expect(byKey.get("legacy-unverified")).toBe("unverified");
    expect(byKey.get("legacy-reserved")).toBe("reserved");
    expect(byKey.has(resolvedOk)).toBe(false); // en AVGJORT (failed) rad ryddes som andre avsluttede rader
    expect(byKey.has("legacy-succeeded")).toBe(false);
    expect(byKey.has("legacy-failed")).toBe(false);
  });
});
