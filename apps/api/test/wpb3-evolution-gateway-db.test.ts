import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import { ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ControlCenterReport, type SloReport } from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ChangeLedger } from "@jarvis/self-modification";
import { ToolGateway, type ConnectorStatus, type SecretProvider } from "@jarvis/tool-gateway";
import { servedByCloudModel } from "../src/cloud-tool-screen.ts";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { CONTROL_CENTER_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { controlCentersWithTools } from "../src/control-center/shared.ts";
import { createEvolutionReadinessProvider, createEvolutionReportProvider, type EvolutionSourceDeps } from "../src/evolution-source.ts";
import { RunRateService } from "../src/run-rate.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B3 (D-475, EV-22) - EKTE ToolGateway + PolicyGateway + Postgres (app-rolle, RLS) + produksjonsfabrikken for registeret + `registerControlCenters` med de EKTE kildene (rapport, beredskap, run-rate, endringsregister):
 *  - eieren (suveren, signert enhetsøkt) får rapporten via `executive.get_evolution_center` OG via `get_control_center {center: "evolution"}` - samme innhold, og tallene er databasens egne for eierens tenant;
 *  - alle andre nektes av verktøyets port FØR noe bygges, med `tool.denied` i revisjonssporet; porten er fail-closed uten register; kill switch stanser lesingen;
 *  - KOSTNAD I ØRE (strengeste regel, Q-64): en SKYmodell får ALDRI rapporten (verken via verktøyet, `get_control_center {center}` eller oversikten); en LOKAL modell og siden får alt;
 *  - flagg AV = main: verktøyet finnes ikke (`unknown_tool`), og `center: "evolution"` avvises som et hvilket som helst annet ukjent navn; et senter uten sine avhengigheter er ikke registrert og har ikke et verktøy;
 *  - ingenting skrives (radtall uendret) utover revisjonsradene gatewayen selv skriver.
 */
let db: H0Db;
const TENANT_A = "tenant-b3g-a";
const TENANT_B = "tenant-b3g-b";
const OWNER = "person-b3g-owner";
const OTHER_TENANT_OWNER = "person-b3g-b";
const MEMBER = "person-b3g-member";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed", ...extra
});
const owner = idFor(OWNER, TENANT_A);
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };
/** Distinkte tall: A sitt forbruk denne måneden (234 567 øre) og B sitt (9 876 543 øre) - ingen av dem skal noen gang nå en skymodell, og B sitt skal aldri nå A. */
const SPENT_A = 234_567;
const SPENT_B = 9_876_543;
const CLOUD = { provider: "anthropic", model: "claude-test" };
const LOCAL = { provider: "gemma_local", model: "gemma-local" };

const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "d".repeat(64) }, ledger: { status: "ok", count: 3, head_hash: "h" } };
const slo: SloReport = { as_of: new Date().toISOString(), not_measured: [], drift: null, data_quality: null, summary_no: "", slos: [{ id: "chat-success", label: "Chat", status: "OK", value: 1, target: 0.9, metric: "success_rate", samples: 50, window_hours: 24, source: "x", observed_at: new Date().toISOString(), detail: "d" }] };
const github: ConnectorStatus = { id: "github", display_name: "github", category: "integration" as never, configured: true, credentials: [], test_method: "presence_only", health: { state: "healthy", at: new Date().toISOString() } };
const mesh: MeshStatus = { providers: [{ provider: "gemma_local", model: "g", state: "LIVE", success: 1, failures: 0 }], router: "HEALTHY", fallback: "LOGIC_ONLY", critic: "READY_SELECTIVE" };
const sourceDeps = (): EvolutionSourceDeps => ({ pool: db.appPool, tenantId: TENANT_A, env: {}, ev0Status: () => BOOT, slo: async () => slo, connectors: async () => [github], killSwitchActive: async () => false, mesh: () => mesh });

let killSwitch: KillSwitch;
let policy: PolicyGateway;
let ownerControls: OwnerControls;
let gateway: ToolGateway;
let gatewayFlagsOff: ToolGateway;

interface WireOptions { withRegistry?: boolean; withReport?: boolean }
function wire(env: Record<string, string | undefined>, options: WireOptions = {}): ToolGateway {
  const { withRegistry = true, withReport = true } = options;
  const g = new ToolGateway(db.appPool, policy, secrets);
  if (!withRegistry) {
    // Verktøyet er registrert (flagget på) men registeret mangler: porten må feile lukket.
    for (const tool of executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(g)), { controlCenters: ["evolution"] })) g.register(tool);
    return g;
  }
  const registry = createControlCenterRegistry({ authority });
  registerControlCenters(registry, {
    pool: db.appPool, env, toolGateway: g, ownerControls, killSwitch, authority,
    ...(withReport ? {
      evolutionReport: createEvolutionReportProvider(sourceDeps()), evolutionReadiness: createEvolutionReadinessProvider(sourceDeps()),
      ev0Status: () => BOOT, runRate: new RunRateService(db.appPool), evolutionTenantId: TENANT_A
    } : {})
  });
  const service = new ExecutiveService(g, {
    controlCenters: registry,
    // SAMME kobling som main.ts: lokalitet fra leverandørregisteret (ukjent leverandør = sky)
    servedLocally: (model) => !servedByCloudModel({ provider: model.provider })
  });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(service), { controlCenters: controlCentersWithTools(env, registry) })) g.register(tool);
  return g;
}
const ON = { [CONTROL_CENTER_FLAGS.evolution]: "on" };

const get = (g: ToolGateway, identity: IdentityContext, action: string, parameters: Record<string, string> = {}, servingModel?: { provider: string; model: string }) =>
  g.execute({ identity, tool_id: "executive", action, parameters, ...(servingModel ? { servingModel } : {}) });
type CenterData = { found: boolean; withheld?: boolean; center?: string; summary_no: string; explanation_no?: string; report?: ControlCenterReport };
const data = (r: Awaited<ReturnType<typeof get>>): CenterData => (r as unknown as { data: CenterData }).data;
const item = (r: ControlCenterReport | undefined, s: string, i: string) => r?.sections.find((x) => x.id === s)?.items.find((x) => x.id === i);
const deniedRows = async (action: string): Promise<Array<{ reason: string; person_id: string }>> =>
  (await db.adminPool.query("SELECT reason, person_id FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = $1 ORDER BY audit_id", [action])).rows as Array<{ reason: string; person_id: string }>;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tasks", "payment_intents", "memory_items", "owner_control_state", "situation_autonomy_policies", "cost_events", "evolution_change_ledger"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}
const truthSpent = async (tenant: string): Promise<number> =>
  Number((await db.adminPool.query("SELECT coalesce(sum(amount_ore), 0)::bigint AS n FROM cost_events WHERE tenant_id = $1 AND at >= date_trunc('month', now())", [tenant])).rows[0].n);

beforeAll(async () => {
  db = await startH0Db("b3g");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: OTHER_TENANT_OWNER }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  // Kostnad (now() = alltid inneværende måned, uavhengig av dato): A 234 567 øre i tre rader, B 9 876 543 øre.
  const cost = (tenant: string, ore: number): Promise<unknown> =>
    admin.query("INSERT INTO cost_events (at, tenant_id, kind, amount_ore, provider, model) VALUES (now(), $1, 'model', $2, 'anthropic', 'claude')", [tenant, ore]);
  await cost(TENANT_A, 100_000);
  await cost(TENANT_A, 100_000);
  await cost(TENANT_A, 34_567);
  await cost(TENANT_B, SPENT_B);
  // Endringsregister: to forslag venter, ett er avvist.
  const ledger = new ChangeLedger(admin);
  const row = (change_id: string, change_class: "E1" | "E2", decision: "proposed" | "rejected") =>
    ledger.append({ change_id, change_class, decision, constitution_digest: "e".repeat(64), subject: "HEMMELIG FORSLAGSTEKST", paths: ["config/hemmelig.json"], branch: "", head_sha: null, evidence: {}, recorded_by: "test" });
  await row("g1", "E1", "proposed");
  await row("g2", "E2", "proposed");
  await row("g3", "E2", "proposed");
  await row("g3", "E2", "rejected");
  killSwitch = new KillSwitch(db.appPool, { owner_person_id: OWNER });
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, { owner_person_id: OWNER });
  await ownerControls.restore();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch, authority });
  gateway = wire(ON);
  gatewayFlagsOff = wire({});
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("eieren får rapporten (flagg PÅ, alle avhengigheter koblet)", () => {
  it("get_evolution_center: ok, funnet, fire seksjoner målt med kilde - og identisk innhold som get_control_center {center: \"evolution\"}", async () => {
    const viaTool = await get(gateway, owner, "get_evolution_center");
    expect(viaTool.ok).toBe(true);
    const t = data(viaTool);
    expect(t.found).toBe(true);
    expect(t.withheld).toBeUndefined();
    expect(t.report?.center).toBe("evolution");
    expect(t.report?.sections.map((s) => s.id)).toEqual(["ports", "dormant", "ledger", "cost_model"]);
    expect(t.report?.sections.every((s) => s.measured && s.source.length > 20)).toBe(true);
    expect(t.summary_no.length).toBeGreaterThan(10);
    expect(t.report?.actions).toEqual([]);
    const viaCenter = data(await get(gateway, owner, "get_control_center", { center: "evolution" }));
    expect(viaCenter.report?.sections.map((s) => s.id)).toEqual(t.report?.sections.map((s) => s.id));
    expect(viaCenter.report?.status).toBe(t.report?.status);
  });

  it("tallene er databasens egne for EIERENS tenant: forbruket er A sine 234 567 øre (aldri B sine ni millioner), endringsregisteret teller de to ventende forslagene, og den avviste er ikke med", async () => {
    const truthA = await truthSpent(TENANT_A);
    expect(truthA).toBe(SPENT_A);
    const report = data(await get(gateway, owner, "get_evolution_center")).report;
    expect(item(report, "cost_model", "month_to_date")).toMatchObject({ status: "FAIL", facts: { level: "needs_approval", spent_month_ore: SPENT_A } });
    expect(item(report, "ledger", "proposals")).toMatchObject({ status: "WARN", facts: { waiting: 2, class_E1: 1, class_E2: 1 } });
    expect(item(report, "ledger", "proposal:g1")).toBeDefined();
    expect(item(report, "ledger", "proposal:g3")).toBeUndefined();
    expect(item(report, "ports", "port:ev5")?.detail_no).toContain("2 forslag venter");
    const out = JSON.stringify(report);
    expect(out).not.toContain(String(SPENT_B));
    expect(out).not.toContain("HEMMELIG");
    expect(out).not.toContain("hemmelig.json");
  });

  it("de sovende delene er IKKE aktivert (`activation_decision` false) og alle ni vises; konstitusjonen og hash-kjeden kommer fra oppstartssjekken", async () => {
    const report = data(await get(gateway, owner, "get_evolution_center")).report;
    const dormant = report?.sections.find((s) => s.id === "dormant");
    expect(dormant?.items).toHaveLength(9);
    for (const i of dormant?.items ?? []) expect(i.facts?.["activation_decision"], i.id).toBe(false);
    expect(item(report, "ledger", "chain")).toMatchObject({ status: "OK", facts: { chain: "ok", rows: 3 } });
    expect(item(report, "ledger", "constitution")).toMatchObject({ status: "OK", facts: { constitution: "verified" } });
  });
});

describe("KOSTNAD I ØRE (strengeste regel, Q-64): en SKYmodell får aldri Evolusjon-senteret - lokal modell og siden får alt; aldri skriving", () => {
  it("en skymodell får «holdt tilbake» (uten rapport, uten tall) via BEGGE verktøyene og i oversikten; en lokal modell og siden får rapporten - og radtall er uendret", async () => {
    const before = await counts();
    for (const [action, params] of [["get_evolution_center", {}], ["get_control_center", { center: "evolution" }]] as const) {
      const cloud = data(await get(gateway, owner, action, params, CLOUD));
      expect(cloud.withheld, action).toBe(true);
      expect(cloud.report, action).toBeUndefined();
      expect(cloud.summary_no).toContain("kostmodellen");
      const out = JSON.stringify(cloud);
      expect(out).not.toMatch(/_ore|amount_ore/);
      for (const n of [String(SPENT_A), String(SPENT_B), "100000", "34567"]) expect(out, `${action} ${n}`).not.toContain(n);
      expect(data(await get(gateway, owner, action, params, LOCAL)).report?.center, `${action} lokal`).toBe("evolution");
      expect(data(await get(gateway, owner, action, params)).report?.center, `${action} siden`).toBe("evolution");
    }
    const overview = data(await get(gateway, owner, "get_control_center", {}, CLOUD)) as unknown as { withheld?: string[]; centers: Array<{ center: string }>; summary_no: string };
    expect(overview.withheld).toEqual(["evolution"]);
    expect(overview.centers.map((c) => c.center)).not.toContain("evolution");
    expect(overview.summary_no).toContain("pluss 1 tilleggssenter: Evolusjon");
    expect(await counts()).toEqual(before);
  });

  it("den LOKALE modellen og siden ser kostmodellen med øre i måledata (A sine tall), men aldri B sine", async () => {
    for (const model of [LOCAL, undefined]) {
      const out = JSON.stringify(data(await get(gateway, owner, "get_evolution_center", {}, model)));
      expect(out).toContain(String(SPENT_A));
      expect(out).not.toContain(String(SPENT_B));
    }
  });

  it("en ukjent leverandør regnes som sky (fail-closed): rapporten holdes tilbake", async () => {
    const r = data(await get(gateway, owner, "get_evolution_center", {}, { provider: "ukjent_leverandor", model: "m" }));
    expect(r.withheld).toBe(true);
    expect(r.report).toBeUndefined();
  });
});

describe("portene: kun den suverene eieren fra en signert enhetsøkt - og alt avslås FØR noe bygges", () => {
  const CASES: ReadonlyArray<readonly [string, IdentityContext, string]> = [
    ["annen person i eierens tenant", idFor(MEMBER, TENANT_A), "control_center_owner_only"],
    ["annen tenants eier", idFor(OTHER_TENANT_OWNER, TENANT_B), "control_center_owner_only"],
    ["eieren, passiv økt på tale", idFor(OWNER, TENANT_A, { channel: "voice", auth_strength: "passive" }), "control_center_requires_signed_device_session"]
  ];
  it(`get_evolution_center: nektes for ${CASES.length} identitetskategorier, og hver nekting står som tool.denied`, async () => {
    const before = (await deniedRows("get_evolution_center")).length;
    for (const [label, identity, reason] of CASES) expect(await get(gateway, identity, "get_evolution_center"), label).toEqual({ ok: false, reason });
    const after = await deniedRows("get_evolution_center");
    expect(after.length - before).toBe(CASES.length);
    expect(after.slice(before).map((r) => r.reason)).toEqual(CASES.map((c) => c[2]));
  });

  it("get_control_center {center: \"evolution\"} nektes likt for ikke-eiere (samme eier-port)", async () => {
    for (const [label, identity] of CASES) expect((await get(gateway, identity, "get_control_center", { center: "evolution" })).ok, label).toBe(false);
  });

  it("FAIL-CLOSED uten register: verktøyet er ikke åpent for noen (selv ikke eieren)", async () => {
    const bare = wire({}, { withRegistry: false });
    expect(await get(bare, owner, "get_evolution_center")).toEqual({ ok: false, reason: "control_center_owner_check_not_configured" });
  });

  it("kill switch aktiv: lesingen nektes av policyen (senteret står ikke på selvgjenopprettingslisten), og etter oppheving virker den igjen", async () => {
    await killSwitch.activateDurable("wpb3-gateway", OWNER);
    try {
      const r = await get(gateway, owner, "get_evolution_center");
      expect(r.ok).toBe(false);
      expect(String((r as { reason?: string }).reason)).toContain("kill_switch");
    } finally {
      await killSwitch.deactivateDurable(OWNER);
    }
    expect((await get(gateway, owner, "get_evolution_center")).ok).toBe(true);
  });
});

describe("flagg og avhengigheter (flagg AV = main)", () => {
  it("flagg AV: verktøyet finnes ikke (`unknown_tool`, ingen verktøyoppføring), `center: \"evolution\"` avvises som et hvilket som helst ukjent navn, og oversikten har ikke tilleggssenteret", async () => {
    expect(gatewayFlagsOff.list().some((d) => d.tool_id === "executive" && d.action === "get_evolution_center")).toBe(false);
    expect(await get(gatewayFlagsOff, owner, "get_evolution_center")).toEqual({ ok: false, reason: "unknown_tool" });
    const evolution = await get(gatewayFlagsOff, owner, "get_control_center", { center: "evolution" });
    const unknown = await get(gatewayFlagsOff, owner, "get_control_center", { center: "billing" });
    expect(evolution.ok).toBe(false);
    expect(evolution).toEqual(unknown);
    const overview = data(await get(gatewayFlagsOff, owner, "get_control_center")) as unknown as { unregistered: string[]; centers: Array<{ center: string }>; summary_no: string };
    expect(overview.unregistered).not.toContain("evolution");
    expect(overview.centers.some((c) => c.center === "evolution")).toBe(false);
    expect(overview.summary_no).not.toMatch(/tilleggssenter|Evolusjon/);
  });

  it("kun den eksakte verdien «on» slår på (aldri true/1/ON)", async () => {
    for (const value of ["true", "1", "ON", "yes", " on", "on "]) {
      const g = wire({ [CONTROL_CENTER_FLAGS.evolution]: value });
      expect(await get(g, owner, "get_evolution_center"), JSON.stringify(value)).toEqual({ ok: false, reason: "unknown_tool" });
    }
  });

  it("uten evolusjonsrapporten er senteret ærlig «ikke koblet inn» selv med flagget på - og verktøyet listes ikke som tilgjengelig for et senter som ikke finnes (gjennomgang L5)", async () => {
    const g = wire(ON, { withReport: false });
    expect(g.list().some((d) => d.tool_id === "executive" && d.action === "get_evolution_center")).toBe(false);
    expect(await get(g, owner, "get_evolution_center")).toEqual({ ok: false, reason: "unknown_tool" });
  });

  it("andre senterflagg slår IKKE på Evolusjon (kun dets eget flagg gjør det)", async () => {
    const g = wire({ [CONTROL_CENTER_FLAGS.operations]: "on", [CONTROL_CENTER_FLAGS.security]: "on", [CONTROL_CENTER_FLAGS.value]: "on" });
    expect(await get(g, owner, "get_evolution_center")).toEqual({ ok: false, reason: "unknown_tool" });
  });
});

describe("kun lesing", () => {
  it("radtall i tasks, payment_intents, memory_items, owner_control_state, autonomi-bindinger, cost_events og endringsregisteret er uendret etter alle kallene", async () => {
    const before = await counts();
    await get(gateway, owner, "get_evolution_center");
    await get(gateway, owner, "get_control_center");
    await get(gateway, owner, "get_control_center", { center: "evolution" });
    expect(await counts()).toEqual(before);
  });
});
