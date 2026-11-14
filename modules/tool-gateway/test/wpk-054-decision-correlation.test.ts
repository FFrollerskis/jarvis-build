import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signApproval, type ApprovalPayload, type IdentityContext, type SignedApproval } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway, type PolicyAuditEvent } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider, type ToolInvocationContext, type ToolTransport } from "../src/index.ts";

/**
 * WP-K (D-471, JARVIS-054): «hva skjedde kl. 03:17» krever at policy-avgjørelsen og revisjonsraden den førte til kan kobles - i begge retninger - og at kallerens oppgave-/spor-ID følger med.
 * Ekte embedded Postgres + ekte PolicyGateway (med en fangende sink) + ekte ToolGateway. Beviser: (1) `payload.policy_decision_id` i `tool.executed`/`tool.denied`-radene = `decision_id` i
 * policy-hendelsen, (2) avslag ETTER policy bærer ALLOW-avgjørelsens ID og avslag AV policy bærer DENY-avgjørelsens, (3) en feilet nonce-commit refererer til den NYE DENY-avgjørelsen,
 * (4) avslag FØR policy (ukjent verktøy) har ingen avgjørelse å peke på, men fortsatt oppgave-/spor-ID, (5) transporten får korrelasjonen i konteksten.
 */
const TENANT = "tenant-wpk54";
const watchKeys = generateKeyPairSync("ed25519");
const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-wpk54", device_id: "dev-pc", channel: "web", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get(ref) { return ref === "JARVIS_REVOKED_TOKEN" ? null : `secret-for-${ref}`; } };

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let killSwitch: KillSwitch;
const events: PolicyAuditEvent[] = [];
const seenContexts: ToolInvocationContext[] = [];

const approval = (parameters: Record<string, string>, overrides: Partial<Omit<ApprovalPayload, "parameters_hash">> = {}): SignedApproval =>
  signApproval(watchKeys.privateKey, {
    tool_id: "email", action: "send", tenant_id: TENANT, person_id: "person-tobias", approver_person_id: "person-tobias",
    parameters, nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-1", ...overrides
  });

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpk54-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpk54 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpk54");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','WPK54','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_wpk54", password: "pw2", max: 10 });
  appPool.on("error", () => undefined);

  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey, { tenant_id: TENANT, person_id: "person-tobias" });
  killSwitch = new KillSwitch();
  // Legacy SCOPED-modus (ingen `authority`): klasse D krever signert godkjenning - gir både ALLOW-pending-commit og nonce-DENY-stiene vi vil observere.
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch, auditSink: (e) => { events.push(e); } });
  const spy: ToolTransport = {
    async invoke(action, _p, _c, context) { seenContexts.push(context); return { external_id: `msg-${action}`, data: { messages: [] } }; }
  };
  gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ email: spy, calendar: new FakeTransport(() => ({ external_id: "evt" })) })) gateway.register(tool);
  const readInbox = gateway.get("email", "read_inbox")!;
  gateway.register({ ...readInbox, tool_id: "email_revoked", credential_ref: "JARVIS_REVOKED_TOKEN" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const auditRows = async (taskId: string) =>
  (await adminPool.query(
    "SELECT type, decision, reason, task_id, trace_id, payload->>'policy_decision_id' AS decision_id FROM audit_events WHERE tenant_id = $1 AND task_id = $2 ORDER BY audit_id",
    [TENANT, taskId]
  )).rows as Array<{ type: string; decision: string | null; reason: string | null; task_id: string; trace_id: string | null; decision_id: string | null }>;
const eventsOf = (taskId: string): PolicyAuditEvent[] => events.filter((e) => e.task_id === taskId);

describe("A: revisjonsraden peker på policy-avgjørelsen, og oppgave-/spor-ID følger begge", () => {
  it("vellykket kall: tool.executed har task_id/trace_id og policy_decision_id = ID-en til ALLOW-avgjørelsen (som bærer samme korrelasjon)", async () => {
    const task = `task-${randomUUID()}`;
    const result = await gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 3 }, task_id: task, trace_id: "trace-a" });
    expect(result.ok).toBe(true);
    const [event] = eventsOf(task);
    expect(event).toMatchObject({ decision: "ALLOW", reason: "class_a_read", tool_id: "email", action: "read_inbox", trace_id: "trace-a" });
    const rows = await auditRows(task);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "tool.executed", decision: "ALLOW", task_id: task, trace_id: "trace-a", decision_id: event!.decision_id });
  });

  it("avslag AV policy (kill switch): tool.denied bærer DENY-avgjørelsens ID og korrelasjonen", async () => {
    const task = `task-${randomUUID()}`;
    killSwitch.activate("test");
    try {
      const result = await gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 3 }, task_id: task, trace_id: "trace-b" });
      expect(result).toEqual({ ok: false, reason: "kill_switch_active" });
    } finally {
      killSwitch.deactivate();
    }
    const [event] = eventsOf(task);
    expect(event).toMatchObject({ decision: "DENY", reason: "kill_switch_active" });
    expect(await auditRows(task)).toEqual([
      { type: "tool.denied", decision: "DENY", reason: "kill_switch_active", task_id: task, trace_id: "trace-b", decision_id: event!.decision_id }
    ]);
  });

  it("avslag ETTER policy (credential utilgjengelig): policy sa ALLOW, og raden peker på akkurat den ALLOW-avgjørelsen", async () => {
    const task = `task-${randomUUID()}`;
    const result = await gateway.execute({ identity, tool_id: "email_revoked", action: "read_inbox", parameters: { max: 3 }, task_id: task });
    expect(result).toEqual({ ok: false, reason: "credential_unavailable" });
    const [event] = eventsOf(task);
    expect(event).toMatchObject({ decision: "ALLOW" });
    const rows = await auditRows(task);
    expect(rows).toEqual([{ type: "tool.denied", decision: "DENY", reason: "credential_unavailable", task_id: task, trace_id: null, decision_id: event!.decision_id }]);
  });

  it("avslag FØR policy (ukjent verktøy): ingen avgjørelse å peke på, men oppgave-/spor-ID er med", async () => {
    const task = `task-${randomUUID()}`;
    const result = await gateway.execute({ identity, tool_id: "finnes_ikke", action: "x", parameters: {}, task_id: task, trace_id: "trace-c" });
    expect(result).toEqual({ ok: false, reason: "unknown_tool" });
    expect(eventsOf(task)).toHaveLength(0);
    expect(await auditRows(task)).toEqual([{ type: "tool.denied", decision: "DENY", reason: "unknown_tool", task_id: task, trace_id: "trace-c", decision_id: null }]);
  });

  it("klasse D: godkjent kall peker på ALLOW(pending commit); replay av samme nonce peker på den NYE DENY-avgjørelsen (ikke den foreløpige ALLOW-en)", async () => {
    const parameters = { to: "kunde@example.com", subject: "Tilbud", body: "Hei" };
    const signed = approval(parameters);
    const first = `task-${randomUUID()}`;
    expect((await gateway.execute({ identity, tool_id: "email", action: "send", parameters, approval: signed, task_id: first })).ok).toBe(true);
    const [pending] = eventsOf(first);
    expect(pending).toMatchObject({ decision: "ALLOW", reason: "class_d_valid_signed_approval_pending_commit" });
    expect((await auditRows(first))[0]).toMatchObject({ type: "tool.executed", decision_id: pending!.decision_id });

    const replay = `task-${randomUUID()}`;
    const result = await gateway.execute({ identity, tool_id: "email", action: "send", parameters, approval: signed, task_id: replay });
    expect(result).toEqual({ ok: false, reason: "class_d_nonce_already_used" });
    const replayEvents = eventsOf(replay);
    expect(replayEvents.map((e) => [e.decision, e.reason])).toEqual([
      ["ALLOW", "class_d_valid_signed_approval_pending_commit"], ["DENY", "class_d_nonce_already_used"]
    ]);
    const rows = await auditRows(replay);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "tool.denied", reason: "class_d_nonce_already_used", decision_id: replayEvents[1]!.decision_id });
    expect(rows[0]!.decision_id).not.toBe(replayEvents[0]!.decision_id);
  });
});

describe("B: korrelasjonen til nøstede kall, og bakoverkompatibilitet", () => {
  it("transporten får oppgave-/spor-ID i konteksten (så et nøstet kall som system-synken kan bære dem videre) - og ingen når kalleren ikke har noen", async () => {
    seenContexts.length = 0;
    await gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 1 }, task_id: "task-ctx", trace_id: "trace-ctx" });
    await gateway.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 1 } });
    expect(seenContexts[0]).toMatchObject({ task_id: "task-ctx", trace_id: "trace-ctx" });
    expect("task_id" in seenContexts[1]!).toBe(false);
    expect("trace_id" in seenContexts[1]!).toBe(false);
  });

  it("en policy uten decision_id (eldre/falsk implementasjon) gir uendrede revisjonsrader: ingen policy_decision_id i payload", async () => {
    const stub = { authorize: async () => ({ decision: "ALLOW" as const, reason: "stub" }) } as unknown as PolicyGateway;
    const g = new ToolGateway(appPool, stub, secrets);
    for (const tool of firstWaveTools({ email: new FakeTransport(() => ({ external_id: "x" })) })) g.register(tool);
    const task = `task-${randomUUID()}`;
    expect((await g.execute({ identity, tool_id: "email", action: "read_inbox", parameters: { max: 1 }, task_id: task })).ok).toBe(true);
    const rows = await auditRows(task);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "tool.executed", decision_id: null });
    const payload = (await adminPool.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND task_id = $2", [TENANT, task])).rows[0] as { payload: Record<string, unknown> };
    expect("policy_decision_id" in payload.payload).toBe(false);
  });
});
