import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, PgPolicyAuditSink, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "../src/index.ts";

/**
 * WP-K (D-471, JARVIS-053/054) ende-til-ende: ekte ToolGateway + ekte PolicyGateway + den DB-baserte journalen (`policy_decisions`) + `audit_events`. Beviser «hva skjedde kl. 03:17»-oppslaget
 * (revisjonsrad <-> policy-avgjørelse via decision_id, med oppgave-/spor-ID), at et system-kall (`person_id: "system"`) merkes `system` i begge, og at en DØD journal aldri endrer et verktøyresultat
 * eller fjerner decision_id fra revisjonsraden (revisjonen er autoritativ; journalen er supplement).
 */
const TENANT = "tenant-wpk53";
const identity: IdentityContext = { person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-wpk53", device_id: "dev-pc", channel: "web", auth_strength: "active" };
const secrets: SecretProvider = { name: "test", async get(ref) { return `secret-for-${ref}`; } };

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk53e2e-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpk53e2e LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpk53e2e");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','WPK53','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_wpk53e2e", password: "pw2", max: 10 });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function build(sinkPool: pg.Pool): { gateway: ToolGateway; policy: PolicyGateway; sink: PgPolicyAuditSink; killSwitch: KillSwitch } {
  const sink = new PgPolicyAuditSink({ pool: sinkPool, autoFlush: false, processName: "api" });
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch,
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }, auditSink: sink.write
  });
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ email: new FakeTransport(() => ({ external_id: "x", data: { messages: [] } })), calendar: new FakeTransport(() => ({ external_id: "evt" })) })) gateway.register(tool);
  return { gateway, policy, sink, killSwitch };
}

const timeline = async (traceId: string) =>
  (await adminPool.query(
    `SELECT 'audit' AS src, a.audit_id::text AS ord, a.type AS what, a.decision, a.reason, a.actor_kind, a.task_id, a.trace_id, a.payload->>'policy_decision_id' AS decision_id
       FROM audit_events a WHERE a.tenant_id = $1 AND a.trace_id = $2
     UNION ALL
     SELECT 'policy', p.decision_id, p.tool_id || '.' || p.action, p.decision, p.reason, p.actor_kind, p.task_id, p.trace_id, p.decision_id
       FROM policy_decisions p WHERE p.tenant_id = $1 AND p.trace_id = $2
     ORDER BY 1, 2`, [TENANT, traceId]
  )).rows as Array<{ src: string; what: string; decision: string; reason: string; actor_kind: string; task_id: string; trace_id: string; decision_id: string }>;

describe("«hva skjedde kl. 03:17»: revisjonsrad <-> policy-avgjørelse via decision_id", () => {
  it("et planlagt system-kall: begge sider bærer samme oppgave-/spor-ID og samme decision_id, merket `system`", async () => {
    const { gateway, sink } = build(appPool);
    const trace = `sched-business-events-sync-${randomUUID().slice(0, 8)}-a1`;
    const task = "sched:business-events-sync:2026-11-14";
    const system: IdentityContext = { ...identity, person_id: "system", session_id: `business-events-sync-${TENANT}`, device_id: "jarvis-core", channel: "api" };
    const result = await gateway.execute({ identity: system, tool_id: "email", action: "read_inbox", parameters: { max: 5 }, task_id: task, trace_id: trace });
    expect(result.ok).toBe(true);
    await sink.flush();
    const rows = await timeline(trace);
    const audit = rows.find((r) => r.src === "audit")!;
    const policy = rows.find((r) => r.src === "policy")!;
    expect(audit).toMatchObject({ what: "tool.executed", actor_kind: "system", task_id: task, trace_id: trace });
    expect(policy).toMatchObject({ what: "email.read_inbox", decision: "ALLOW", actor_kind: "system", task_id: task, trace_id: trace });
    expect(audit.decision_id).toBe(policy.decision_id);
    // og oppslaget ER et vanlig join - ingen gjetting på tidsstempel
    const joined = await adminPool.query(
      `SELECT a.type, p.decision, p.reason FROM audit_events a JOIN policy_decisions p ON p.tenant_id = a.tenant_id AND p.decision_id = a.payload->>'policy_decision_id'
        WHERE a.tenant_id = $1 AND a.task_id = $2`, [TENANT, task]
    );
    expect(joined.rows).toEqual([{ type: "tool.executed", decision: "ALLOW", reason: "class_a_read" }]);
  });

  it("et avslag AV policy og et avslag ETTER policy kan skilles i oppslaget: samme decision_id-kobling, ulik avgjørelse", async () => {
    const { gateway, sink, killSwitch } = build(appPool);
    const denyTrace = `trace-policy-deny-${randomUUID()}`;
    killSwitch.activate("test");
    try {
      expect(await gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 1 }, task_id: "task-ks", trace_id: denyTrace })).toEqual({ ok: false, reason: "kill_switch_active" });
    } finally {
      killSwitch.deactivate();
    }
    // Avslag ETTER policy: policy sa ALLOW, men credentialen er ikke tilgjengelig (gatewayen avslår). Samme kobling, men journalen viser ALLOW.
    const lateTrace = `trace-post-policy-${randomUUID()}`;
    const late = build(appPool);
    const lateGateway = new ToolGateway(appPool, late.policy, { name: "none", async get() { return null; } });
    for (const tool of gateway.list()) lateGateway.register(tool);
    expect(await lateGateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 1 }, task_id: "task-late", trace_id: lateTrace })).toEqual({ ok: false, reason: "credential_unavailable" });
    await sink.flush();
    await late.sink.flush();

    const deniedByPolicy = await timeline(denyTrace);
    expect(deniedByPolicy.filter((r) => r.src === "audit")).toHaveLength(1);
    expect(deniedByPolicy.filter((r) => r.src === "policy")).toHaveLength(1);
    expect(deniedByPolicy.find((r) => r.src === "audit")).toMatchObject({ what: "tool.denied", reason: "kill_switch_active", decision_id: deniedByPolicy.find((r) => r.src === "policy")!.decision_id });
    expect(deniedByPolicy.find((r) => r.src === "policy")).toMatchObject({ decision: "DENY", reason: "kill_switch_active" });

    const deniedAfterPolicy = await timeline(lateTrace);
    const lateAudit = deniedAfterPolicy.find((r) => r.src === "audit")!;
    const latePolicy = deniedAfterPolicy.find((r) => r.src === "policy")!;
    expect(lateAudit).toMatchObject({ what: "tool.denied", reason: "credential_unavailable", decision_id: latePolicy.decision_id });
    expect(latePolicy).toMatchObject({ decision: "ALLOW" }); // policy slapp kallet gjennom - avslaget kom senere, og journalen viser nettopp det
  });
});

describe("en DØD journal endrer aldri et verktøyresultat, og revisjonsraden beholder decision_id", () => {
  it("samme resultat med og uten en fungerende journal; audit_events har fortsatt policy_decision_id; ingenting kastes; feilen er telt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dead = { connect: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } } as unknown as pg.Pool;
    const live = build(appPool);
    const down = build(dead);
    const params = { max: 2 };
    const a = await live.gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: params, task_id: "task-live", trace_id: "trace-live" });
    const b = await down.gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: params, task_id: "task-down", trace_id: "trace-down" });
    expect({ ok: b.ok }).toEqual({ ok: a.ok });
    await live.sink.flush();
    await down.sink.flush();
    expect(down.sink.stats()).toMatchObject({ queued: 1, consecutive_failures: 1, degraded: true });
    const audit = (await adminPool.query("SELECT type, payload->>'policy_decision_id' AS decision_id FROM audit_events WHERE tenant_id = $1 AND task_id = 'task-down'", [TENANT])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: "tool.executed" });
    expect(String(audit[0]!.decision_id)).toMatch(/^[0-9a-f-]{36}$/);
    // journalraden finnes IKKE (databasen var nede for sinken) - audit_events er den autoritative sporingen
    expect((await adminPool.query("SELECT 1 FROM policy_decisions WHERE decision_id = $1", [audit[0]!.decision_id])).rowCount).toBe(0);
    vi.restoreAllMocks();
  });
});
