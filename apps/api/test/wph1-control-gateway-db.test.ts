import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import { CONTROL_CENTER_READ_TOOLS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions, type ControlCenterReport } from "@jarvis/executive";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider } from "@jarvis/tool-gateway";
import { CONTROL_CENTER_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { enabledControlCenters } from "../src/control-center/shared.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H1 - EKTE ToolGateway + PolicyGateway + Postgres (app-rolle, RLS) + produksjonsfabrikken for registeret + `registerControlCenters` med flaggene PÅ:
 *  - eieren (suveren, signert enhetsøkt) får rapporten via `executive.get_<senter>_center` OG via `get_control_center {center}` - samme innhold;
 *  - alle andre nektes av verktøyets port FØR noe bygges, med `tool.denied` i revisjonssporet; svak autentisering nektes med en tydelig årsak; kill switch stopper også lesingen;
 *  - FAIL-CLOSED uten register: per-senter-verktøyene er ikke åpne, i motsetning til get_control_center (H0);
 *  - en modell i løkka (servingModel) får aldri pengebeløp fra Finans; siden (ingen modell) får hele rapporten;
 *  - gjennomgang M1: flaggene AV er identisk med main: per-senter-verktøyene er IKKE registrert (`unknown_tool`), `get_control_center` har main sin rate-grense, og H0-oppførselen er uendret; ingenting skrives (radtall uendret).
 */
let db: H0Db;
const TENANT_A = "tenant-cg-a";
const TENANT_B = "tenant-cg-b";
const OWNER = "person-cg-owner";
const OTHER_TENANT_OWNER = "person-cg-b";
const MEMBER = "person-cg-member";
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
const idFor = (person: string, tenant: string, extra: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: "personal", session_id: `s-${person}`, device_id: "dev", channel: "web", auth_strength: "signed", ...extra
});
const owner = idFor(OWNER, TENANT_A);
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT_A] };

let killSwitch: KillSwitch;
let policy: PolicyGateway;
let gateway: ToolGateway;
let gatewayFlagsOff: ToolGateway;

/** Samme kobling som `main.ts`: per-senter-verktøyene registreres KUN for sentrene med flagget på (`enabledControlCenters`). */
function wire(env: Record<string, string | undefined>, withRegistry = true): ToolGateway {
  const g = new ToolGateway(db.appPool, policy, secrets);
  if (!withRegistry) {
    // Verktøyene er registrert (flaggene på) men registeret mangler: porten må feile lukket.
    for (const tool of executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(g)), { controlCenters: enabledControlCenters(ALL_ON) })) g.register(tool);
    return g;
  }
  const registry = createControlCenterRegistry({ authority });
  registerControlCenters(registry, { pool: db.appPool, env, toolGateway: g });
  for (const tool of executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(g, { controlCenters: registry })), { controlCenters: enabledControlCenters(env) })) g.register(tool);
  return g;
}
const ALL_ON = { [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.memory]: "on", [CONTROL_CENTER_FLAGS.agent]: "on" };

const get = (g: ToolGateway, identity: IdentityContext, action: string, parameters: Record<string, string> = {}, servingModel?: { provider: string; model: string }) =>
  g.execute({ identity, tool_id: "executive", action, parameters, ...(servingModel ? { servingModel } : {}) });
type CenterData = { found: boolean; center?: string; summary_no: string; explanation_no?: string; report?: ControlCenterReport };
const data = (r: Awaited<ReturnType<typeof get>>): CenterData => (r as unknown as { data: CenterData }).data;
const factKeys = (r: ControlCenterReport | undefined): string[] => (r?.sections ?? []).flatMap((s) => s.items.flatMap((i) => Object.keys(i.facts ?? {})));
const deniedRows = async (action: string): Promise<Array<{ reason: string; person_id: string }>> =>
  (await db.adminPool.query("SELECT reason, person_id FROM audit_events WHERE type = 'tool.denied' AND tool_id = 'executive' AND action = $1 ORDER BY audit_id", [action])).rows as Array<{ reason: string; person_id: string }>;
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["tasks", "payment_intents", "memory_items", "owner_control_state"]) out[t] = Number((await db.adminPool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
  return out;
}

beforeAll(async () => {
  db = await startH0Db("cg");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: OWNER }, { tenant_id: TENANT_B, person_id: OTHER_TENANT_OWNER }]);
  await admin.query("INSERT INTO people (person_id, display_name) VALUES ($1, $1)", [MEMBER]);
  await admin.query("INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ($1, $2, 'member')", [MEMBER, TENANT_A]);
  await admin.query(
    `INSERT INTO payment_intents (payment_intent_id, tenant_id, idempotency_key, state, purpose, amount_ore, vendor_name, account_code, reconciliation_state)
     VALUES ('pi-cg-a', $1, 'k1', 'settled', 'formål', 150000, 'Leverandør', '6300', 'unreconciled'), ('pi-cg-b', $2, 'k2', 'settled', 'formål', 777000, 'Leverandør', '6300', 'matched')`, [TENANT_A, TENANT_B]
  );
  await admin.query(`INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract) VALUES ('t-cg-a', $1, $2, 'mål', 'created', '{"agent_profile":"executive"}'::jsonb), ('t-cg-b', $3, $4, 'mål', 'created', '{"agent_profile":"executive"}'::jsonb)`, [TENANT_A, OWNER, TENANT_B, OTHER_TENANT_OWNER]);
  killSwitch = new KillSwitch();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(db.appPool), killSwitch, authority });
  gateway = wire(ALL_ON);
  gatewayFlagsOff = wire({});
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("eieren får rapportene (flaggene PÅ)", () => {
  for (const tool of CONTROL_CENTER_READ_TOOLS) {
    it(`${tool.action}: ok, funnet, målt - og identisk innhold som get_control_center {center: "${tool.center}"}`, async () => {
      const viaTool = await get(gateway, owner, tool.action);
      expect(viaTool.ok).toBe(true);
      const t = data(viaTool);
      expect(t.found).toBe(true);
      expect(t.report?.center).toBe(tool.center);
      expect(t.report?.sections.length).toBeGreaterThan(3);
      expect(t.report?.sections.every((s) => s.measured)).toBe(true);
      expect(t.summary_no.length).toBeGreaterThan(10);
      const viaCenter = data(await get(gateway, owner, "get_control_center", { center: tool.center }));
      expect(viaCenter.report?.sections.map((s) => s.id)).toEqual(t.report?.sections.map((s) => s.id));
      expect(viaCenter.report?.status).toBe(t.report?.status);
    });
  }

  it("oversikten (get_control_center uten center) lister de tre som koblet inn - ikke lenger «ikke koblet inn»", async () => {
    const overview = data(await get(gateway, owner, "get_control_center")) as unknown as { centers: Array<{ center: string }>; unregistered: string[] };
    expect(overview.centers.map((c) => c.center).sort()).toEqual(["agent", "finance", "memory"]);
    expect(overview.unregistered).not.toEqual(expect.arrayContaining(["finance"]));
  });

  it("tenant-isolasjon i sluttrapportene: A ser A sin jobb og A sine intensjoner - aldri B sine", async () => {
    const agent = JSON.stringify(data(await get(gateway, owner, "get_agent_center")).report);
    expect(agent).toContain("t-cg-a");
    expect(agent).not.toContain("t-cg-b");
    const finance = data(await get(gateway, owner, "get_finance_center")).report;
    const settled = finance?.sections.find((s) => s.id === "intents")?.items.find((i) => i.id === "state:settled");
    expect(settled?.facts).toMatchObject({ count: 1, amount_ore: 150_000 }); // siden (ingen modell i løkka) får beløpet, og kun A sitt - B sine 777000 er aldri med
    expect(JSON.stringify(finance)).not.toContain("777000");
  });
});

describe("pengebeløp når aldri en modell", () => {
  it("med en modell i løkka (servingModel) er alle *_ore-fakta fjernet fra Finans - via begge verktøyene; uten modell ligger de i rapporten", async () => {
    const model = { provider: "anthropic", model: "claude-test" };
    expect(factKeys(data(await get(gateway, owner, "get_finance_center")).report)).toContain("amount_ore");
    for (const [action, params] of [["get_finance_center", {}], ["get_control_center", { center: "finance" }]] as const) {
      const report = data(await get(gateway, owner, action, params, model)).report;
      expect(report?.center).toBe("finance");
      expect(factKeys(report).filter((k) => /_ore$/.test(k)), action).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("150000");
    }
  });
});

describe("portene: kun den suverene eieren fra en signert enhetsøkt - og alt avslås FØR noe bygges", () => {
  const CASES: ReadonlyArray<readonly [string, IdentityContext, string]> = [
    ["annen person i eierens tenant", idFor(MEMBER, TENANT_A), "control_center_owner_only"],
    ["delegat (eierens person_id med delegation_id)", idFor(OWNER, TENANT_A, { delegation_id: "deleg-1" }), "control_center_owner_only"],
    ["eierens person i en annen tenant", idFor(OWNER, TENANT_B), "control_center_owner_only"],
    ["annen tenants eier", idFor(OTHER_TENANT_OWNER, TENANT_B), "control_center_owner_only"],
    ["eieren, passiv økt på tale", idFor(OWNER, TENANT_A, { channel: "voice", auth_strength: "passive" }), "control_center_requires_signed_device_session"],
    ["eieren, aktiv økt uten enhetssignatur", idFor(OWNER, TENANT_A, { auth_strength: "active" }), "control_center_requires_signed_device_session"]
  ];

  for (const tool of CONTROL_CENTER_READ_TOOLS) {
    it(`${tool.action}: nektes for ${CASES.length} identitetskategorier med riktig årsak, og hver nekting står som tool.denied i revisjonssporet`, async () => {
      const before = (await deniedRows(tool.action)).length;
      for (const [label, identity, reason] of CASES) expect(await get(gateway, identity, tool.action), label).toEqual({ ok: false, reason });
      const after = await deniedRows(tool.action);
      expect(after.length - before).toBe(CASES.length);
      expect(after.slice(before).map((r) => r.reason)).toEqual(CASES.map((c) => c[2]));
    });
  }

  it("FAIL-CLOSED uten register: per-senter-verktøyene er ikke åpne for noen (selv ikke eieren), mens get_control_center slipper gjennom med en tom oversikt (H0)", async () => {
    const bare = wire({}, false);
    for (const tool of CONTROL_CENTER_READ_TOOLS) expect(await get(bare, owner, tool.action), tool.action).toEqual({ ok: false, reason: "control_center_owner_check_not_configured" });
    const overview = await get(bare, owner, "get_control_center");
    expect(overview.ok).toBe(true);
  });

  it("kill switch stopper også disse lesingene (de står ikke på selvgjenopprettingslisten)", async () => {
    killSwitch.activate("wph1-test");
    try {
      for (const tool of CONTROL_CENTER_READ_TOOLS) expect(await get(gateway, owner, tool.action), tool.action).toMatchObject({ ok: false, reason: expect.stringContaining("kill_switch") });
    } finally {
      killSwitch.deactivate();
    }
    expect((await get(gateway, owner, "get_agent_center")).ok).toBe(true);
  });
});

describe("hastighetsgrense", () => {
  it("get_control_center tåler en full sideoppdatering to ganger (2 × (1 + 10) kall) når sentrene er på - den gamle grensen på 30/min tålte det ikke; per-senter-verktøyene har fortsatt 30/min", async () => {
    const g = wire(ALL_ON);
    let okCount = 0;
    for (let i = 0; i < 60; i += 1) if ((await get(g, owner, "get_control_center")).ok) okCount += 1;
    expect(okCount).toBe(60);
    let allowed = 0;
    let denied: unknown;
    for (let i = 0; i < 35; i += 1) {
      const r = await get(g, owner, "get_memory_center");
      if (r.ok) allowed += 1; else denied = r;
    }
    expect(allowed).toBe(30);
    expect(denied).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("gjennomgang M1: flaggene AV er identisk med main", () => {
  it("per-senter-verktøyene er IKKE registrert: ingen `get_<senter>_center` finnes i gatewayens liste, og et kall gir `unknown_tool` (som før H1) - for eieren og alle andre", async () => {
    const registered = gatewayFlagsOff.list().filter((d) => d.tool_id === "executive").map((d) => d.action);
    for (const tool of CONTROL_CENTER_READ_TOOLS) {
      expect(registered, tool.action).not.toContain(tool.action);
      expect(await get(gatewayFlagsOff, owner, tool.action), tool.action).toEqual({ ok: false, reason: "unknown_tool" });
      expect(await get(gatewayFlagsOff, idFor(MEMBER, TENANT_A), tool.action), `${tool.action} (medlem)`).toEqual({ ok: false, reason: "unknown_tool" });
    }
    expect(registered).toContain("get_control_center"); // H0-verktøyet er der som før
  });

  it("kun flaggene som er på gir verktøy: Minne på alene registrerer `get_memory_center` og ingen av de to andre", async () => {
    const g = wire({ [CONTROL_CENTER_FLAGS.memory]: "on" });
    const registered = g.list().filter((d) => d.tool_id === "executive").map((d) => d.action);
    expect(registered).toContain("get_memory_center");
    expect(registered).not.toContain("get_finance_center");
    expect(registered).not.toContain("get_agent_center");
  });

  it("`get_control_center` uten sentre på: ærlig `ikke koblet inn` med main sin ordlyd, oversikten viser alle som «ikke koblet inn», og hele svaret har main sin form", async () => {
    const one = data(await get(gatewayFlagsOff, owner, "get_control_center", { center: "finance" }));
    expect(one).toEqual({ found: false, center: "finance", summary_no: "Dette kontrollsenteret er ikke koblet inn ennå, så ingenting kan vurderes." });
    const overview = data(await get(gatewayFlagsOff, owner, "get_control_center")) as unknown as { centers: unknown[]; unregistered: string[]; status: string };
    expect(overview.centers).toEqual([]);
    expect(overview.unregistered).toEqual(expect.arrayContaining(["finance", "memory", "agent"]));
    expect(overview.status).toBe("UNKNOWN");
    expect(Object.keys(overview)).toEqual(["summary_no", "generated_at", "status", "sensitivity", "centers", "unregistered"]);
  });

  it("rate-grensen på `get_control_center` er main sin (30/min) når ingen sentre er på - hevingen til 120/min er flaggstyrt", async () => {
    const g = wire({});
    let ok = 0;
    for (let i = 0; i < 35; i += 1) if ((await get(g, owner, "get_control_center")).ok) ok += 1;
    expect(ok).toBe(30);
    expect(await get(g, owner, "get_control_center")).toEqual({ ok: false, reason: "rate_limited" });
    expect(g.list().find((d) => d.tool_id === "executive" && d.action === "get_control_center")?.rate_limit_per_minute).toBe(30);
    expect(gateway.list().find((d) => d.tool_id === "executive" && d.action === "get_control_center")?.rate_limit_per_minute).toBe(120);
  });
});

describe("kun lesing", () => {
  it("radtall i tasks, payment_intents, memory_items og owner_control_state er uendret etter alle kallene over", async () => {
    const before = await counts();
    for (const tool of CONTROL_CENTER_READ_TOOLS) await get(gateway, owner, tool.action);
    await get(gateway, owner, "get_control_center");
    expect(await counts()).toEqual(before);
  });
});
