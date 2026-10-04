import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations, withTenantTransaction, writeAudit } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "../src/index.ts";

/** D-394 (JARVIS-054): audit kan korreleres mot oppgave/spor, og systemhandlinger er merket som system. */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-d394", memory_space_id: "personal", session_id: "sess-d394",
  device_id: "jarvis-voice-live", channel: "voice", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get() { return "secret"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d394-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d394 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d394");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-d394','D394','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-d394');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_d394", password: "pw2" });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("JARVIS-054: revisjon som kan rekonstrueres", () => {
  it("ToolGateway.execute skriver task_id/trace_id på audit-radene for kallet", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
      authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
    });
    const gateway = new ToolGateway(appPool, policy, secrets);
    for (const tool of firstWaveTools({ calendar: new FakeTransport(() => ({ external_id: "evt" })) })) gateway.register(tool);
    const taskId = `task-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const result = await gateway.execute({
      identity, tool_id: "calendar", action: "create_event", task_id: taskId, trace_id: traceId, idempotency_key: `k-${randomUUID()}`,
      parameters: { title: "Møte", start: new Date().toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() }
    });
    expect(result.ok).toBe(true);
    const rows = (await adminPool.query("SELECT type, task_id, trace_id, actor_kind FROM audit_events WHERE task_id = $1", [taskId])).rows as Array<Record<string, string>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r["trace_id"] === traceId && r["actor_kind"] === "person")).toBe(true);
    expect(rows.some((r) => r["type"] === "tool.executed")).toBe(true);
  });

  it("en systemhandling (person_id=system) merkes actor_kind=system, og prosessnavnet lagres", async () => {
    process.env["JARVIS_PROCESS"] = "worker";
    try {
      await withTenantTransaction(appPool, "tenant-d394", (client) =>
        writeAudit(client, { tenant_id: "tenant-d394", person_id: "system" }, { type: "test.system_action", task_id: "task-sys-1" })
      );
    } finally {
      delete process.env["JARVIS_PROCESS"];
    }
    const row = (await adminPool.query("SELECT actor_kind, process, task_id FROM audit_events WHERE type = 'test.system_action'")).rows[0] as Record<string, string>;
    expect(row).toEqual({ actor_kind: "system", process: "worker", task_id: "task-sys-1" });
  });
});
