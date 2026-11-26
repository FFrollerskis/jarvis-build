import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/** WP-AUTH2a: delt oppsett for DB-testene (ekte embedded Postgres, migrert, app-rolle med RLS, én eier-tenant). Hver testfil starter sin egen instans. */
export interface ClassCTestDb {
  adminPool: pg.Pool;
  appPool: pg.Pool;
  stop(): Promise<void>;
}

export async function startClassCTestDb(): Promise<ClassCTestDb> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-auth2a-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_auth2a LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_auth2a");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Eier','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-owner','Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner','tenant-a');
  `);
  const appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_auth2a", password: "pw2" });
  return {
    adminPool, appPool,
    async stop() {
      await appPool.end();
      await adminPool.end();
      await leased.stop();
    }
  };
}
