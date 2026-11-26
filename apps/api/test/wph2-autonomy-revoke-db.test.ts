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
 * WP-H2 gjennomgang L1 mot EKTE Postgres/RLS (app-rolle), EKTE `ToolGateway` + `PolicyGateway` + `SituationEngine` og den EKTE revisjonsskriveren (`createAutonomyAudit`):
 *  - rekkefølgen i den append-only `audit_events`: før-bilde-raden (`autonomy_binding.revoke_requested`) står FØR det nøstede `situations.clear_autonomy_policy` som sletter - og slettingen skjer faktisk;
 *  - gatewayens EGEN step-up (`step_up_required`): en aktiv/passiv økt og en tale-kanal får ingen sletting og ingen revisjonsrad; en annen person i tenanten nektes av eier-porten;
 *  - rom- og tenantisolasjon: kun kallerens eget rom i kallerens egen tenant røres;
 *  - fail-closed: en revisjonsskriver som kaster gir ingen sletting; hemmeligheter i parametrene lagres aldri i raden.
 */
let db: H0Db;
const TENANT_A = "tenant-rv-a";
const TENANT_B = "tenant-rv-b";
const OWNER = "person-rv-owner";
const OWNER_B = "person-rv-b";
const MEMBER = "person-rv-member";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed", ...extra
});
const owner = idFor(OWNER, TENANT_A);
const FAKE = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;

// WP-G4b K1: bind-tid-oppslaget mot de EKTE produksjonsdefinisjonene (`business.create_followup` erklærer seg bindbar).
const PRODUCTION_DEFS = new Map(firstWaveTools({}).map((d) => [`${d.tool_id}:${d.action}`, d] as const));
const productionLookup = (t: string, a: string) => PRODUCTION_DEFS.get(`${t}:${a}`);

let engine: SituationEngine;
let gateway: ToolGateway;

function wire(autonomyAudit?: ExecutiveServiceOptions["autonomyAudit"]): ToolGateway {
  const killSwitch = new KillSwitch();
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch, authority });
  const g = new ToolGateway(db.appPool, policy, secrets);
  const pauses = new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER });
  for (const tool of situationsToolDefinitions(new SituationsTransport(engine, pauses))) g.register(tool);
  const registry = createControlCenterRegistry({ authority });
  const service = new ExecutiveService(g, { controlCenters: registry, ...(autonomyAudit ? { autonomyAudit } : {}) });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { autonomyRevoke: true })) g.register(tool);
  return g;
}
const revoke = (g: ToolGateway, identity: IdentityContext, domain = "sales") => g.execute({ identity, tool_id: "executive", action: "revoke_autonomy_binding", parameters: { domain } });
const policyRows = async (): Promise<Array<{ tenant_id: string; memory_space_id: string; domain: string }>> =>
  (await db.adminPool.query("SELECT tenant_id, memory_space_id, domain FROM situation_autonomy_policies ORDER BY tenant_id, memory_space_id, domain")).rows as never;
const auditRows = async (tenant: string): Promise<Array<{ audit_id: string; type: string; tool_id: string | null; action: string | null; payload: Record<string, unknown> }>> =>
  (await db.adminPool.query("SELECT audit_id, type, tool_id, action, payload FROM audit_events WHERE tenant_id = $1 ORDER BY audit_id", [tenant])).rows as never;

async function bind(tenant: string, space: "personal" | "business", domain: string, over: { parameters?: Record<string, unknown>; enabled?: boolean } = {}): Promise<void> {
  const actor = tenant === TENANT_B ? OWNER_B : OWNER;
  const eng = tenant === TENANT_B ? new SituationEngine(db.appPool, new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER_B }), { owner_person_id: OWNER_B }, { definitionLookup: productionLookup }) : engine;
  await eng.setAutonomyPolicy(tenant, space, { domain, tool_id: "business", action: "create_followup", parameters: (over.parameters ?? { kanal: "web" }) as never, enabled: over.enabled ?? true }, actor);
}

beforeAll(async () => {
  db = await startH0Db("rv");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  await db.adminPool.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await db.adminPool.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  engine = new SituationEngine(db.appPool, new DomainPauseRegistry(db.appPool, { owner_person_id: OWNER }), { owner_person_id: OWNER }, { definitionLookup: productionLookup });
  gateway = wire(createAutonomyAudit(db.appPool));
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("før-bildet står i revisjonssporet FØR slettingen - og slettingen skjer", () => {
  it("eieren (signert enhetsøkt) tilbakekaller `sales`: raden `autonomy_binding.revoke_requested` med før-bildet kommer FØR det nøstede `clear_autonomy_policy`, som kommer FØR den ytre `tool.executed`; bindingen er borte", async () => {
    await bind(TENANT_A, "personal", "sales", { parameters: { kanal: "web", antall: 3 }, enabled: true });
    await bind(TENANT_A, "personal", "support");
    const before = (await auditRows(TENANT_A)).length;
    const r = await revoke(gateway, owner);
    expect(r).toMatchObject({ ok: true, data: { removed: true, domain: "sales", memory_space: "personal" } });
    expect((await policyRows()).filter((p) => p.tenant_id === TENANT_A && p.memory_space_id === "personal").map((p) => p.domain)).toEqual(["support"]);

    const rows = (await auditRows(TENANT_A)).slice(before);
    const requested = rows.find((x) => x.type === "autonomy_binding.revoke_requested");
    const nested = rows.find((x) => x.type === "tool.executed" && x.tool_id === "situations" && x.action === "clear_autonomy_policy");
    const outer = rows.find((x) => x.type === "tool.executed" && x.tool_id === "executive" && x.action === "revoke_autonomy_binding");
    expect(requested).toBeDefined();
    expect(nested).toBeDefined();
    expect(outer).toBeDefined();
    expect(Number(requested!.audit_id)).toBeLessThan(Number(nested!.audit_id));
    expect(Number(nested!.audit_id)).toBeLessThan(Number(outer!.audit_id));
    expect(requested).toMatchObject({ tool_id: "executive", action: "revoke_autonomy_binding" });
    expect(requested!.payload).toMatchObject({
      domain: "sales", memory_space: "personal", existed: true,
      before: { domain: "sales", tool_id: "business", action: "create_followup", enabled: true, parameters: { kanal: "web", antall: 3 }, actor_person_id: OWNER }
    });
    // «support» (annen binding i samme rom) er ikke med i før-bildet
    expect(JSON.stringify(requested!.payload)).not.toContain("support");
  });

  it("idempotent: tilbakekall av en binding som ikke finnes gir `removed: false`, og revisjonsraden sier `existed: false` med `before: null`", async () => {
    const before = (await auditRows(TENANT_A)).length;
    const r = await revoke(gateway, owner, "finnes-ikke");
    expect(r).toMatchObject({ ok: true, data: { removed: false } });
    const requested = (await auditRows(TENANT_A)).slice(before).find((x) => x.type === "autonomy_binding.revoke_requested");
    expect(requested?.payload).toMatchObject({ domain: "finnes-ikke", existed: false, before: null });
  });

  it("hemmeligheter i bindingens parametre lagres aldri i revisjonsraden (hemmelighetsskanneren), men resten av før-bildet er der", async () => {
    await bind(TENANT_A, "personal", "secrets", { parameters: { notat: `bruk ${FAKE} i meldingen`, kanal: "web" } });
    const before = (await auditRows(TENANT_A)).length;
    expect((await revoke(gateway, owner, "secrets")).ok).toBe(true);
    const requested = (await auditRows(TENANT_A)).slice(before).find((x) => x.type === "autonomy_binding.revoke_requested")!;
    expect(JSON.stringify(requested.payload)).not.toContain("FALSKNOKKELFORTEST");
    expect(JSON.stringify(requested.payload)).toContain("REDACTED");
    expect(requested.payload).toMatchObject({ existed: true, before: { domain: "secrets", tool_id: "business", action: "create_followup" } });
  });
});

describe("gatewayens EGEN step-up: ingen sletting og ingen revisjonsrad uten en enhetssignert eier-kanal-økt", () => {
  const CASES: ReadonlyArray<readonly [string, Partial<IdentityContext>, RegExp]> = [
    ["eieren, aktiv økt uten enhetssignatur", { auth_strength: "active" }, /^step_up_required:signed_device_session$/],
    ["eieren, passiv økt", { auth_strength: "passive" }, /^step_up_required:signed_device_session$/],
    ["eieren, signert økt på tale", { channel: "voice" }, /^step_up_required:channel_voice_not_allowed$/],
    ["eieren, signert økt på Telegram", { channel: "telegram" }, /^step_up_required:channel_telegram_not_allowed$/]
  ];
  for (const [label, extra, reason] of CASES) {
    it(`${label}: nektet med step_up_required, bindingen står, ingen før-bilde-rad`, async () => {
      await bind(TENANT_A, "personal", "keep");
      const before = (await auditRows(TENANT_A)).length;
      const r = await revoke(gateway, idFor(OWNER, TENANT_A, extra), "keep");
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toMatch(reason);
      expect((await policyRows()).some((p) => p.tenant_id === TENANT_A && p.memory_space_id === "personal" && p.domain === "keep")).toBe(true);
      expect((await auditRows(TENANT_A)).slice(before).some((x) => x.type === "autonomy_binding.revoke_requested")).toBe(false);
    });
  }

  it("en annen person i eierens tenant (signert økt) nektes FØR noe leses eller slettes (klasse C uten mandat - policyen avviser før verktøyets egen eier-port)", async () => {
    const before = (await auditRows(TENANT_A)).length;
    const r = await revoke(gateway, idFor(MEMBER, TENANT_A), "keep");
    expect(r).toEqual({ ok: false, reason: "class_c_no_mandate" });
    expect((await auditRows(TENANT_A)).slice(before).some((x) => x.type === "autonomy_binding.revoke_requested")).toBe(false);
    expect((await policyRows()).some((p) => p.tenant_id === TENANT_A && p.domain === "keep")).toBe(true);
  });
});

describe("rom- og tenantisolasjon", () => {
  it("tilbakekall i `personal` rører verken `business`-rommet eller en annen tenants binding med samme domenenavn", async () => {
    await bind(TENANT_A, "personal", "iso");
    await bind(TENANT_A, "business", "iso");
    await bind(TENANT_B, "personal", "iso");
    expect((await revoke(gateway, owner, "iso")).ok).toBe(true);
    const iso = (await policyRows()).filter((p) => p.domain === "iso").map((p) => `${p.tenant_id}/${p.memory_space_id}`);
    expect(iso).toEqual([`${TENANT_A}/business`, `${TENANT_B}/personal`]);
    // før-bildet kom fra kallerens eget rom: ingen annen tenants rad i revisjonen
    expect(JSON.stringify(await auditRows(TENANT_B))).not.toContain("autonomy_binding.revoke_requested");
  });
});

describe("fail-closed", () => {
  it("en revisjonsskriver som kaster: INGEN sletting (bindingen står), avvist med `autonomy_audit_write_failed`", async () => {
    await bind(TENANT_A, "personal", "failclosed");
    const broken = wire(async () => { throw new Error("audit_db_down"); });
    const r = await revoke(broken, owner, "failclosed");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("autonomy_audit_write_failed");
    expect((await policyRows()).some((p) => p.tenant_id === TENANT_A && p.memory_space_id === "personal" && p.domain === "failclosed")).toBe(true);
  });

  it("uten revisjonsskriver koblet inn: INGEN sletting, avvist med `autonomy_audit_not_configured`", async () => {
    const bare = wire();
    const r = await revoke(bare, owner, "failclosed");
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("autonomy_audit_not_configured");
    expect((await policyRows()).some((p) => p.domain === "failclosed")).toBe(true);
  });
});
