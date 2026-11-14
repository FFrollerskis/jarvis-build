import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import {
  CONTROL_CENTER_READ_TOOLS, ExecutiveService, ExecutiveTransport, VALUE_METRIC_CATALOG, composeInfraStatus, executiveToolDefinitions,
  type ControlCenterId, type ControlCenterReport, type InfraStatusReport, type ValueMeasurement, type ValueRuntimeFacts
} from "@jarvis/executive";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { createGoldenSuiteRunner } from "../src/golden-suite-runner.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H2 - EKTE ToolGateway + PolicyGateway + Postgres (app-rolle, RLS) + produksjonsfabrikken for registeret + `registerControlCenters` med ALLE flagg og avhengigheter (Drift, Verdi, Personvern, Sikkerhet):
 *  - eieren (suveren, signert enhetsøkt) får rapporten via `executive.get_<senter>_center` OG via `get_control_center {center}` - samme innhold; Verdi leser den ene ExecutiveService-instansen via holderen;
 *  - alle andre nektes av verktøyets port FØR noe bygges, med `tool.denied` i revisjonssporet;
 *  - tenant-isolasjon i sluttrapportene måles mot databasens egne tall (A sine avslag, ikke B sine);
 *  - hvert flagg slår på kun sitt senter, og et senter uten sine avhengigheter er ærlig «ikke koblet inn»; flaggene AV: alt som i H0;
 *  - en modell i løkka (servingModel) får de samme rapportene (ingen penger her å fjerne - Verdi bruker de samme tallene som get_value_report), og ingenting skrives.
 */
let db: H0Db;
const TENANT_A = "tenant-g2-a";
const TENANT_B = "tenant-g2-b";
const OWNER = "person-g2-owner";
const OTHER_TENANT_OWNER = "person-g2-b";
const MEMBER = "person-g2-member";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed", ...extra
});
const owner = idFor(OWNER, TENANT_A);
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
const H2_TOOLS = CONTROL_CENTER_READ_TOOLS.filter((t) => (["operations", "value", "privacy", "security"] as ControlCenterId[]).includes(t.center));
const H = 3_600_000;

let killSwitch: KillSwitch;
let policy: PolicyGateway;
let ownerControls: OwnerControls;
let gateway: ToolGateway;
let gatewayFlagsOff: ToolGateway;

const WINDOWS = { d7: { from: "2026-11-07T23:00:00.000Z", to: new Date().toISOString() }, d30: { from: "2026-10-15T23:00:00.000Z", to: new Date().toISOString() } };
const VALUE_FACTS: ValueRuntimeFacts = {
  v1_delivery_configured: true, v2_push: { enabled: false, channel_configured: true, max_per_day: 3, quiet_hours: "22-07" }, v5_proposals_enabled: false,
  ev0: { constitution_verified: true, ledger_ok: true }, kill_switch_active: false, declared_gates: []
};
const MEASURED: ValueMeasurement[] = VALUE_METRIC_CATALOG
  .filter((m) => m.never_measurable_reason_no === undefined && m.derive === undefined)
  .map((m) => (m.shape === "snapshot" ? ({ id: m.id, state: "measured", now: 2 } as ValueMeasurement) : ({ id: m.id, state: "measured", last_7d: 5, last_30d: 20 } as ValueMeasurement)));

function infra(): InfraStatusReport {
  return composeInfraStatus({
    as_of: new Date(),
    measurements: { incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 }, last_changes: {}, producer_runs: [], errors: [] },
    producers_enabled: true, producers_interval_ms: 300_000, producer_names: ["scheduler"], infra_mode: "NORMAL", targets: []
  });
}

interface WireOptions { valueSource?: boolean; withControls?: boolean; withRegistry?: boolean }
function wire(env: Record<string, string | undefined>, options: WireOptions = {}): ToolGateway {
  const { valueSource = true, withControls = true, withRegistry = true } = options;
  const g = new ToolGateway(db.appPool, policy, secrets);
  if (!withRegistry) {
    for (const tool of executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(g)))) g.register(tool);
    return g;
  }
  const holder: { service?: ExecutiveService } = {};
  const late = (): ExecutiveService => { if (holder.service === undefined) throw new Error("executive_service_not_ready"); return holder.service; };
  const registry = createControlCenterRegistry({ authority });
  const runner = createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE });
  registerControlCenters(registry, {
    pool: db.appPool, env, toolGateway: g,
    ...(withControls ? { ownerControls, killSwitch, authority } : {}),
    infraStatus: async () => infra(), backupStatus: async () => ({ kind: "missing" }), processStartedAt: () => new Date(Date.now() - 2 * H),
    valueReport: (tenantId) => late().getValueReport(tenantId), goldenSuite: runner
  });
  const service = new ExecutiveService(g, {
    controlCenters: registry, holder,
    ...(valueSource ? { value: { source: { measure: async () => ({ windows: WINDOWS, measurements: MEASURED }) }, facts: () => VALUE_FACTS } } : {})
  });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service))) g.register(tool);
  return g;
}
const ALL_ON: Record<string, string> = {
  ...Object.fromEntries(Object.values(CONTROL_CENTER_FLAGS).map((f) => [f, "on"])),
  [CONTROL_FEATURE_FLAGS.goldenSuite]: "on", [CONTROL_FEATURE_FLAGS.autonomyRevoke]: "on"
};

const get = (g: ToolGateway, identity: IdentityContext, action: string, parameters: Record<string, string> = {}, servingModel?: { provider: string; model: string }) =>
  g.execute({ identity, tool_id: "executive", action, parameters, ...(servingModel ? { servingModel } : {}) });
type CenterData = { found: boolean; center?: string; summary_no: string; explanation_no?: string; report?: ControlCenterReport };
const data = (r: Awaited<ReturnType<typeof get>>): CenterData => (r as unknown as { data: CenterData }).data;
const item = (r: ControlCenterReport | undefined, s: string, i: string) => r?.sections.find((x) => x.id === s)?.items.find((x) => x.id === i);
const deniedRows = async (action: string): Promise<Array<{ reason: string; person_id: string }>> =>
  (await db.adminPool.query("SELECT reason, person_id FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = $1 ORDER BY audit_id", [action])).rows as Array<{ reason: string; person_id: string }>;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tasks", "payment_intents", "memory_items", "owner_control_state", "situation_autonomy_policies"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

beforeAll(async () => {
  db = await startH0Db("g2");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: OTHER_TENANT_OWNER }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  // B har MANGE avslag og A har få: A sin sluttrapport må telle kun A sine (målt mot databasens egne tall under)
  const audit = (tenant: string, person: string, n: number): Promise<unknown> =>
    admin.query("INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, tool_id, action, at) SELECT $1, $2, 'tool.denied', 'DENY', 'control_center_owner_only', 'executive', 'get_control_center', now() - interval '1 hour' FROM generate_series(1, $3)", [tenant, person, n]);
  await audit(TENANT_A, MEMBER, 2);
  await audit(TENANT_B, OTHER_TENANT_OWNER, 9);
  killSwitch = new KillSwitch(db.appPool, { owner_person_id: OWNER });
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, { owner_person_id: OWNER });
  await ownerControls.restore();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch, authority });
  gateway = wire(ALL_ON);
  gatewayFlagsOff = wire({});
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("eieren får rapportene (alle flagg PÅ, alle avhengigheter koblet)", () => {
  for (const tool of H2_TOOLS) {
    it(`${tool.action}: ok, funnet, alle seksjoner målt der kilden finnes - og identisk innhold som get_control_center {center: "${tool.center}"}`, async () => {
      const viaTool = await get(gateway, owner, tool.action);
      expect(viaTool.ok).toBe(true);
      const t = data(viaTool);
      expect(t.found).toBe(true);
      expect(t.report?.center).toBe(tool.center);
      expect(t.report?.sections.length).toBeGreaterThanOrEqual(5);
      expect(t.report?.sections.every((s) => s.source.length > 5)).toBe(true); // hver seksjon er kildeforankret
      expect(t.summary_no.length).toBeGreaterThan(10);
      const viaCenter = data(await get(gateway, owner, "get_control_center", { center: tool.center }));
      expect(viaCenter.report?.sections.map((s) => s.id)).toEqual(t.report?.sections.map((s) => s.id));
      expect(viaCenter.report?.status).toBe(t.report?.status);
    });
  }

  it("Verdi leser den ene ExecutiveService-instansen via holderen: alle seksjoner er målt med en kilde, og kilden mangler = ærlig UKJENT (aldri OK)", async () => {
    const withSource = data(await get(gateway, owner, "get_value_center")).report;
    expect(withSource?.sections.every((s) => s.measured)).toBe(true);
    const noSource = data(await get(wire(ALL_ON, { valueSource: false }), owner, "get_value_center")).report;
    expect(noSource?.status).toBe("UNKNOWN");
    // tilstandsordene (sovende/ikke bygget) er kjente fakta, men INGEN måling er påstått uten kilde: hver metrikk er UKJENT og «ikke målt» - aldri 0 og aldri OK
    const metrics = (noSource?.sections ?? []).flatMap((s) => s.items).filter((i) => i.id.startsWith("metric:"));
    expect(metrics.length).toBeGreaterThan(10);
    expect(metrics.every((i) => i.status === "UNKNOWN" && (i.facts as { measured?: boolean } | undefined)?.measured === false)).toBe(true);
    expect(JSON.stringify(noSource)).toContain("ingen kilde koblet inn");
  });

  it("Personvern leser behandlingsoversikten mot de LEVENDE tabellene (dekning målt, ingen udokumentert tabell) og Drift leser databasekapasiteten som app-rolle", async () => {
    const privacy = data(await get(gateway, owner, "get_privacy_center")).report;
    expect(item(privacy, "inventory", "coverage")).toMatchObject({ status: "OK", facts: { undocumented: 0 } });
    const operations = data(await get(gateway, owner, "get_operations_center")).report;
    expect(item(operations, "capacity", "database_size")?.status).toBe("OK");
    expect(item(operations, "uptime", "database")?.status).toBe("OK");
  });

  it("tenant-isolasjon i sluttrapporten: Sikkerhet teller A sine avslag (databasens egne tall for A), aldri B sine ni", async () => {
    const truth = Number((await db.adminPool.query("SELECT count(*) AS n FROM audit_events WHERE tenant_id = $1 AND type = 'tool.denied' AND at > now() - interval '7 days'", [TENANT_A])).rows[0].n);
    const security = data(await get(gateway, owner, "get_security_center")).report;
    const denied = item(security, "audit", "denied")?.facts as { denied_7d?: number } | undefined;
    expect(denied?.denied_7d).toBe(truth);
    expect(truth).toBeGreaterThanOrEqual(2);
    expect(truth).toBeLessThan(2 + 9); // B sine ni er aldri med
    expect(JSON.stringify(security)).not.toContain(TENANT_B);
  });
});

describe("modell i løkka: samme rapporter (ingen penger å fjerne her), og aldri skriving", () => {
  it("get_<senter>_center med servingModel gir identiske seksjoner som uten - og radtall er uendret", async () => {
    const before = await counts();
    const model = { provider: "anthropic", model: "claude-test" };
    for (const tool of H2_TOOLS) {
      const without = data(await get(gateway, owner, tool.action)).report;
      const withModel = data(await get(gateway, owner, tool.action, {}, model)).report;
      expect(withModel?.sections.map((s) => s.id), tool.action).toEqual(without?.sections.map((s) => s.id));
      expect(withModel?.status, tool.action).toBe(without?.status);
    }
    expect(await counts()).toEqual(before);
  });
});

describe("portene: kun den suverene eieren fra en signert enhetsøkt - og alt avslås FØR noe bygges", () => {
  const CASES: ReadonlyArray<readonly [string, IdentityContext, string]> = [
    ["annen person i eierens tenant", idFor(MEMBER, TENANT_A), "control_center_owner_only"],
    ["annen tenants eier", idFor(OTHER_TENANT_OWNER, TENANT_B), "control_center_owner_only"],
    ["eieren, passiv økt på tale", idFor(OWNER, TENANT_A, { channel: "voice", auth_strength: "passive" }), "control_center_requires_signed_device_session"]
  ];
  for (const tool of H2_TOOLS) {
    it(`${tool.action}: nektes for ${CASES.length} identitetskategorier, og hver nekting står som tool.denied`, async () => {
      const before = (await deniedRows(tool.action)).length;
      for (const [label, identity, reason] of CASES) expect(await get(gateway, identity, tool.action), label).toEqual({ ok: false, reason });
      const after = await deniedRows(tool.action);
      expect(after.length - before).toBe(CASES.length);
      expect(after.slice(before).map((r) => r.reason)).toEqual(CASES.map((c) => c[2]));
    });
  }

  it("FAIL-CLOSED uten register: de fire verktøyene er ikke åpne for noen (selv ikke eieren)", async () => {
    const bare = wire({}, { withRegistry: false });
    for (const tool of H2_TOOLS) expect(await get(bare, owner, tool.action), tool.action).toEqual({ ok: false, reason: "control_center_owner_check_not_configured" });
  });
});

describe("flagg og avhengigheter", () => {
  it("hvert flagg slår på KUN sitt senter - de andre tre er ikke koblet inn (found: false), og H1-sentrene er også av", async () => {
    for (const [flag, id] of [[CONTROL_CENTER_FLAGS.operations, "operations"], [CONTROL_CENTER_FLAGS.value, "value"], [CONTROL_CENTER_FLAGS.privacy, "privacy"], [CONTROL_CENTER_FLAGS.security, "security"]] as const) {
      const g = wire({ [flag]: "on" });
      const found: string[] = [];
      for (const tool of H2_TOOLS) if (data(await get(g, owner, tool.action)).found) found.push(tool.center);
      expect(found, flag).toEqual([id]);
      expect(data(await get(g, owner, "get_finance_center")).found).toBe(false);
    }
  });

  it("kun den eksakte verdien «on» slår på (aldri true/1/ON)", async () => {
    for (const value of ["true", "1", "ON", "yes", " on", "on "]) {
      const g = wire({ [CONTROL_CENTER_FLAGS.privacy]: value });
      expect(data(await get(g, owner, "get_privacy_center")).found, JSON.stringify(value)).toBe(false);
    }
  });

  it("Sikkerhet uten eier-kontrollene/kill switch er ærlig «ikke koblet inn» selv med flagget på (aldri en halv rapport)", async () => {
    const g = wire({ [CONTROL_CENTER_FLAGS.security]: "on" }, { withControls: false });
    const r = data(await get(g, owner, "get_security_center"));
    expect(r.found).toBe(false);
    expect(r.summary_no).toContain("ikke koblet inn");
  });

  it("alle fire AV: `found: false` med en ærlig forklaring, og oversikten viser dem under «ikke koblet inn»", async () => {
    for (const tool of H2_TOOLS) {
      const r = await get(gatewayFlagsOff, owner, tool.action);
      expect(r.ok).toBe(true);
      expect(data(r)).toMatchObject({ found: false, center: tool.center });
    }
    const overview = data(await get(gatewayFlagsOff, owner, "get_control_center")) as unknown as { unregistered: string[]; centers: Array<{ center: string }> };
    for (const tool of H2_TOOLS) expect(overview.unregistered).toContain(tool.center);
    expect(overview.centers.some((c) => H2_TOOLS.some((t) => t.center === c.center))).toBe(false);
  });

  it("oversikten med alt PÅ lister de fire (og H0-sentrene Integrasjoner/Autoritet) som koblet inn, og de ti sentrene summerer seg: koblet inn + ikke koblet inn = ti", async () => {
    const overview = data(await get(gateway, owner, "get_control_center")) as unknown as { unregistered: string[]; centers: Array<{ center: string }> };
    const ids = overview.centers.map((c) => c.center);
    for (const id of ["operations", "value", "privacy", "security", "finance", "memory", "agent", "integration", "authority"]) expect(ids, id).toContain(id);
    expect(ids.length + overview.unregistered.length).toBe(10);
  });
});

describe("kun lesing", () => {
  it("radtall i tasks, payment_intents, memory_items, owner_control_state og autonomi-bindinger er uendret etter alle kallene over", async () => {
    const before = await counts();
    for (const tool of H2_TOOLS) await get(gateway, owner, tool.action);
    await get(gateway, owner, "get_control_center");
    expect(await counts()).toEqual(before);
  });
});
