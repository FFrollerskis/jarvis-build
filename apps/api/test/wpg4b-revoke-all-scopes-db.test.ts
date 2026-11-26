import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ExecutiveServiceOptions } from "@jarvis/executive";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { DomainPauseRegistry, SituationEngine, SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { createAutonomyAudit } from "../src/autonomy-audit.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-G4b fiks-runde 1 (FIX-2/2b, Q-G4-15) mot EKTE Postgres/RLS, EKTE `ToolGateway` + `PolicyGateway` + `SituationEngine` og den EKTE revisjonsskriveren: «Tilbakekall autonomi»
 * (`executive.revoke_autonomy_binding` -> `situations.clear_autonomy_policy` uten skop) fjerner ALLE bindingsrader i (tenant, rom, domene), og revisjonsraden bærer før-bildet av ALLE radene (domenebred som `before`,
 * regel-/kategoribindinger som `before_scoped`) - men aldri innhold fra situasjoner. Kun kallerens eget rom i kallerens egen tenant røres.
 */
let db: H0Db;
const TENANT_A = "tenant-rvs-a";
const TENANT_B = "tenant-rvs-b";
const OWNER = "person-rvs-owner";
const OWNER_B = "person-rvs-b";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s-rvs", device_id: "dev", channel: "web", auth_strength: "signed" };
const DOOR = "home_assistant:door_open_too_long";
const CANARY = "KANARI-SITUASJONSINNHOLD-4711";

const PRODUCTION_DEFS = new Map(firstWaveTools({}).map((d) => [`${d.tool_id}:${d.action}`, d] as const));
const productionLookup = (t: string, a: string) => PRODUCTION_DEFS.get(`${t}:${a}`);

let engine: SituationEngine;
let gateway: ToolGateway;

function wire(autonomyAudit?: ExecutiveServiceOptions["autonomyAudit"]): ToolGateway {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch: new KillSwitch(), authority });
  const g = new ToolGateway(db.appPool, policy, secrets);
  const pauses = new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER });
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, pauses), { autonomyScope: true })) g.register(tool);
  const service = new ExecutiveService(g, { controlCenters: createControlCenterRegistry({ authority }), ...(autonomyAudit ? { autonomyAudit } : {}) });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { autonomyRevoke: true })) g.register(tool);
  return g;
}
const revoke = (g: ToolGateway, identity: IdentityContext, domain: string) => g.execute({ identity, tool_id: "executive", action: "revoke_autonomy_binding", parameters: { domain } });
const rows = async (tenant: string, space: string, domain: string): Promise<string[]> =>
  (await db.adminPool.query("SELECT scope_key FROM situation_autonomy_policies WHERE tenant_id = $1 AND memory_space_id = $2 AND domain = $3 ORDER BY scope_key", [tenant, space, domain])).rows.map((r: { scope_key: string }) => r.scope_key);
const auditRows = async (tenant: string): Promise<Array<{ audit_id: string; type: string; tool_id: string | null; action: string | null; payload: Record<string, unknown> }>> =>
  (await db.adminPool.query("SELECT audit_id, type, tool_id, action, payload FROM audit_events WHERE tenant_id = $1 ORDER BY audit_id", [tenant])).rows as never;
const bind = (tenant: string, space: "personal" | "business", over: Record<string, unknown> = {}) => {
  const actor = tenant === TENANT_B ? OWNER_B : OWNER;
  const eng = tenant === TENANT_B ? new SituationEngine(db.appPool, new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER_B }), { owner_person_id: OWNER_B }, { definitionLookup: productionLookup }) : engine;
  return eng.setAutonomyPolicy(tenant, space, { domain: "home", tool_id: "business", action: "create_followup", parameters: { kanal: "web" }, ...over } as never, actor);
};

beforeAll(async () => {
  db = await startH0Db("rvs");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  engine = new SituationEngine(db.appPool, new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER }), { owner_person_id: OWNER }, { definitionLookup: productionLookup });
  gateway = wire(createAutonomyAudit(db.appPool));
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("domenebredt tilbakekall fjerner ALLE bindinger i domenet - og før-bildet av alle radene står i revisjonen", () => {
  it("bred + regel + kategori: alt er borte, svaret oppgir skopene, og revisjonsraden (FØR slettingen) har `before` og `before_scoped` med parametre, men ingen situasjonsinnhold", async () => {
    await bind(TENANT_A, "personal", { parameters: { kanal: "web", antall: 3 } });
    await bind(TENANT_A, "personal", { rule: DOOR, parameters: { kanal: "regel" } });
    await bind(TENANT_A, "personal", { category: "leak", parameters: { kanal: "kategori" }, enabled: false });
    await engine.evaluateCandidate(TENANT_A, "personal", { domain: "home", detection_key: "home:rvs:1", priority: "high", confidence: 0.9, reason: `dørsensor: ${CANARY}`, rule_key: DOOR }, Date.now());
    expect(await rows(TENANT_A, "personal", "home")).toEqual(["*", "category:leak", `rule:${DOOR}`]);
    const before = (await auditRows(TENANT_A)).length;

    const r = await revoke(gateway, owner, "home");
    expect(r).toMatchObject({ ok: true, data: { removed: true, domain: "home", memory_space: "personal", removed_scopes: ["*", "category:leak", `rule:${DOOR}`] } });
    expect(await rows(TENANT_A, "personal", "home")).toEqual([]);

    const written = (await auditRows(TENANT_A)).slice(before);
    const requested = written.find((x) => x.type === "autonomy_binding.revoke_requested");
    const cleared = written.find((x) => x.type === "tool.executed" && x.tool_id === "situations" && x.action === "clear_autonomy_policy");
    expect(requested).toBeDefined();
    expect(cleared).toBeDefined();
    expect(Number(requested!.audit_id)).toBeLessThan(Number(cleared!.audit_id)); // før-bildet står (committet) FØR slettingen
    expect(requested!.payload).toMatchObject({
      domain: "home", memory_space: "personal", existed: true,
      before: { domain: "home", tool_id: "business", action: "create_followup", enabled: true, parameters: { kanal: "web", antall: 3 }, actor_person_id: OWNER },
      before_scoped: [
        { scope_key: "category:leak", tool_id: "business", action: "create_followup", enabled: false, parameters: { kanal: "kategori" }, actor_person_id: OWNER },
        { scope_key: `rule:${DOOR}`, tool_id: "business", action: "create_followup", enabled: true, parameters: { kanal: "regel" }, actor_person_id: OWNER }
      ]
    });
    expect((requested!.payload["before_scoped"] as unknown[]).length).toBe(2);
    // ingen situasjonsinnhold i revisjonen (kun bindingens egne verdier og skopnøkler)
    expect(JSON.stringify(written)).not.toContain(CANARY);
  });

  it("kun smale rader (ingen bred): før-bildet har `before: null`, `existed: true` og begge smale radene; alt fjernes", async () => {
    await bind(TENANT_A, "personal", { domain: "infra", rule: "incident:incident_active", parameters: { kanal: "r" } });
    await bind(TENANT_A, "personal", { domain: "infra", category: "incident", parameters: { kanal: "k" } });
    expect(await rows(TENANT_A, "personal", "infra")).toEqual(["category:incident", "rule:incident:incident_active"]);
    const before = (await auditRows(TENANT_A)).length;
    const r = await revoke(gateway, owner, "infra");
    expect(r).toMatchObject({ ok: true, data: { removed: true, removed_scopes: ["category:incident", "rule:incident:incident_active"] } });
    expect(await rows(TENANT_A, "personal", "infra")).toEqual([]);
    const requested = (await auditRows(TENANT_A)).slice(before).find((x) => x.type === "autonomy_binding.revoke_requested")!;
    expect(requested.payload).toMatchObject({ domain: "infra", existed: true, before: null });
    expect((requested.payload["before_scoped"] as Array<{ scope_key: string; parameters: unknown }>).map((b) => [b.scope_key, b.parameters])).toEqual([["category:incident", { kanal: "k" }], ["rule:incident:incident_active", { kanal: "r" }]]);
  });

  it("isolasjon: bindinger i et annet rom, i et annet domene og i en annen tenant (også smale) står urørt, og deres parametre er ikke i revisjonsraden", async () => {
    await bind(TENANT_A, "personal", { parameters: { kanal: "hjem-personal" } });
    await bind(TENANT_A, "personal", { rule: DOOR, parameters: { kanal: "hjem-regel" } });
    await bind(TENANT_A, "business", { parameters: { kanal: "HEMMELIG-ANNET-ROM" } });
    await bind(TENANT_A, "business", { rule: DOOR, parameters: { kanal: "HEMMELIG-ANNET-ROM-REGEL" } });
    await bind(TENANT_B, "personal", { parameters: { kanal: "HEMMELIG-ANNEN-TENANT" } });
    await bind(TENANT_B, "personal", { rule: DOOR, parameters: { kanal: "HEMMELIG-ANNEN-TENANT-REGEL" } });
    await bind(TENANT_A, "personal", { domain: "infra", rule: "incident:incident_active", parameters: { kanal: "HEMMELIG-ANNET-DOMENE" } });
    const before = (await auditRows(TENANT_A)).length;
    expect((await revoke(gateway, owner, "home")).ok).toBe(true);
    expect(await rows(TENANT_A, "personal", "home")).toEqual([]);
    expect(await rows(TENANT_A, "business", "home")).toEqual(["*", `rule:${DOOR}`]);
    expect(await rows(TENANT_B, "personal", "home")).toEqual(["*", `rule:${DOOR}`]);
    expect(await rows(TENANT_A, "personal", "infra")).toEqual(["rule:incident:incident_active"]);
    const written = JSON.stringify((await auditRows(TENANT_A)).slice(before));
    expect(written).toContain("hjem-regel");
    for (const secret of ["HEMMELIG-ANNET-ROM", "HEMMELIG-ANNEN-TENANT", "HEMMELIG-ANNET-DOMENE"]) expect(written, secret).not.toContain(secret);
    expect(JSON.stringify(await auditRows(TENANT_B))).not.toContain("autonomy_binding.revoke_requested");
  });

  it("fail-closed: skriveren kaster -> INGEN rad fjernes (heller ikke de smale); uten skriver -> ingen sletting", async () => {
    await bind(TENANT_A, "personal", { parameters: { kanal: "fc" } });
    await bind(TENANT_A, "personal", { category: "leak", parameters: { kanal: "fc-k" } });
    const present = await rows(TENANT_A, "personal", "home");
    expect(present).toEqual(["*", "category:leak"]);
    const broken = wire(async () => { throw new Error("audit_db_down"); });
    const r = await revoke(broken, owner, "home");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("autonomy_audit_write_failed");
    expect(await rows(TENANT_A, "personal", "home")).toEqual(present);
    expect((await revoke(wire(), owner, "home")).ok).toBe(false);
    expect(await rows(TENANT_A, "personal", "home")).toEqual(present);
  });
});
