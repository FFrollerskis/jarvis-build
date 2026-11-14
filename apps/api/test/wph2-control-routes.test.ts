import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ChannelSessionAuthority, DeviceService, IdentityService, SessionGrantService, SessionService } from "@jarvis/core";
import { ExecutiveService, ExecutiveTransport, composeInfraStatus, executiveToolDefinitions, type InfraStatusReport } from "@jarvis/executive";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { createGoldenSuiteRunner } from "../src/golden-suite-runner.ts";
import { createApiServer } from "../src/server.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";
import { generateDeviceKey, mintGrant, type TestDeviceKey } from "./support/grant-client.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H2 - ATFERD over ekte HTTP + ekte Postgres (app-rolle, RLS) + ekte ToolGateway/PolicyGateway + EKTE situasjonsmotor og kill switch:
 *  - `revoke_autonomy_binding` (tilbakekall av eierens autonomi-binding) og `run_golden_suite` (golden-suite-knappen) går gjennom `/executive/mutate`: samme avslagsrekkefølge, step-up, eier-port og revisjon som de øvrige knappene;
 *  - kun den suverene eieren fra en signert enhetsøkt slipper gjennom (annen person i samme tenant og annen tenants eier nektes av verktøyets port, med revisjonsrad); kill switch stopper begge;
 *  - tilbakekallet fjerner NØYAKTIG én rad (identitetens egen tenant og eget minnerom): andre domener, andre rom og andre tenanter er urørt; en gjentatt tilbakekalling er trygg (`removed: false`);
 *  - Autoritet-senteret tilbyr knappen kun for bindinger i økta sitt eget rom, og Sikkerhet-senteret viser golden-suite-resultatet kjøringen ga (digester, null modellkall);
 *  - FLAGGENE AV: verktøyene finnes ikke (`unknown_tool`), knappene finnes ikke, og Autoritet-senteret er uendret fra H0 (tilbakekall er DEFERRED).
 */
let db: H0Db;
let on: Stack;
let off: Stack;
let engine: SituationEngine;
let killSwitch: KillSwitch;
let policy: PolicyGateway;
let ownerControls: OwnerControls;
const closers: Array<() => Promise<void>> = [];

const TENANT_A = "tenant-h2r-a";
const TENANT_B = "tenant-h2r-b";
const OWNER = "person-h2r-owner";
const MEMBER = "person-h2r-member";
const STRANGER = "person-h2r-b";
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
const keys: Record<string, TestDeviceKey> = { "h2r-dev-owner": generateDeviceKey(), "h2r-dev-member": generateDeviceKey(), "h2r-dev-b": generateDeviceKey(), "h2r-dev-owner-tg": generateDeviceKey() };
const SUBJECTS = {
  owner: { device_id: "h2r-dev-owner", person_id: OWNER, tenant_id: TENANT_A, memory_space: "personal" },
  member: { device_id: "h2r-dev-member", person_id: MEMBER, tenant_id: TENANT_A, memory_space: "personal" },
  stranger: { device_id: "h2r-dev-b", person_id: STRANGER, tenant_id: TENANT_B, memory_space: "personal" }
} as const;
const grants: Record<keyof typeof SUBJECTS, string> = { owner: "", member: "", stranger: "" };
let weakGrant: string | undefined;
const secrets: SecretProvider = { name: "fake", get: async () => "fake" };
const HEX64 = /^[0-9a-f]{64}$/;
const ALL_ON: Record<string, string> = {
  ...Object.fromEntries(Object.values(CONTROL_CENTER_FLAGS).map((f) => [f, "on"])),
  [CONTROL_FEATURE_FLAGS.goldenSuite]: "on",
  [CONTROL_FEATURE_FLAGS.autonomyRevoke]: "on"
};

interface Stack { baseUrl: string; gateway: ToolGateway }
interface Resp { status: number; body: Record<string, unknown> }

function infra(): InfraStatusReport {
  return composeInfraStatus({
    as_of: new Date(),
    measurements: { incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 }, last_changes: {}, producer_runs: [], errors: [] },
    producers_enabled: true, producers_interval_ms: 300_000, producer_names: ["scheduler"], infra_mode: "NORMAL", targets: []
  });
}

async function startStack(env: Record<string, string>, goldenOn: boolean, revokeOn: boolean): Promise<Stack> {
  const gateway = new ToolGateway(db.appPool, policy, secrets);
  const registry = createControlCenterRegistry({ authority });
  const runner = goldenOn ? createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE }) : undefined;
  registerControlCenters(registry, {
    pool: db.appPool, env, toolGateway: gateway, ownerControls, killSwitch, authority,
    infraStatus: async () => infra(), backupStatus: async () => ({ kind: "missing" }), processStartedAt: () => new Date(Date.now() - 3_600_000),
    ...(runner ? { goldenSuite: runner } : {})
  });
  const service = new ExecutiveService(gateway, { controlCenters: registry, ...(runner ? { goldenSuite: runner } : {}) });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { goldenSuite: runner !== undefined, autonomyRevoke: revokeOn })) gateway.register(tool);
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER })))) gateway.register(tool);

  const identityService = new IdentityService(db.appPool);
  const sessionService = new SessionService(db.appPool);
  const deviceService = new DeviceService(db.appPool);
  const grantService = new SessionGrantService(db.appPool);
  const server = createApiServer({
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    channelAuthority: new ChannelSessionAuthority({ pool: db.appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy: {} as never, worker: {} as never, conversation: {} as never, executive: { gateway },
    rateLimits: { perIpPerMinute: 100_000, authPerIpPerMinute: 100_000, perDevicePerMinute: 100_000 },
    owner: { tenant_id: TENANT_A, person_id: OWNER }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, gateway };
}

async function post(stack: Stack, path: string, body: unknown): Promise<Resp> {
  const res = await fetch(`${stack.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = { __raw: text }; }
  return { status: res.status, body: parsed };
}
const mutate = (stack: Stack, grant: string, action: string, parameters: Record<string, unknown> = {}): Promise<Resp> => post(stack, "/executive/mutate", { grant_token: grant, action, parameters });
const center = async (stack: Stack, grant: string, id: string): Promise<{ status: number; report?: CenterReport | undefined; raw: Resp }> => {
  const r = await post(stack, "/control/center", { grant_token: grant, center: id });
  return { status: r.status, report: (r.body["data"] as { report?: CenterReport } | undefined)?.report, raw: r };
};
interface CenterReport {
  center: string; status: string;
  sections: Array<{ id: string; status: string; measured: boolean; summary_no: string; items: Array<{ id: string; status: string; detail_no?: string; facts?: Record<string, unknown> }> }>;
  actions: Array<{ id: string; endpoint: string; body: { action: string; parameters?: Record<string, unknown> }; risk_class: string; requires_step_up: boolean; reversible: boolean; section_id?: string; item_id?: string }>;
}

const policyRows = async (): Promise<Array<{ tenant_id: string; memory_space_id: string; domain: string }>> =>
  (await db.adminPool.query("SELECT tenant_id, memory_space_id, domain FROM situation_autonomy_policies ORDER BY tenant_id, memory_space_id, domain")).rows as Array<{ tenant_id: string; memory_space_id: string; domain: string }>;
const auditRows = async (type: string, toolId: string, action: string): Promise<Array<{ reason: string | null; person_id: string }>> =>
  (await db.adminPool.query("SELECT reason, person_id FROM audit_events WHERE type = $1 AND tool_id = $2 AND action = $3 ORDER BY audit_id", [type, toolId, action])).rows as Array<{ reason: string | null; person_id: string }>;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tasks", "owner_control_state", "memory_items", "payment_intents"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}
const bind = (tenant: string, space: IdentityContext["memory_space_id"], domain: string): Promise<unknown> =>
  engine.setAutonomyPolicy(tenant, space, { domain, tool_id: "test_actuator", action: "assign", parameters: { open_loop_id: "{{source_open_loop_id}}", assignee: OWNER } }, OWNER);

beforeAll(async () => {
  db = await startH0Db("h2r");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: STRANGER }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  await admin.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-h2r-a-p','${TENANT_A}','personal'), ('sp-h2r-a-b','${TENANT_A}','business'), ('sp-h2r-b-p','${TENANT_B}','personal')`);
  for (const [id, subject] of [["h2r-dev-owner", SUBJECTS.owner], ["h2r-dev-member", SUBJECTS.member], ["h2r-dev-b", SUBJECTS.stranger], ["h2r-dev-owner-tg", SUBJECTS.owner]] as const) {
    await admin.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,'api',$4)", [id, subject.tenant_id, subject.person_id, keys[id]!.publicKeyPem]);
  }
  killSwitch = new KillSwitch(db.appPool, { owner_person_id: OWNER });
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, { owner_person_id: OWNER });
  await ownerControls.restore();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, authority });
  const pauses = new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER });
  await pauses.restore();
  engine = new SituationEngine(db.appPool, pauses, { owner_person_id: OWNER });
  // eierens bindinger: A/personal (pipeline, spend), A/business (pipeline, growth), A/health (wellbeing - isolert rom), B/personal (pipeline; bundet av B sin egen person - FK-en krever at aktøren er medlem av policyens tenant)
  await bind(TENANT_A, "personal", "pipeline");
  await bind(TENANT_A, "personal", "spend");
  await bind(TENANT_A, "business", "pipeline");
  await bind(TENANT_A, "business", "growth");
  await bind(TENANT_A, "health", "wellbeing");
  await admin.query(
    "INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, actor_person_id) VALUES ($1, 'personal', 'pipeline', 'test_actuator', 'assign', '{}'::jsonb, $2)",
    [TENANT_B, STRANGER]
  );

  on = await startStack(ALL_ON, true, true);
  off = await startStack({}, false, false);
  grants.owner = await mintGrant(on.baseUrl, SUBJECTS.owner, keys["h2r-dev-owner"]!);
  grants.member = await mintGrant(on.baseUrl, SUBJECTS.member, keys["h2r-dev-member"]!);
  grants.stranger = await mintGrant(on.baseUrl, SUBJECTS.stranger, keys["h2r-dev-b"]!);
  try { weakGrant = await mintGrant(on.baseUrl, { ...SUBJECTS.owner, device_id: "h2r-dev-owner-tg", channel: "telegram" }, keys["h2r-dev-owner-tg"]!); } catch { weakGrant = undefined; }
}, 240_000);

afterAll(async () => {
  for (const close of closers) await close();
  await db?.stop();
}, 120_000);

describe("A: avslag i samme rekkefølge som de øvrige knappene (handling → grant → step-up → verktøyets port)", () => {
  it("de to handlingene står i den lukkede listen; en ukjent handling avvises FØR grantet løses", async () => {
    expect((await mutate(on, "bogus", "revoke_everything")).body).toMatchObject({ error: "malformed_request", reason: "action_not_allowed" });
    // gyldig handlingsnavn + bogus grant: grantet avvises (identity_denied), ikke handlingen
    for (const action of ["revoke_autonomy_binding", "run_golden_suite"]) {
      const r = await mutate(on, "bogus", action, {});
      expect(r.status, action).toBe(403);
      expect(r.body["error"], action).toBe("identity_denied");
    }
    expect((await post(on, "/executive/mutate", { action: "run_golden_suite" })).status).toBe(401);
  });

  it("strengt skjema: tomt/manglende domene, identitetsfelt og ekstra felt gir invalid_parameters - og ingenting slettes", async () => {
    const before = await policyRows();
    for (const parameters of [{}, { domain: "" }, { domain: 5 }, { domain: "x".repeat(101) }, { domain: "pipeline", tenant_id: TENANT_B }, { domain: "pipeline", memory_space: "business" }, { domain: "pipeline", actor_person_id: OWNER }, { domain: "pipeline", all: true }]) {
      const r = await mutate(on, grants.owner, "revoke_autonomy_binding", parameters);
      expect(r.status, JSON.stringify(parameters)).toBe(403);
      expect(r.body, JSON.stringify(parameters)).toMatchObject({ error: "tool_denied", reason: "invalid_parameters" });
    }
    const gs = await mutate(on, grants.owner, "run_golden_suite", { suite: "annen" });
    expect(gs.body).toMatchObject({ error: "tool_denied", reason: "invalid_parameters" });
    expect(await policyRows()).toEqual(before);
  });

  it("step-up: en svakere kanal (Telegram) nektes FØR verktøyet nås - begge handlingene, uten revisjonsrad fra verktøyet og uten sletting", async () => {
    expect(weakGrant, "grant fra en Telegram-kanal kunne ikke utstedes - da ville step-up-testen vært hul").toBeDefined();
    const before = await policyRows();
    const deniedBefore = (await auditRows("tool.denied", "executive", "revoke_autonomy_binding")).length;
    for (const action of ["revoke_autonomy_binding", "run_golden_suite"]) {
      const r = await mutate(on, weakGrant as string, action, action === "revoke_autonomy_binding" ? { domain: "pipeline" } : {});
      expect(r.status, action).toBe(403);
      expect(r.body["error"], action).toBe("step_up_required");
    }
    expect(await policyRows()).toEqual(before);
    expect((await auditRows("tool.denied", "executive", "revoke_autonomy_binding")).length).toBe(deniedBefore);
  });
});

describe("B: revoke_autonomy_binding - nøyaktig én rad, i identitetens eget rom og egen tenant", () => {
  it("eieren: 200, bindingen for domenet er borte - andre domener, andre rom og andre tenanter er urørt", async () => {
    expect((await policyRows()).map((r) => `${r.tenant_id}/${r.memory_space_id}/${r.domain}`)).toEqual([
      `${TENANT_A}/business/growth`, `${TENANT_A}/business/pipeline`, `${TENANT_A}/health/wellbeing`, `${TENANT_A}/personal/pipeline`, `${TENANT_A}/personal/spend`, `${TENANT_B}/personal/pipeline`
    ]);
    const r = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "pipeline" });
    expect(r.status).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["data"]).toMatchObject({ removed: true, domain: "pipeline", memory_space: "personal" });
    expect((await policyRows()).map((x) => `${x.tenant_id}/${x.memory_space_id}/${x.domain}`)).toEqual([
      `${TENANT_A}/business/growth`, `${TENANT_A}/business/pipeline`, `${TENANT_A}/health/wellbeing`, `${TENANT_A}/personal/spend`, `${TENANT_B}/personal/pipeline`
    ]);
  });

  it("revidert: både det ytre executive-kallet og det nøstede situations.clear_autonomy_policy står som utført, med eierens person", async () => {
    const outer = await auditRows("tool.executed", "executive", "revoke_autonomy_binding");
    const inner = await auditRows("tool.executed", "situations", "clear_autonomy_policy");
    expect(outer.length).toBeGreaterThanOrEqual(1);
    expect(inner.length).toBeGreaterThanOrEqual(1);
    expect(outer.every((row) => row.person_id === OWNER)).toBe(true);
    expect(inner.every((row) => row.person_id === OWNER)).toBe(true);
  });

  it("idempotent: å tilbakekalle samme domene igjen er trygt (removed: false) og endrer ingenting", async () => {
    const before = await policyRows();
    const r = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "pipeline" });
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ removed: false, domain: "pipeline", memory_space: "personal" });
    expect(await policyRows()).toEqual(before);
  });

  it("et domene som kun er bundet i et ANNET rom (business/growth) røres ikke fra en økt i personal: removed: false", async () => {
    const before = await policyRows();
    const r = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "growth" });
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ removed: false, domain: "growth", memory_space: "personal" });
    expect(await policyRows()).toEqual(before);
  });

  it("health-rommet er isolert: en binding der kan ikke tilbakekalles herfra (removed: false, raden er urørt)", async () => {
    const before = await policyRows();
    const r = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "wellbeing" });
    expect(r.status).toBe(200);
    expect(r.body["data"]).toMatchObject({ removed: false, domain: "wellbeing" });
    expect(await policyRows()).toEqual(before);
    expect(before.some((row) => row.memory_space_id === "health" && row.domain === "wellbeing")).toBe(true);
  });

  it("annen person i eierens tenant og annen tenants eier nektes (klasse C uten mandat - policyen avviser FØR verktøyets egen eier-port) - bindingene er urørt, og avslagene står som tool.denied", async () => {
    const before = await policyRows();
    const deniedBefore = (await auditRows("tool.denied", "executive", "revoke_autonomy_binding")).length;
    for (const [who, grant] of [["member", grants.member], ["stranger", grants.stranger]] as const) {
      const r = await mutate(on, grant, "revoke_autonomy_binding", { domain: "spend" });
      expect(r.status, who).toBe(403);
      expect(r.body, who).toMatchObject({ error: "tool_denied", reason: "class_c_no_mandate" });
    }
    expect(await policyRows()).toEqual(before);
    const denied = await auditRows("tool.denied", "executive", "revoke_autonomy_binding");
    expect(denied.length - deniedBefore).toBe(2);
    expect(denied.slice(deniedBefore).map((row) => row.person_id)).toEqual([MEMBER, STRANGER]);
    // B sin binding (samme domenenavn som A sitt tilbakekalte) overlever alt dette
    expect((await policyRows()).some((row) => row.tenant_id === TENANT_B && row.domain === "pipeline")).toBe(true);
  });

  it("kill switch aktiv: nektes (kill_switch_active) og ingenting slettes; etter oppheving virker tilbakekallet igjen", async () => {
    const before = await policyRows();
    await killSwitch.activateDurable("wph2-e2e", OWNER);
    try {
      const r = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "spend" });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "tool_denied" });
      expect(String(r.body["reason"])).toContain("kill_switch");
      expect(await policyRows()).toEqual(before);
    } finally {
      await killSwitch.deactivateDurable(OWNER);
    }
    const ok = await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "spend" });
    expect(ok.status).toBe(200);
    expect(ok.body["data"]).toMatchObject({ removed: true, domain: "spend" });
    expect((await policyRows()).filter((row) => row.tenant_id === TENANT_A && row.memory_space_id === "personal")).toEqual([]);
  });
});

describe("C: run_golden_suite - deterministisk, lesende, eier-kun", () => {
  let ownerResult: { result_digest: string; suite_digest: string };

  it("eieren: 200 med resultatet - alle oppgaver bestått, ingen hoppet over, null modellkall, begge digester", async () => {
    const before = await counts();
    const r = await mutate(on, grants.owner, "run_golden_suite");
    expect(r.status).toBe(200);
    const data = r.body["data"] as { summary_no: string; result: Record<string, unknown> };
    expect(data.summary_no).toContain("bestått");
    expect(data.summary_no).toContain("Ingen modellkall");
    expect(data.result).toMatchObject({ failed: [], skipped: [], model_calls: 0, hard_stop: false, surface_available: true, suite_id: "jarvis-golden" });
    expect(data.result["passed"]).toBe(data.result["total"]);
    expect(String(data.result["suite_digest"])).toMatch(HEX64);
    expect(String(data.result["result_digest"])).toMatch(HEX64);
    ownerResult = { result_digest: String(data.result["result_digest"]), suite_digest: String(data.result["suite_digest"]) };
    expect(await counts()).toEqual(before); // ingenting skrevet i tasks, owner_control_state, minne eller betalinger
  });

  it("revidert som utført av eieren", async () => {
    const rows = await auditRows("tool.executed", "executive", "run_golden_suite");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => row.person_id === OWNER)).toBe(true);
  });

  it("annen person og annen tenants eier nektes med control_center_owner_only (og revisjonsrad) - kjøringen skjer ikke", async () => {
    const deniedBefore = (await auditRows("tool.denied", "executive", "run_golden_suite")).length;
    for (const grant of [grants.member, grants.stranger]) {
      const r = await mutate(on, grant, "run_golden_suite");
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: "tool_denied", reason: "control_center_owner_only" });
    }
    expect((await auditRows("tool.denied", "executive", "run_golden_suite")).length - deniedBefore).toBe(2);
  });

  it("samme digest ved gjentatt kjøring (deterministisk); kill switch aktiv nekter kjøringen", async () => {
    const again = await mutate(on, grants.owner, "run_golden_suite");
    expect((again.body["data"] as { result: { result_digest: string } }).result.result_digest).toBe(ownerResult.result_digest);
    await killSwitch.activateDurable("wph2-e2e", OWNER);
    try {
      const r = await mutate(on, grants.owner, "run_golden_suite");
      expect(r.status).toBe(403);
      expect(String(r.body["reason"])).toContain("kill_switch");
    } finally {
      await killSwitch.deactivateDurable(OWNER);
    }
  });

  it("Sikkerhet-senteret viser resultatet kjøringen ga (OK, null modellkall, SAMME digester) og knappen er merket med klasse og step-up", async () => {
    const c = await center(on, grants.owner, "security");
    expect(c.status).toBe(200);
    const golden = c.report!.sections.find((s) => s.id === "golden_suite")!;
    expect(golden.measured).toBe(true);
    expect(golden.items.find((i) => i.id === "golden_state")).toMatchObject({ status: "OK", facts: { failed: 0, skipped: 0, model_calls: 0 } });
    expect(golden.items.find((i) => i.id === "golden_digests")?.facts).toMatchObject({ suite_digest: ownerResult.suite_digest, result_digest: ownerResult.result_digest });
    expect(c.report!.actions.find((a) => a.id === "security.golden_suite.run")).toMatchObject({ endpoint: "/executive/mutate", body: { action: "run_golden_suite" }, risk_class: "A", requires_step_up: true });
  });
});

describe("D: Autoritet-senteret tilbyr tilbakekall kun for bindinger i økta sitt eget rom", () => {
  it("med flagget PÅ: en knapp per binding i personal; business-bindingene har en forklaring og ingen knapp; B sine bindinger er aldri med", async () => {
    await bind(TENANT_A, "personal", "pipeline");
    await bind(TENANT_A, "personal", "spend");
    const c = await center(on, grants.owner, "authority");
    expect(c.status).toBe(200);
    const revokes = c.report!.actions.filter((a) => a.id.startsWith("authority.revoke_autonomy:"));
    expect(revokes.map((a) => a.id).sort()).toEqual(["authority.revoke_autonomy:personal:pipeline", "authority.revoke_autonomy:personal:spend"]);
    for (const a of revokes) {
      expect(a).toMatchObject({ endpoint: "/executive/mutate", risk_class: "C", requires_step_up: true, reversible: false, section_id: "autonomy" });
      expect(a.body.action).toBe("revoke_autonomy_binding");
      expect(Object.keys(a.body.parameters ?? {})).toEqual(["domain"]); // kun domenet - aldri tenant, rom eller aktør
    }
    const autonomy = c.report!.sections.find((s) => s.id === "autonomy")!;
    const businessItem = autonomy.items.find((i) => i.id === "business:pipeline");
    expect(businessItem?.detail_no).toContain("tilbakekall krever en økt i rommet «business»");
    expect(JSON.stringify(c.report)).not.toContain(TENANT_B);
    expect(autonomy.summary_no).toContain("«Tilbakekall autonomi» fjerner selve bindingen");
    // health er isolert: kun et antall, aldri en rad eller en knapp
    expect(autonomy.summary_no).toContain("1 i health-rommet (isolert, ikke listet)");
    expect(autonomy.items.some((i) => i.id.startsWith("health:"))).toBe(false);
    expect(JSON.stringify(c.report)).not.toContain("wellbeing");
  });

  it("etter et tilbakekall er knappen borte - og bindingen står ikke lenger i senteret", async () => {
    expect((await mutate(on, grants.owner, "revoke_autonomy_binding", { domain: "spend" })).body["data"]).toMatchObject({ removed: true });
    const c = await center(on, grants.owner, "authority");
    expect(c.report!.actions.some((a) => a.id === "authority.revoke_autonomy:personal:spend")).toBe(false);
    expect(c.report!.actions.some((a) => a.id === "authority.revoke_autonomy:personal:pipeline")).toBe(true);
    expect(c.report!.sections.find((s) => s.id === "autonomy")!.items.some((i) => i.id === "personal:spend")).toBe(false);
  });

  it("annen person i samme tenant ser ikke senteret (eier-kun) - ingen knapp kan leses av andre", async () => {
    const r = await post(on, "/control/center", { grant_token: grants.member, center: "authority" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "tool_denied", reason: "control_center_owner_only" });
    expect(JSON.stringify(r.body)).not.toContain("revoke_autonomy");
  });
});

describe("E: de tre nye sentrene over HTTP - eier-kun, kildeforankret, og Verdi er ærlig «ikke koblet inn» uten sin avhengighet", () => {
  it("oversikten lister Drift, Personvern og Sikkerhet som koblet inn; Verdi og de øvrige står under «ikke koblet inn» (aldri «i orden»)", async () => {
    const r = await post(on, "/control/centers", { grant_token: grants.owner });
    expect(r.status).toBe(200);
    const data = r.body["data"] as { centers: Array<{ center: string; status: string }>; unregistered: string[] };
    const ids = data.centers.map((c) => c.center);
    for (const id of ["operations", "privacy", "security", "authority"]) expect(ids, id).toContain(id);
    expect(ids).not.toContain("value");
    expect(data.unregistered).toContain("value");
    for (const id of ["operations", "privacy", "security"]) expect(data.unregistered).not.toContain(id);
  });

  it("hvert nytt senter: owner får en rapport med kilde på hver seksjon, ukjent der noe ikke måles; Verdi uten avhengighet gir 404 center_not_registered", async () => {
    for (const id of ["operations", "privacy", "security"]) {
      const c = await center(on, grants.owner, id);
      expect(c.status, id).toBe(200);
      expect(c.report!.center).toBe(id);
      expect(c.report!.sections.length, id).toBeGreaterThanOrEqual(5);
      expect(c.report!.status, id).not.toBe("");
    }
    const value = await center(on, grants.owner, "value");
    expect(value.status).toBe(404);
    expect(value.raw.body["error"]).toBe("center_not_registered");
  });

  it("annen person og annen tenants eier får ingen av dem (control_center_owner_only)", async () => {
    for (const id of ["operations", "privacy", "security"]) {
      for (const grant of [grants.member, grants.stranger]) {
        const r = await post(on, "/control/center", { grant_token: grant, center: id });
        expect(r.status, id).toBe(403);
        expect(r.body, id).toMatchObject({ error: "tool_denied", reason: "control_center_owner_only" });
      }
    }
  });

  it("Personvern leser dokumentet i repoet (målt) og tenant-isolert: rapporten inneholder aldri B sin tenant-id", async () => {
    const c = await center(on, grants.owner, "privacy");
    expect(c.report!.sections.every((s) => s.measured)).toBe(true);
    expect(JSON.stringify(c.report)).not.toContain(TENANT_B);
  });
});

describe("F: FLAGGENE AV - verktøyene og knappene finnes ikke, og H0-oppførselen er uendret", () => {
  it("revoke_autonomy_binding og run_golden_suite er ukjente verktøy (unknown_tool) - og ingenting slettes", async () => {
    const before = await policyRows();
    for (const [action, parameters] of [["revoke_autonomy_binding", { domain: "pipeline" }], ["run_golden_suite", {}]] as const) {
      const r = await mutate(off, grants.owner, action, parameters);
      expect(r.status, action).toBe(403);
      expect(r.body, action).toMatchObject({ error: "tool_denied", reason: "unknown_tool" });
    }
    expect(await policyRows()).toEqual(before);
  });

  it("de fire H2-sentrene er ikke koblet inn (404 center_not_registered) og står under unregistered i oversikten", async () => {
    for (const id of ["operations", "value", "privacy", "security"]) {
      const c = await center(off, grants.owner, id);
      expect(c.status, id).toBe(404);
      expect(c.raw.body["error"], id).toBe("center_not_registered");
    }
    const overview = (await post(off, "/control/centers", { grant_token: grants.owner })).body["data"] as { centers: Array<{ center: string }>; unregistered: string[] };
    for (const id of ["operations", "value", "privacy", "security"]) expect(overview.unregistered).toContain(id);
    expect(overview.centers.map((c) => c.center)).not.toEqual(expect.arrayContaining(["operations"]));
  });

  it("Autoritet-senteret er uendret fra H0: ingen tilbakekall-knapper, og teksten sier at tilbakekall av bindingen er DEFERRED", async () => {
    const c = await center(off, grants.owner, "authority");
    expect(c.status).toBe(200);
    expect(c.report!.actions.filter((a) => a.id.includes("revoke_autonomy"))).toEqual([]);
    const autonomy = c.report!.sections.find((s) => s.id === "autonomy")!;
    expect(autonomy.summary_no).toContain("tilbakekall av selve bindingen er DEFERRED (ingen rute)");
    expect(autonomy.items.every((i) => !(i.detail_no ?? "").includes("tilbakekall krever en økt"))).toBe(true);
  });
});
