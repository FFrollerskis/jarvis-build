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
 * WP-T1 K2 (migrasjon 153, JARVIS-102): `tool_executions.request_digest` på en EKSISTERENDE database (rader fra før migrasjonen) og som app-rolle.
 * Bevis: eldre rader får NULL (aldri bakfylt), formatkravet gjelder, app-rollen kan sette digesten ved INSERT men aldri endre den (kolonnevise UPDATE-rettigheter),
 * tenant-isolasjonen (FORCE RLS) er uendret, og en ny kjøring av migratoren er et no-op.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const DIGEST = "a".repeat(64);
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let applied: string[] = [];
const A = "tenant-t1a";
const B = "tenant-t1b";

beforeAll(async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const legacyDir = await mkdtemp(join(tmpdir(), "jarvis-t1up-legacy-"));
  const fullDir = await mkdtemp(join(tmpdir(), "jarvis-t1up-full-"));
  for (const f of files) {
    await copyFile(join(MIGRATIONS_DIR, f), join(fullDir, f));
    if (Number(f.slice(0, 3)) < 153) await copyFile(join(MIGRATIONS_DIR, f), join(legacyDir, f));
  }
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1up-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);

  // 1) Eksisterende database: alt FØR 153, med ledger-rader i alle statuser som fantes da.
  await runMigrations(admin, legacyDir);
  expect(((await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tool_executions' AND column_name = 'request_digest'`)).rows[0] as { n: number }).n).toBe(0);
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}', 'T1A', 'person'), ('${B}', 'T1B', 'person');
    INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, postcondition_reason) VALUES
      ('${A}', 'legacy-succeeded', 'calendar', 'create_event', 'succeeded', NULL),
      ('${A}', 'legacy-failed', 'calendar', 'create_event', 'failed', 'tool_failed:x'),
      ('${A}', 'legacy-unverified', 'email', 'send', 'unverified', 'postcondition_unverified:no_provider_id'),
      ('${A}', 'legacy-reserved', 'email', 'send', 'reserved', NULL),
      ('${B}', 'legacy-b', 'calendar', 'create_event', 'succeeded', NULL);
  `);

  // 2) Oppgrader: 153 (og senere) anvendes på de eksisterende dataene.
  applied = await runMigrations(admin, fullDir);
  await admin.query(`CREATE ROLE jarvis_t1app LOGIN PASSWORD 'pw2'`);
  await admin.query(`GRANT jarvis_app TO jarvis_t1app`);
  app = new pg.Pool({ ...base, user: "jarvis_t1app", password: "pw2", max: 4 });
  app.on("error", () => undefined);
}, 300_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const insertAsApp = (tenant: string, key: string, digest: string | null, status = "reserved") =>
  withTenantTransaction(app, tenant, (client) =>
    digest === null
      ? client.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status) VALUES ($1, $2, 'calendar', 'create_event', $3)`, [tenant, key, status])
      : client.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, request_digest) VALUES ($1, $2, 'calendar', 'create_event', $3, $4)`, [tenant, key, status, digest]));

describe("WP-T1 K2: migrasjon 153 på en eksisterende database", () => {
  it("153 er anvendt (som den 153. filen, i rekkefølge), kolonnen er nullbar tekst", async () => {
    expect(applied.some((f) => f.startsWith("153_"))).toBe(true);
    const col = (await admin.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'tool_executions' AND column_name = 'request_digest'`)).rows[0] as { data_type: string; is_nullable: string };
    expect(col).toEqual({ data_type: "text", is_nullable: "YES" });
  });

  it("ALLE eldre rader har request_digest NULL (aldri bakfylt/gjettet) og beholder status og øvrige felt", async () => {
    const rows = (await admin.query(`SELECT idempotency_key, status, request_digest, postcondition_reason FROM tool_executions WHERE idempotency_key LIKE 'legacy-%' ORDER BY idempotency_key`)).rows as Array<{ idempotency_key: string; status: string; request_digest: string | null; postcondition_reason: string | null }>;
    expect(rows.map((r) => [r.idempotency_key, r.status])).toEqual([
      ["legacy-b", "succeeded"], ["legacy-failed", "failed"], ["legacy-reserved", "reserved"], ["legacy-succeeded", "succeeded"], ["legacy-unverified", "unverified"]
    ]);
    expect(rows.every((r) => r.request_digest === null)).toBe(true);
    expect(rows.find((r) => r.idempotency_key === "legacy-unverified")?.postcondition_reason).toBe("postcondition_unverified:no_provider_id");
  });

  it("formatkravet: kun 64 små hex-tegn (eller NULL); store bokstaver, feil lengde, tom tekst og ikke-hex avvises", async () => {
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "", "g".repeat(64), `${"a".repeat(63)} `]) {
      await expect(insertAsApp(A, `bad-${bad.length}-${bad.slice(0, 2)}`, bad), JSON.stringify(bad)).rejects.toThrow(/tool_executions_request_digest_format/);
    }
    await insertAsApp(A, "ok-null", null);
    await insertAsApp(A, "ok-digest", DIGEST);
    const rows = (await admin.query(`SELECT idempotency_key, request_digest FROM tool_executions WHERE idempotency_key IN ('ok-null', 'ok-digest') ORDER BY idempotency_key`)).rows;
    expect(rows).toEqual([{ idempotency_key: "ok-digest", request_digest: DIGEST }, { idempotency_key: "ok-null", request_digest: null }]);
  });

  it("app-rollen kan SETTE digesten ved INSERT, men aldri endre den etterpå (kolonnevise UPDATE-rettigheter) - heller ikke fra NULL", async () => {
    await insertAsApp(A, "immutable-1", DIGEST);
    await expect(withTenantTransaction(app, A, (c) => c.query(`UPDATE tool_executions SET request_digest = $2 WHERE idempotency_key = $1`, ["immutable-1", "b".repeat(64)]))).rejects.toThrow(/permission denied/i);
    await expect(withTenantTransaction(app, A, (c) => c.query(`UPDATE tool_executions SET request_digest = $2 WHERE idempotency_key = $1`, ["legacy-succeeded", "b".repeat(64)]))).rejects.toThrow(/permission denied/i);
    await expect(withTenantTransaction(app, A, (c) => c.query(`UPDATE tool_executions SET request_digest = NULL WHERE idempotency_key = $1`, ["immutable-1"]))).rejects.toThrow(/permission denied/i);
    // De eksisterende kolonnevise rettighetene (status m.fl.) er uendret.
    await expect(withTenantTransaction(app, A, (c) => c.query(`UPDATE tool_executions SET status = 'failed' WHERE idempotency_key = $1 AND status = 'reserved'`, ["legacy-reserved"]))).resolves.toBeDefined();
    expect(((await admin.query(`SELECT request_digest FROM tool_executions WHERE idempotency_key = 'immutable-1'`)).rows[0] as { request_digest: string }).request_digest).toBe(DIGEST);
  });

  it("DELETE er fortsatt ikke gitt app-rollen (replay-/dedupe-beviset kan ikke fjernes av runtime)", async () => {
    await expect(withTenantTransaction(app, A, (c) => c.query(`DELETE FROM tool_executions WHERE idempotency_key = 'immutable-1'`))).rejects.toThrow(/permission denied/i);
  });

  it("tenant-isolasjon (FORCE RLS) er uendret: tenant B ser ikke tenant A sin digest, og kan ikke skrive for A", async () => {
    const seenByB = await withTenantTransaction(app, B, (c) => c.query(`SELECT idempotency_key, request_digest FROM tool_executions WHERE idempotency_key IN ('immutable-1', 'ok-digest')`));
    expect(seenByB.rows).toEqual([]);
    await expect(withTenantTransaction(app, B, (c) => c.query(`INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, request_digest) VALUES ($1, 'cross', 'calendar', 'create_event', 'reserved', $2)`, [A, DIGEST]))).rejects.toThrow(/row-level security/i);
    // Samme nøkkel i to tenants er to rader (PK er (tenant_id, idempotency_key)), hver med sin digest.
    await insertAsApp(B, "immutable-1", "c".repeat(64));
    expect(((await admin.query(`SELECT count(*)::int AS n FROM tool_executions WHERE idempotency_key = 'immutable-1'`)).rows[0] as { n: number }).n).toBe(2);
  });

  it("en ny kjøring av migratoren er et no-op (ingen filer anvendes på nytt)", async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    expect(files.some((f) => f.startsWith("153_"))).toBe(true);
    const again = await runMigrations(admin);
    expect(again).toEqual([]);
  });
});
