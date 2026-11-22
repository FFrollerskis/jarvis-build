import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgPolicyAuditSink, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { DailyScheduler, FakeTransport, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import {
  BusinessEventSyncService, BusinessInternalSecretProvider, BusinessService, BusinessTransport, OpenLoopService, ScoringService, runBusinessEventSyncForAllTenants
} from "../src/index.ts";

/**
 * WP-K (D-471, JARVIS-054) ende-til-ende mot ekte Postgres: en PLANLAGT `person_id: "system"`-synk (DailyScheduler -> sveip -> ToolGateway -> PolicyGateway -> audit_events + policy_decisions) kan
 * rekonstrueres fra oppgave-/spor-ID og avgjørelses-ID, og et NØSTET system-kall (eierens `business.sync_business_events`) arver det ytre kallets korrelasjon. Uten korrelasjon er radene uendret.
 */
const TENANT = "tenant-wpk054";
const owner: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-owner-054", device_id: "dev-owner", channel: "api", auth_strength: "active"
};

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let sink: PgPolicyAuditSink;
let service: BusinessService;
let openLoops: OpenLoopService;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk054-e2e-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpk054_e2e LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpk054_e2e");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','WPK054','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpk054-business','${TENANT}','business');
  `);
  appPool = createPool({ ...base, user: "jarvis_wpk054_e2e", password: "pw2" });
  appPool.on("error", () => undefined);

  sink = new PgPolicyAuditSink({ pool: appPool, autoFlush: false, processName: "api" });
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }, auditSink: sink.write
  });
  gateway = new ToolGateway(
    appPool, policy,
    new FallbackSecretProvider(
      { name: "test-google-static", get: async (ref) => (ref === "JARVIS_EMAIL_TOKEN" || ref === "JARVIS_GOOGLE_TOKEN" ? "fake-token-for-test" : null) },
      new BusinessInternalSecretProvider()
    )
  );
  service = new BusinessService(appPool);
  openLoops = new OpenLoopService(appPool);
  for (const tool of firstWaveTools({
    business: new BusinessTransport(service, openLoops, appPool, gateway, new ScoringService(appPool)),
    email: new FakeTransport(() => ({ data: { messages: [] } })),
    calendar: new FakeTransport(() => ({ data: { events: [] } }))
  })) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

interface Joined { tool_id: string; action: string; type: string; actor_kind: string; task_id: string | null; trace_id: string | null; decision: string; p_actor: string; p_task: string | null; p_trace: string | null }

/** audit_events <-> policy_decisions: ett vanlig join på decision_id (ingen gjetting på tidsstempel). */
const joinedFor = async (taskId: string): Promise<Joined[]> =>
  (await adminPool.query(
    `SELECT a.tool_id, a.action, a.type, a.actor_kind, a.task_id, a.trace_id, p.decision, p.actor_kind AS p_actor, p.task_id AS p_task, p.trace_id AS p_trace
       FROM audit_events a JOIN policy_decisions p ON p.tenant_id = a.tenant_id AND p.decision_id = a.payload->>'policy_decision_id'
      WHERE a.tenant_id = $1 AND a.task_id = $2 ORDER BY a.tool_id, a.action`, [TENANT, taskId]
  )).rows as Joined[];

describe("planlagt `system`-synk: hele kjeden fra scheduler til policy-journal", () => {
  it("revisjonsrader og policy-avgjørelser fra samme kjøring deler task_id/trace_id og kobles via decision_id; begge merket `system`", async () => {
    const scheduler = new DailyScheduler(appPool, "wpk054-business-events-sync", 0);
    const run = (await scheduler.claimTodayRun())!;
    expect(run).not.toBeNull();

    await runBusinessEventSyncForAllTenants(appPool, new BusinessEventSyncService(gateway, service, openLoops, "owner@example.test"), undefined, run);
    await sink.flush();

    const rows = await joinedFor(run.task_id);
    expect(rows.map((r) => `${r.tool_id}.${r.action}`)).toEqual(["calendar.list_events", "email.list_messages"]);
    for (const row of rows) {
      expect(row).toMatchObject({ type: "tool.executed", actor_kind: "system", task_id: run.task_id, trace_id: run.trace_id });
      expect(row).toMatchObject({ decision: "ALLOW", p_actor: "system", p_task: run.task_id, p_trace: run.trace_id });
    }
    // Ingen revisjonsrad fra kjøringen mangler avgjørelses-ID (alle ble knyttet til sin policy-avgjørelse).
    const orphan = await adminPool.query(
      "SELECT 1 FROM audit_events WHERE tenant_id = $1 AND task_id = $2 AND payload->>'policy_decision_id' IS NULL", [TENANT, run.task_id]
    );
    expect(orphan.rowCount).toBe(0);
  });

  it("uten korrelasjon (eksisterende kallere) skrives raden som før: ingen task_id/trace_id, men decision_id er likevel på plass", async () => {
    await runBusinessEventSyncForAllTenants(appPool, new BusinessEventSyncService(gateway, service, openLoops, "owner@example.test"));
    const after = (await adminPool.query(
      `SELECT task_id, trace_id, actor_kind, payload->>'policy_decision_id' AS decision_id FROM audit_events
        WHERE tenant_id = $1 AND session_id = $2 ORDER BY audit_id DESC LIMIT 2`, [TENANT, `business-events-sync-${TENANT}`]
    )).rows as Array<{ task_id: string | null; trace_id: string | null; actor_kind: string; decision_id: string | null }>;
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.task_id).toBeNull();
      expect(row.trace_id).toBeNull();
      expect(row.actor_kind).toBe("system");
      expect(row.decision_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("nøstet `system`-kall (eierens business.sync_business_events) arver det ytre kallets korrelasjon", () => {
  const nestedRows = async (taskId: string | null) =>
    (await adminPool.query(
      `SELECT tool_id, action, actor_kind, session_id, task_id, trace_id, payload->>'policy_decision_id' AS decision_id FROM audit_events
        WHERE tenant_id = $1 AND session_id = $2 AND task_id IS NOT DISTINCT FROM $3 ORDER BY tool_id`, [TENANT, `business-events-sync-${TENANT}`, taskId]
    )).rows as Array<{ tool_id: string; action: string; actor_kind: string; session_id: string; task_id: string | null; trace_id: string | null; decision_id: string | null }>;

  it("ytre kall MED task_id/trace_id: de nøstede email/calendar-radene (system) bærer de samme ID-ene, og det ytre kallet har sin egen rad", async () => {
    const result = await gateway.execute({
      identity: owner, tool_id: "business", action: "sync_business_events",
      parameters: { tenant_id: TENANT, memory_space: "business" }, task_id: "task-outer-054", trace_id: "trace-outer-054"
    });
    expect(result.ok).toBe(true);
    const nested = await nestedRows("task-outer-054");
    expect(nested.map((r) => `${r.tool_id}.${r.action}`)).toEqual(["calendar.list_events", "email.list_messages"]);
    for (const row of nested) {
      expect(row).toMatchObject({ actor_kind: "system", task_id: "task-outer-054", trace_id: "trace-outer-054" });
      expect(row.decision_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const outer = (await adminPool.query(
      "SELECT actor_kind, trace_id, payload->>'policy_decision_id' AS decision_id FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'sync_business_events' AND task_id = 'task-outer-054'", [TENANT]
    )).rows;
    expect(outer).toHaveLength(1);
    expect(outer[0]).toMatchObject({ actor_kind: "person", trace_id: "trace-outer-054" });
    // ytre og nøstede avgjørelser er ulike avgjørelser (hver har sin egen ID)
    expect(new Set([outer[0]!.decision_id, ...nested.map((r) => r.decision_id)]).size).toBe(3);
  });
});
