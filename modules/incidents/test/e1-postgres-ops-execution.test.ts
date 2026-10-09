import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { INFRA_GATED_TOOL_IDS, PostgresOpsTransport, ToolGateway, parsePostgresOpsConfig, postgresOpsToolDefinitions, type SecretProvider } from "@jarvis/tool-gateway";
import { attemptRecovery } from "../src/recovery.ts";
import { executeCloudMutation } from "../src/cloud-execution.ts";

/**
 * WP-E1: Postgres-drift-mutasjoner gjennom `executeCloudMutation()` (den sammenhengende `infra_executions`-journalen) mot EKTE ToolGateway + embedded Postgres, med den
 * dedikerte ops-rollen som mål. Bevist: full før-/etter-revisjon (økt-snapshot, readback), idempotent retry uten ny utførelse, ærlig «ingen reversering»
 * (recovery_available=false, aldri en fabrikkert gjenoppretting) og at et avslag/feil journalføres som FAILED med årsak.
 */
const TENANT = "tenant-e1-pgx";
const identity: IdentityContext = { person_id: "person-e1-pgx", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-pgx", device_id: "dev-pgx", channel: "api", auth_strength: "active" };
const TS = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let port = 0;
let gateway: ToolGateway;
const open: pg.Client[] = [];
let seq = 0;
const key = (p: string): string => `${p}-${(seq += 1)}-${Date.now().toString(36)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-pgx-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE ops_x LOGIN PASSWORD 'opsPw-x-1'; GRANT pg_monitor, pg_signal_backend TO ops_x;");
  await admin.query("CREATE ROLE victim_x LOGIN PASSWORD 'victimPw-x'");
  await admin.query("CREATE ROLE jarvis_test_e1_pgx LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_pgx;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1-pgx','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1-pgx','${TENANT}');
    CREATE TABLE public.jx_owned (id int); ALTER TABLE public.jx_owned OWNER TO ops_x;
  `);
  appPool = createPool({ host: "127.0.0.1", port, database: "jarvis_test", user: "jarvis_test_e1_pgx", password: "pw2" });
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: identity.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_POSTGRES_OPS_URL" ? `postgresql://ops_x:opsPw-x-1@127.0.0.1:${port}/jarvis_test` : null) };
  gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } } });
  const config = parsePostgresOpsConfig({ databases: "jarvis_test" });
  for (const d of postgresOpsToolDefinitions(new PostgresOpsTransport({ config }), { ops: config })) gateway.register(d);
}, 240_000);

afterAll(async () => {
  for (const c of open) await c.end().catch(() => undefined);
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

async function victim(): Promise<{ pid: number; backend_start: string }> {
  const c = new pg.Client({ host: "127.0.0.1", port, database: "jarvis_test", user: "victim_x", password: "victimPw-x" });
  c.on("error", () => undefined);
  await c.connect();
  open.push(c);
  const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const backend_start = (await admin.query<{ b: string }>(`SELECT ${TS("backend_start")} AS b FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]!.b;
  return { pid, backend_start };
}
const alive = async (pid: number): Promise<boolean> => ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount ?? 0) > 0;
const mutate = (action: string, parameters: Record<string, string | number | boolean>, k: string) =>
  executeCloudMutation({ pool: appPool, gateway }, identity, { tenant_id: TENANT, person_id: identity.person_id, provider: "postgres_ops", action, parameters, idempotency_key: k });

describe("Postgres-drift i den sammenhengende infra-journalen", () => {
  it("terminate: journalraden bærer aktør, klasse D, mål, økt-snapshot, «borte»-readback og en ærlig «ingen reversering»", async () => {
    const v = await victim();
    const k = key("term");
    const ex = await mutate("terminate_backend", { pid: v.pid, database: "jarvis_test", backend_start: v.backend_start }, k);
    expect(ex).toMatchObject({
      provider: "postgres_ops", tool_id: "postgres_ops", action: "terminate_backend", risk_class: "D", person_id: identity.person_id, verification_outcome: "SUCCESS",
      recovery_available: false, target: `postgres:jarvis_test:backend:${v.pid}@${v.backend_start}`
    });
    expect(ex.before_state).toMatchObject({ pid: v.pid, role: "victim_x", database: "jarvis_test", backend_type: "client backend" });
    expect(ex.after_state).toBeNull();
    expect(ex.provider_receipt).toMatchObject({ external_id: `pid:${v.pid}` });
    expect(ex.recovery_plan).toMatch(/ingen teknisk reversering/);
    expect(await alive(v.pid)).toBe(false);
  });

  it("idempotent retry: samme nøkkel + samme mål gir samme journalrad uten ny utførelse; samme nøkkel for noe annet er en konflikt", async () => {
    const v = await victim();
    const k = key("idem");
    const params = { pid: v.pid, database: "jarvis_test", backend_start: v.backend_start };
    const first = await mutate("terminate_backend", params, k);
    const again = await mutate("terminate_backend", params, k);
    expect(again.execution_id).toBe(first.execution_id);
    await expect(mutate("vacuum_analyze", { database: "jarvis_test", schema: "public", table: "jx_owned" }, k)).rejects.toThrow("infra_idempotency_key_conflict");
  });

  it("recovery for terminate er UNKNOWN/no_recovery_strategy_registered - aldri en fabrikkert gjenoppretting", async () => {
    const v = await victim();
    const k = key("rec");
    await mutate("terminate_backend", { pid: v.pid, database: "jarvis_test", backend_start: v.backend_start }, k);
    const rec = await attemptRecovery({ pool: appPool, gateway }, identity, { tenant_id: TENANT, tool_id: "postgres_ops", action: "terminate_backend", idempotency_key: k, parameters: {} });
    expect(rec).toMatchObject({ status: "UNKNOWN", recovery_result: { reason: "no_recovery_strategy_registered" } });
  });

  it("vacuum: etter-tilstanden viser fersk vacuum og diffen journalføres; recovery_available=false (idempotent vedlikehold)", async () => {
    const ex = await mutate("vacuum_analyze", { database: "jarvis_test", schema: "public", table: "jx_owned" }, key("vac"));
    expect(ex).toMatchObject({ risk_class: "D", verification_outcome: "SUCCESS", recovery_available: false, target: "postgres:jarvis_test:table:public.jx_owned" });
    expect((ex.after_state as { seconds_since_vacuum: number }).seconds_since_vacuum).toBeLessThan(120);
    expect(ex.state_diff).not.toBeNull();
    expect(ex.recovery_plan).toMatch(/ingen reversering nødvendig/);
  });

  it("nektet/feilet mutasjon journalføres som FAILED med årsak og recovery_available=false (superbruker-økt)", async () => {
    const su = new pg.Client({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" });
    su.on("error", () => undefined);
    await su.connect();
    open.push(su);
    const pid = (await su.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const backend_start = (await admin.query<{ b: string }>(`SELECT ${TS("backend_start")} AS b FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]!.b;
    const ex = await mutate("terminate_backend", { pid, database: "jarvis_test", backend_start }, key("su"));
    expect(ex).toMatchObject({ verification_outcome: "FAILED", recovery_available: false });
    expect(ex.provider_receipt).toMatchObject({ reason: "tool_failed:postgres_backend_superuser_protected" });
    expect(await alive(pid)).toBe(true);
  });

  it("database utenfor eierens liste journalføres som FAILED (parameterAuthorizer) uten at noe utføres", async () => {
    const v = await victim();
    const ex = await mutate("terminate_backend", { pid: v.pid, database: "infisical", backend_start: v.backend_start }, key("db"));
    expect(ex).toMatchObject({ verification_outcome: "FAILED" });
    expect(ex.provider_receipt).toMatchObject({ reason: "postgres_database_not_authorized" });
    expect(await alive(v.pid)).toBe(true);
  });
});
