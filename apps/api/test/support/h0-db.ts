import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-H0: ekte embedded Postgres med alle migrasjoner, to pooler: `adminPool` (superbruker - kun til å SÅ testdata, omgår RLS) og `appPool` (jarvis_app-rollen, RLS gjelder - slik drift kjører).
 * Kontrollsentrene leser alltid som app-rolle; testene beviser derfor SQL, kolonner og tenant-isolasjon mot den ekte rollen.
 */
export interface H0Db {
  adminPool: pg.Pool;
  appPool: pg.Pool;
  stop(): Promise<void>;
}

export async function startH0Db(prefix = "wph0"): Promise<H0Db> {
  const databaseDir = await mkdtemp(join(tmpdir(), `jarvis-pg-${prefix}-`));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_h0 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_h0");
  const appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_h0", password: "pw2" });
  return {
    adminPool,
    appPool,
    stop: async () => {
      await appPool.end();
      await adminPool.end();
      await leased.stop();
    }
  };
}

/** Oppretter tenanter, personer og tilhørighet i ett kall (FK-ene krever det før audit/kostnad/vedlikehold kan så'es). */
export async function seedTenants(adminPool: pg.Pool, tenants: ReadonlyArray<{ tenant_id: string; person_id: string }>): Promise<void> {
  for (const t of tenants) {
    await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, $1, 'business')", [t.tenant_id]);
    await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [t.person_id]);
    await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'owner')", [t.person_id, t.tenant_id]);
  }
}
