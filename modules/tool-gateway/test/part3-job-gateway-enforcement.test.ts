import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ToolDefinition, type ToolTransport } from "@jarvis/tool-gateway";

/** Del 3 (JARVIS-005/012): ekte ToolGateway håndhever jobbkontrakten ved UTFØRELSE (ikke bare skjemalisten). */
class T implements ToolTransport {
  calls = 0;
  async invoke(): Promise<{ external_id?: string; data?: JsonValue }> { this.calls += 1; return { external_id: "x", data: { ok: true } }; }
}
function def(action: string, transport: ToolTransport): ToolDefinition {
  return {
    tool_id: "demo", action, description: "d",
    input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "A", scopes: [], reversible: true, rollback_procedure: "ingen", idempotent_external: true,
    timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "DEMO_TOKEN", output_trust: "internal", transport
  };
}
const contract = (over: Partial<JobContract> = {}): JobContract => ({
  task_id: "job-1", owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "g", acceptance_criteria: ["ok"],
  input: { data: {}, trust_level: "internal", provenance: "chat" }, allowed_tools: ["demo.read"], allowed_memory_spaces: ["project"],
  allowed_network_targets: [], agent_profile: "executive", model_budget_ore: 100, retry_policy: { max_attempts: 1, backoff_seconds: 1 }, max_steps: 3,
  ...over
});

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let policy: PolicyGateway;
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "project", session_id: "job:job-1", device_id: "dev", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-p3j-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_p3j LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_p3j");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_p3j", password: "pw2" });
  policy = new PolicyGateway({
    devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
}, 240_000);
afterAll(async () => { await appPool?.end(); await adminPool?.end(); await stop?.(); }, 120_000);

function gw(t: T): ToolGateway {
  const g = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" });
  g.register(def("read", t));
  g.register(def("write", t));
  return g;
}

describe("gateway håndhever jobbkontrakten ved utførelse", () => {
  it("handling i allowed_tools (tool_id.action) tillates; andre handlinger i SAMME verktøy avvises", async () => {
    const t = new T(); const g = gw(t);
    expect((await g.execute({ identity, tool_id: "demo", action: "read", parameters: {}, jobContract: contract() })).ok).toBe(true);
    const denied = await g.execute({ identity, tool_id: "demo", action: "write", parameters: {}, jobContract: contract() });
    expect(denied).toEqual({ ok: false, reason: "tool_not_in_job_contract" });
    expect(t.calls).toBe(1);
  });
  it("tom allowed_tools tillater ingenting", async () => {
    const t = new T(); const g = gw(t);
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: {}, jobContract: contract({ allowed_tools: [] }) })).toEqual({ ok: false, reason: "tool_not_in_job_contract" });
    expect(t.calls).toBe(0);
  });
  it("hele verktøyet kan tillates med tool_id", async () => {
    const t = new T(); const g = gw(t);
    expect((await g.execute({ identity, tool_id: "demo", action: "write", parameters: {}, jobContract: contract({ allowed_tools: ["demo"] }) })).ok).toBe(true);
  });
  it("kontraktens eier/tenant må være identiteten som handler (job_identity_mismatch)", async () => {
    const t = new T(); const g = gw(t);
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: {}, jobContract: contract({ owner_person_id: "person-annen" }) })).toEqual({ ok: false, reason: "job_identity_mismatch" });
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: {}, jobContract: contract({ tenant_id: "tenant-b" }) })).toEqual({ ok: false, reason: "job_identity_mismatch" });
    expect(t.calls).toBe(0);
  });
});

describe("M8: scope fra identitet + credential-binding", () => {
  const binding = { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"], internalRefs: new Set(["INTERNAL_REF"]) };
  const bound = (t: T): ToolGateway => {
    const g = new ToolGateway(appPool, policy, { name: "t", get: async () => "cred" }, undefined, undefined, { credentialBinding: binding });
    g.register({ ...def("read", t), input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"] });
    g.register({ ...def("internal", t), credential_ref: "INTERNAL_REF" });
    return g;
  };
  const other: IdentityContext = { ...identity, person_id: "person-annen", tenant_id: "tenant-b", session_id: "s-b" };

  it("eieren i eierens tenant bruker eier-credentials", async () => {
    const t = new T();
    expect((await bound(t).execute({ identity, tool_id: "demo", action: "read", parameters: {} })).ok).toBe(true);
  });
  it("fremmed tenant/person kan IKKE bruke eierens leverandør-credential (selv for lesing)", async () => {
    const t = new T();
    expect(await bound(t).execute({ identity: other, tool_id: "demo", action: "read", parameters: {} })).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(t.calls).toBe(0);
  });
  it("samme tenant men ikke-eier person avvises", async () => {
    const t = new T();
    expect(await bound(t).execute({ identity: { ...identity, person_id: "person-annen" }, tool_id: "demo", action: "read", parameters: {} }))
      .toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
  });
  it("delegert identitet (delegation_id) arver aldri eierens credentials", async () => {
    const t = new T();
    expect(await bound(t).execute({ identity: { ...identity, delegation_id: "deleg-1" } as IdentityContext, tool_id: "demo", action: "read", parameters: {} }))
      .toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
  });
  it("interne (tenant-skopede) referanser er unntatt bindingen", async () => {
    const t = new T();
    expect((await bound(t).execute({ identity: other, tool_id: "demo", action: "internal", parameters: {} })).ok).toBe(true);
  });
  it("parameter tenant_id/person_id/actor_person_id som ikke er identiteten avvises; samsvarende godtas", async () => {
    const t = new T(); const g = bound(t);
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: { tenant_id: "tenant-b" } })).toEqual({ ok: false, reason: "scope_mismatch:tenant_id" });
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: { person_id: "person-annen" } })).toEqual({ ok: false, reason: "scope_mismatch:person_id" });
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: { actor_person_id: "person-annen" } })).toEqual({ ok: false, reason: "scope_mismatch:actor_person_id" });
    expect((await g.execute({ identity, tool_id: "demo", action: "read", parameters: { tenant_id: "tenant-a", person_id: "person-tobias" } })).ok).toBe(true);
    expect(t.calls).toBe(1);
  });
  it("owner_person_id: eieren kan tildele en annen person; en annen identitet kan ikke utgi seg for eieren", async () => {
    const t = new T(); const g = bound(t);
    expect((await g.execute({ identity, tool_id: "demo", action: "read", parameters: { owner_person_id: "person-annen" } })).ok).toBe(true);
    expect(await g.execute({ identity: other, tool_id: "demo", action: "internal", parameters: { owner_person_id: "person-tobias" } })).toEqual({ ok: false, reason: "scope_mismatch:owner_person_id" });
  });
  it("jobb: memory_space utenfor kontraktens allowed_memory_spaces avvises", async () => {
    const t = new T(); const g = bound(t);
    const c = contract({ allowed_tools: ["demo"], allowed_memory_spaces: ["project"] });
    expect(await g.execute({ identity, tool_id: "demo", action: "read", parameters: { memory_space: "health" }, jobContract: c })).toEqual({ ok: false, reason: "job_memory_space_not_allowed" });
    expect((await g.execute({ identity, tool_id: "demo", action: "read", parameters: { memory_space: "project" }, jobContract: c })).ok).toBe(true);
  });
});
