import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type SecretProvider } from "../../src/index.ts";

/**
 * WP-G2: felles oppsett for DB-testene av personlig-domenet: ekte embedded Postgres (alle migrasjoner), app-rolle uten superbruker, eier + delegat + fremmed tenant, og en `ToolGateway` med ekte policy, klasse D-kjede
 * og credential-binding til eieren (samme form som i produksjon). Ingen nettverk, ingen ekte leverandør.
 */
export interface PersonalDb {
  adminPool: pg.Pool;
  appPool: pg.Pool;
  stop(): Promise<void>;
}

export const G2_TENANT = "tenant-g2-p";
export const G2_OTHER_TENANT = "tenant-g2-p-other";
export const g2Owner: IdentityContext = { person_id: "person-g2-p-owner", tenant_id: G2_TENANT, memory_space_id: "personal", session_id: "sess-g2-p", device_id: "dev-g2-p", channel: "api", auth_strength: "signed" };

export async function startPersonalDb(roleName: string, extraSql = ""): Promise<PersonalDb> {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-g2-p-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD 'pw2'`);
  await adminPool.query(`GRANT jarvis_app TO ${roleName}`);
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${G2_TENANT}','G2 personal','person'), ('${G2_OTHER_TENANT}','G2 other','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-g2-p-owner','Owner'), ('person-g2-p-delegate','Delegate'), ('person-g2-p-other','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-g2-p-owner','${G2_TENANT}'), ('person-g2-p-delegate','${G2_TENANT}'), ('person-g2-p-other','${G2_OTHER_TENANT}');
    ${extraSql}
  `);
  const appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: roleName, password: "pw2" });
  return { adminPool, appPool, stop: async () => { await appPool.end(); await adminPool.end(); await leased.stop(); } };
}

export interface PersonalGatewayHarness {
  gateway: ToolGateway;
  notifications: ClassDNotification[];
  killSwitch: KillSwitch;
  controls: OwnerControls;
  setNotifierReady(value: boolean): void;
}

export function personalGateway(appPool: pg.Pool, secrets: SecretProvider): PersonalGatewayHarness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT] }
  });
  const notifications: ClassDNotification[] = [];
  let ready = true;
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => ready, notify: async (n) => { notifications.push(n); } } },
    credentialBinding: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT], internalRefs: new Set() }
  });
  return { gateway, notifications, killSwitch, controls, setNotifierReady: (value) => { ready = value; } };
}
