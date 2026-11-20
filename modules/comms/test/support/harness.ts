import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { AdapterSend, AdapterTarget, ChannelAdapter, CommsProvider } from "../../src/index.ts";

/** Felles testoppsett: ekte embedded Postgres + migrasjoner, to tenants, en runtime-rolle uten superbruker/BYPASSRLS (RLS gjelder). */
export interface CommsDb {
  readonly admin: pg.Pool;
  readonly app: pg.Pool;
  stop(): Promise<void>;
}

export const TENANT_A = "tenant-g1-a";
export const TENANT_B = "tenant-g1-b";
export const OWNER = "person-g1-owner";

export async function startCommsDb(prefix: string): Promise<CommsDb> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-${prefix}-`));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  const role = `jarvis_${prefix}_app`;
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT jarvis_app TO ${role}`);
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'G1 A', 'business'), ('${TENANT_B}', 'G1 B', 'business')`);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner'), ('person-g1-guest', 'Guest')`);
  await admin.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT_A}'), ('person-g1-guest', '${TENANT_A}')`);
  const app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: role, password: "pw2" });
  return {
    admin, app,
    async stop() {
      await app.end();
      await admin.end();
      await leased.stop();
    }
  };
}

export interface AdapterCall { op: string; request: Record<string, unknown>; credential: string }

/** Skriptbar adapter: registrerer hvert kall og svarer med `script(op, n)` (kaster for å simulere feil). */
export function scriptedAdapter(provider: CommsProvider, script: (op: string, n: number) => { provider_message_id?: string; exists?: boolean } | never = (_op, n) => ({ provider_message_id: `msg-${n}` })): ChannelAdapter & { calls: AdapterCall[] } {
  const calls: AdapterCall[] = [];
  const record = (op: string, request: Record<string, unknown>, credential: string) => {
    calls.push({ op, request, credential });
    return script(op, calls.length);
  };
  return {
    provider, calls,
    async send(request: AdapterSend, credential: string) {
      const r = record("send", { ...request }, credential);
      return { provider_message_id: r.provider_message_id ?? "msg-x", thread_ref: "thread-1" };
    },
    async edit(request: AdapterTarget & { target_message_id: string; text: string }, credential: string) {
      const r = record("edit", { ...request }, credential);
      return { provider_message_id: r.provider_message_id ?? request.target_message_id };
    },
    async delete(request: AdapterTarget & { target_message_id: string }, credential: string) {
      record("delete", { ...request }, credential);
    },
    async react(request: AdapterTarget & { target_message_id: string; reaction: string }, credential: string) {
      record("react", { ...request }, credential);
    },
    async messageExists(request: AdapterTarget & { target_message_id: string }, credential: string) {
      return record("exists", { ...request }, credential).exists ?? true;
    }
  };
}
