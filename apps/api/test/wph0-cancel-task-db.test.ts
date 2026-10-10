import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions } from "@jarvis/executive";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H0 / JARVIS-087 - `executive.cancel_task` mot EKTE Postgres (app-rollen, RLS), EKTE ToolGateway/PolicyGateway og den EKSISTERENDE kanselleringsveien (`TaskService` + `PgTaskQueue.requestCancel`):
 *  - eieren avbryter en ikke startet jobb (direkte) og en kjørende (avbrudd forespurt) med riktig utfall i svaret og `task.cancelled` i revisjonssporet;
 *  - ferdig, pauset og ukjent jobb er «ikke avbrytbar» (ærlig svar), og en annen tenants jobb er usynlig (RLS) og urørt;
 *  - en annen person i samme tenant og en delegat NEKTES av eier-porten (tool.denied) og ingenting endres;
 *  - kill switch stopper også denne handlingen (den er ikke på selvgjenopprettingslisten).
 */
let db: H0Db;
const TENANT_A = "tenant-ct-a";
const TENANT_B = "tenant-ct-b";
const OWNER_A = "person-ct-a";
const OWNER_B = "person-ct-b";
const MEMBER = "person-ct-member";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed", ...extra
});
const ownerA = idFor(OWNER_A, TENANT_A);

let killSwitch: KillSwitch;
let gateway: ToolGateway;

async function task(id: string, tenant: string, owner: string, status: string): Promise<void> {
  await db.adminPool.query("INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract) VALUES ($1,$2,$3,'hemmelig mål',$4,'{}'::jsonb)", [id, tenant, owner, status]);
}
const row = async (id: string): Promise<{ status: string; cancel_requested: boolean }> =>
  (await db.adminPool.query("SELECT status, cancel_requested FROM tasks WHERE task_id = $1", [id])).rows[0] as { status: string; cancel_requested: boolean };
const auditTypes = async (type: string): Promise<Array<{ payload: { task_id?: string; outcome?: string } | null; decision: string | null }>> =>
  (await db.adminPool.query("SELECT payload, decision FROM audit_events WHERE type = $1 ORDER BY at", [type])).rows as Array<{ payload: { task_id?: string; outcome?: string } | null; decision: string | null }>;
const cancel = (identity: IdentityContext, taskId: string) => gateway.execute({ identity, tool_id: "executive", action: "cancel_task", parameters: { task_id: taskId } });

beforeAll(async () => {
  db = await startH0Db("ct");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: OWNER_A }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  await db.adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await db.adminPool.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  killSwitch = new KillSwitch();
  const authority = { owner_person_id: OWNER_A, owner_tenants: [TENANT_A] };
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch, authority });
  const taskService = new TaskService(db.appPool, new PgTaskQueue(db.appPool), policy);
  gateway = new ToolGateway(db.appPool, policy, secrets);
  // Gjennomgang av PR #316 (M-2): samme fabrikk og SAMME AuthorityConfig som PolicyGateway over - akkurat som main.ts.
  const registry = createControlCenterRegistry({ authority });
  const service = new ExecutiveService(gateway, { controlCenters: registry, tasks: { cancel: (identity, taskId) => taskService.cancel(identity, taskId) } });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service))) gateway.register(tool);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("eieren avbryter via den eksisterende kanselleringsveien", () => {
  it("ikke startet jobb: avbrytes direkte (outcome cancelled), status endres, og task.cancelled står i revisjonssporet", async () => {
    await task("task-created", TENANT_A, OWNER_A, "created");
    const r = await cancel(ownerA, "task-created");
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ data: { task_id: "task-created", cancelled: true, outcome: "cancelled" } });
    expect(await row("task-created")).toMatchObject({ status: "cancelled" });
    expect((await auditTypes("task.cancelled")).some((a) => a.payload?.task_id === "task-created" && a.payload.outcome === "cancelled")).toBe(true);
  });

  it("kjørende jobb: avbrudd FORESPURT (outcome requested) - statusen står til jobben når et trygt punkt", async () => {
    await task("task-running", TENANT_A, OWNER_A, "running");
    const r = await cancel(ownerA, "task-running");
    expect(r).toMatchObject({ ok: true, data: { cancelled: true, outcome: "requested" } });
    expect(await row("task-running")).toEqual({ status: "running", cancel_requested: true });
  });

  it("ferdig, pauset og ukjent jobb: «ikke avbrytbar» som et ærlig svar (ingen feil, ingen endring)", async () => {
    await task("task-done", TENANT_A, OWNER_A, "completed");
    await task("task-paused", TENANT_A, OWNER_A, "paused");
    for (const id of ["task-done", "task-paused", "task-finnes-ikke"]) {
      const r = await cancel(ownerA, id);
      expect(r, id).toMatchObject({ ok: true, data: { cancelled: false, outcome: "not_cancellable" } });
    }
    expect((await row("task-done")).status).toBe("completed");
    expect((await row("task-paused")).status).toBe("paused");
  });

  it("en annen tenants jobb er usynlig (RLS) og urørt - også når task_id er kjent", async () => {
    await task("task-b", TENANT_B, OWNER_B, "created");
    const r = await cancel(ownerA, "task-b");
    expect(r).toMatchObject({ ok: true, data: { cancelled: false, outcome: "not_cancellable" } });
    expect(await row("task-b")).toEqual({ status: "created", cancel_requested: false });
  });
});

describe("eier-porten", () => {
  it("en annen person i samme tenant og en delegat nektes (tool.denied), og jobben er urørt", async () => {
    await task("task-guarded", TENANT_A, OWNER_A, "running");
    const member = await cancel(idFor(MEMBER, TENANT_A), "task-guarded");
    expect(member).toMatchObject({ ok: false, reason: "control_center_owner_only" });
    const delegate = await cancel(idFor(OWNER_A, TENANT_A, { delegation_id: "deleg-1" }), "task-guarded");
    expect(delegate).toMatchObject({ ok: false, reason: "control_center_owner_only" });
    expect(await row("task-guarded")).toEqual({ status: "running", cancel_requested: false });
    const denied = await db.adminPool.query("SELECT reason FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = 'cancel_task'");
    expect(denied.rows.map((r) => (r as { reason: string }).reason)).toEqual(["control_center_owner_only", "control_center_owner_only"]);
  });

  it("kill switch stopper også avbryt (den er ikke på selvgjenopprettingslisten) - og jobben er urørt", async () => {
    await task("task-ks", TENANT_A, OWNER_A, "created");
    killSwitch.activate("test");
    try {
      const r = await cancel(ownerA, "task-ks");
      expect(r).toMatchObject({ ok: false, reason: "kill_switch_active" });
      expect((await row("task-ks")).status).toBe("created");
    } finally {
      killSwitch.deactivate();
    }
    expect(await cancel(ownerA, "task-ks")).toMatchObject({ ok: true, data: { outcome: "cancelled" } });
  });

  it("skjemaet avviser tenant-/identitetsfelt og ekstra felt FØR noe skjer", async () => {
    await task("task-schema", TENANT_A, OWNER_A, "created");
    for (const parameters of [{ task_id: "task-schema", tenant_id: TENANT_B }, { task_id: "task-schema", force: true }, { task_id: "" }, {}]) {
      const r = await gateway.execute({ identity: ownerA, tool_id: "executive", action: "cancel_task", parameters });
      expect(r, JSON.stringify(parameters)).toMatchObject({ ok: false, reason: "invalid_parameters" });
    }
    expect((await row("task-schema")).status).toBe("created");
  });
});
