import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { correlateDbState } from "../src/db-correlation.ts";

/**
 * D-105 Part F: EKTE DB-tilstand-korrelasjon (embedded-Postgres) - erstatter
 * det D-104-audit fant var en ubrukt `source_type`-tag. Bruker DEN
 * EKSISTERENDE `schema_migrations`-tabellen (migrator.ts, uendret).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let unreachablePool: pg.Pool;
const TENANT = "tenant-dbcorr";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-dbcorr-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_dbcorr LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_dbcorr");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','DbCorr','business');`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_dbcorr", password: "pw2" });
  // Bevisst uoppnåelig pool (feil port, INGEN daemon der) - beviser "unreachable"-banen ekte, ikke bare simulert.
  unreachablePool = new pg.Pool({ host: "127.0.0.1", port: 1, database: "jarvis_test", user: "jarvis_test_dbcorr", password: "pw2", connectionTimeoutMillis: 500 });
  unreachablePool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await unreachablePool?.end().catch(() => undefined);
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("D-105 Part F: correlateDbState (EKTE schema_migrations, ingen ny leverandør)", () => {
  it("A: tilkobling OK + nyeste migrasjon lest korrekt fra DEN FAKTISKE schema_migrations-tabellen", async () => {
    const latest = await adminPool.query("SELECT name, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1");
    const result = await correlateDbState(appPool, TENANT, "1970-01-01T00:00:00.000Z", new Date(Date.now() + 86_400_000).toISOString());
    expect(result.connectivity).toBe("ok");
    expect(result.latest_migration?.name).toBe((latest.rows[0] as { name: string }).name);
  });

  it("B: migrasjon INNENFOR hendelsesvinduet gir relevant=true (deterministisk, ikke en gjetning)", async () => {
    const result = await correlateDbState(appPool, TENANT, "1970-01-01T00:00:00.000Z", new Date(Date.now() + 86_400_000).toISOString());
    expect(result.migration_in_window).toBe(true);
    expect(result.relevant).toBe("true");
  });

  it("C: migrasjon UTENFOR hendelsesvinduet (vindu langt i fortiden) gir relevant=false", async () => {
    const result = await correlateDbState(appPool, TENANT, "1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z");
    expect(result.migration_in_window).toBe(false);
    expect(result.relevant).toBe("false");
  });

  it("D: EKTE uoppnåelig database gir EKSPLISITT connectivity=unreachable/relevant=unknown - ALDRI en fabrikkert 'ok'", async () => {
    const result = await correlateDbState(unreachablePool, TENANT, "1970-01-01T00:00:00.000Z", new Date().toISOString());
    expect(result.connectivity).toBe("unreachable");
    expect(result.relevant).toBe("unknown");
    expect(result.latest_migration).toBeNull();
  }, 10_000);
});
