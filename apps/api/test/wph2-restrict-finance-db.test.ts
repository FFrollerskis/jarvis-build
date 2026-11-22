import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  ControlCenterRegistry, ExecutiveService, ExecutiveTransport, composeInfraStatus, controlItem, controlSection,
  type ControlCenterDefinition, type ControlCenterReport, type InfraStatusReport
} from "@jarvis/executive";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import { createOperationsCenter } from "../src/control-center/operations.ts";
import {
  CREDENTIAL_ACTIONS, EXECUTIVE_WRAPPED_OWNER_ACTIONS, RECOVERY_ACTIONS, createSecurityCenter, readSecurityAggregates
} from "../src/control-center/security.ts";
import { NOT_FINANCE_AUDIT_SQL, isFinanceAuditRow, isFinanceJobName } from "../src/control-center/shared.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-H2 gjennomgang L2 og M2 mot EKTE Postgres som EKTE app-rolle (RLS), med de EKTE Sikkerhet- og Drift-sentrene:
 *  - L2: `executive.<h>` nøstes i `owner_controls.<h>` og begge skriver `tool.executed` - kun det YTTERSTE laget telles (nøstet fikstur: ett par = 1, ikke 2); listen over omsluttede handlinger er låst mot verktøyregisteret;
 *  - M2: for en SKYmodell (`restrictFinance`) utelates finansavledet tilstand HELT (finans-nødbryteren, finansjobbene, revisjonsrader og bekreftelser i finansdomenet), uten at status, tellinger og sammendrag bærer dem;
 *    lokal modell og siden får alt; og en bygging for skyen deler aldri nøkkel med en full bygging.
 */
let db: H0Db;
const TENANT_A = "tenant-rf-a";
const TENANT_B = "tenant-rf-b";
const NOW = new Date();
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const idA: IdentityContext = { person_id: "person-rf-a", tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: "person-rf-b", tenant_id: TENANT_B };
const CLOUD = { provider: "anthropic", model: "claude-test" };
const LOCAL = { provider: "gemma_local", model: "gemma-local" };
const FINANCE_MARKERS = ["finance_kill_switch", "Finans-nødbryter", "finance-reconcile-sweep", "stripe-payment-sync", "finance_stripe", "finance_amount_cap", "disable_finance_kill_switch", "finans-nødbryter opphevet"];

let killSwitch: KillSwitch;
let ownerControls: OwnerControls;

function infra(): InfraStatusReport {
  return composeInfraStatus({
    as_of: NOW,
    measurements: { incidents: { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 0 }, last_changes: {}, producer_runs: [], errors: [] },
    producers_enabled: true, producers_interval_ms: 300_000, producer_names: ["scheduler"], infra_mode: "NORMAL", targets: []
  });
}

beforeAll(async () => {
  db = await startH0Db("rf");
  const admin = db.adminPool;
  await seedTenants(admin, [{ tenant_id: TENANT_A, person_id: idA.person_id }, { tenant_id: TENANT_B, person_id: idB.person_id }]);
  const audit = (tenant: string, person: string, type: string, tool: string | null, action: string | null, extra: { reason?: string; at?: Date } = {}): Promise<unknown> =>
    admin.query("INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, tool_id, action, at, payload) VALUES ($1,$2,$3,'X',$4,$5,$6,$7,'{}'::jsonb)", [tenant, person, type, extra.reason ?? null, tool, action, extra.at ?? ago(H)]);
  // NØSTEDE par (ytre executive + indre owner_controls, begge `tool.executed`): to tilbakekall og én gjenoppretting + ett par for kill switch
  for (const action of ["revoke_credential", "revoke_credential", "restore_credential", "deactivate_kill_switch"]) {
    await audit(TENANT_A, idA.person_id, "tool.executed", "executive", action, { at: ago(2 * D) });
    await audit(TENANT_A, idA.person_id, "tool.executed", "owner_controls", action, { at: ago(2 * D) });
  }
  // handlinger UTEN executive-omslag: telles som før (kun owner_controls)
  await audit(TENANT_A, idA.person_id, "tool.executed", "owner_controls", "set_connector_credential", { at: ago(D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "owner_controls", "test_connector", { at: ago(D) });
  await audit(TENANT_A, idA.person_id, "tool.denied", "owner_controls", "test_connector", { at: ago(D), reason: "rate_limited" });
  // resume_domain: executive -> situations.unpause_domain (ulikt tool_id/action, aldri doblet)
  await audit(TENANT_A, idA.person_id, "tool.executed", "executive", "resume_domain", { at: ago(D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "situations", "unpause_domain", { at: ago(D) });
  // finansdomenet: avslag (finance_stripe), nødbryter på og av (executive + nøstet finance), og en vanlig, ikke-finans avslagsrad
  await audit(TENANT_A, idA.person_id, "tool.denied", "finance_stripe", "create_refund", { reason: "finance_amount_cap", at: ago(H) });
  await audit(TENANT_A, idA.person_id, "tool.denied", "finance_stripe", "create_refund", { reason: "finance_amount_cap", at: ago(2 * H) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "executive", "enable_finance_kill_switch", { at: ago(3 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "finance", "enable_kill_switch", { at: ago(3 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "executive", "disable_finance_kill_switch", { at: ago(2 * D) });
  await audit(TENANT_A, idA.person_id, "tool.executed", "finance", "disable_kill_switch", { at: ago(2 * D) });
  await audit(TENANT_A, idA.person_id, "tool.denied", "email", "send", { reason: "step_up_required:signed_device_session", at: ago(H) });
  await audit(TENANT_A, idA.person_id, "device.enrollment_denied", null, null, { at: ago(D) }); // ingen tool_id/action (NULL-trygghet)
  // B: egne rader som A aldri skal se
  await audit(TENANT_B, idB.person_id, "tool.executed", "executive", "revoke_credential", { at: ago(H) });
  await audit(TENANT_B, idB.person_id, "tool.executed", "owner_controls", "revoke_credential", { at: ago(H) });
  const confirmation = (id: string, tenant: string, person: string, tool: string, action: string): Promise<unknown> =>
    admin.query("INSERT INTO action_confirmations (confirmation_id, tenant_id, person_id, tool_id, action, call_fingerprint, binding_hash, nonce, summary, taint_reasons, status, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,'fp','bh',$1,'{}'::jsonb,$6,'pending',$7,$8)",
      [id, tenant, person, tool, action, ["untrusted_output:email.read_inbox"], new Date(NOW.getTime() + 3 * H), ago(D)]);
  await confirmation("c-a-email", TENANT_A, idA.person_id, "email", "send");
  await confirmation("c-a-finance", TENANT_A, idA.person_id, "finance_stripe", "create_refund");
  await admin.query("INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_by_person_id, enabled_at, reason) VALUES ($1, true, $2, $3, 'privat')", [TENANT_A, idA.person_id, ago(4 * H)]);
  // planlagte jobber (globale): to finansjobber og to andre
  const today = NOW.toISOString().slice(0, 10);
  for (const name of ["finance-reconcile-sweep", "stripe-payment-sync", "memory-retention-sweep", "business-open-loop-sweep"]) {
    await admin.query("INSERT INTO scheduler_state (job_name, run_date, claimed_by, claimed_at, completed_at, attempts, last_error) VALUES ($1,$2::date,'test',$3,$3,1,NULL)", [name, today, ago(H)]);
  }
  const authority = { owner_person_id: idA.person_id };
  killSwitch = new KillSwitch(db.appPool, authority);
  await killSwitch.restore();
  ownerControls = new OwnerControls(killSwitch, db.appPool, authority);
  await ownerControls.restore();
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

const defs = productionToolDefinitions({ goldenSuite: true, autonomyRevoke: true });
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) } as never;
const sec = (r: ControlCenterReport | undefined, id: string) => r?.sections.find((s) => s.id === id);
const item = (r: ControlCenterReport | undefined, s: string, i: string) => sec(r, s)?.items.find((x) => x.id === i);

describe("L2: kun det YTTERSTE laget telles (executive nøstet i owner_controls)", () => {
  it("nøstet fikstur: to tilbakekall, én gjenoppretting og én kill switch-opphevelse gir nøyaktig 2 / 1 / 1 - ikke doblet", async () => {
    const a = await readSecurityAggregates(db.appPool, TENANT_A, NOW.getTime());
    const byAction = Object.fromEntries(a.credential_events.map((e) => [e.action, e.executed]));
    expect(byAction).toMatchObject({ revoke_credential: 2, restore_credential: 1, deactivate_kill_switch: 1 });
    expect(Object.fromEntries(a.recovery_events.map((e) => [e.action, e.n]))).toMatchObject({ restore_credential: 1, deactivate_kill_switch: 1, resume_domain: 1 });
  });

  it("handlinger uten executive-omslag (`set_connector_credential`, `test_connector`) telles som før - inkl. nektede", async () => {
    const a = await readSecurityAggregates(db.appPool, TENANT_A, NOW.getTime());
    expect(a.credential_events.find((e) => e.action === "set_connector_credential")).toMatchObject({ executed: 1, denied: 0 });
    expect(a.credential_events.find((e) => e.action === "test_connector")).toMatchObject({ executed: 1, denied: 1 });
  });

  it("tenant-isolasjon: B sitt nøstede par er ett tilbakekall hos B og ikke med hos A", async () => {
    const b = await readSecurityAggregates(db.appPool, TENANT_B, NOW.getTime());
    expect(b.credential_events).toEqual([expect.objectContaining({ action: "revoke_credential", executed: 1 })]);
  });

  it("senteret som helhet: sammendraget teller de ytterste utførelsene (revisjonsvisningen viser ikke doble tall)", async () => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createSecurityCenter({ pool: db.appPool, toolGateway, ownerControls, killSwitch }));
    const r = (await registry.report("security", idA)) as ControlCenterReport;
    expect(item(r, "credentials", "action:revoke_credential")?.facts).toMatchObject({ executed: 2 });
    expect(item(r, "recovery", "recovered:restore_credential")?.facts).toMatchObject({ count: 1 });
  });

  it("listen over omsluttede handlinger er LÅST mot verktøyregisteret: hver har både `executive.<h>` og `owner_controls.<h>`, og ingen annen kontrollhandling i CREDENTIAL_ACTIONS har et executive-omslag", () => {
    const has = (tool: string, action: string): boolean => defs.some((d) => d.tool_id === tool && d.action === action);
    for (const a of EXECUTIVE_WRAPPED_OWNER_ACTIONS) {
      expect(has("executive", a), `executive.${a}`).toBe(true);
      expect(has("owner_controls", a), `owner_controls.${a}`).toBe(true);
    }
    for (const a of CREDENTIAL_ACTIONS.filter((x) => !EXECUTIVE_WRAPPED_OWNER_ACTIONS.includes(x))) {
      expect(has("owner_controls", a), `owner_controls.${a}`).toBe(true);
      expect(has("executive", a), `executive.${a} (nytt omslag? legg det i EXECUTIVE_WRAPPED_OWNER_ACTIONS)`).toBe(false);
    }
    for (const a of RECOVERY_ACTIONS.filter((x) => !EXECUTIVE_WRAPPED_OWNER_ACTIONS.includes(x))) expect(has("owner_controls", a), `${a} er ikke omsluttet`).toBe(false);
  });
});

describe("M2: restrictFinance på lesernes SQL (revisjon og bekreftelser i finansdomenet er ute for skyen)", () => {
  it("NULL-trygg og presis: `isFinanceAuditRow` og SQL-predikatet er enige", () => {
    expect(isFinanceAuditRow("finance_stripe", "create_refund")).toBe(true);
    expect(isFinanceAuditRow("finance", "disable_kill_switch")).toBe(true);
    expect(isFinanceAuditRow("executive", "enable_finance_kill_switch")).toBe(true);
    expect(isFinanceAuditRow("executive", "get_finance_center")).toBe(true);
    expect(isFinanceAuditRow("email", "send")).toBe(false);
    expect(isFinanceAuditRow(null, null)).toBe(false);
    expect(isFinanceAuditRow("financial_advisor_x", "list")).toBe(false); // ikke `finance(_|$)`
    expect(NOT_FINANCE_AUDIT_SQL).toContain("IS NULL");
  });

  it("full (siden/lokal modell): alt telles - finansavslag, nødbryter-gjenoppretting og bekreftelsen i finansdomenet er med", async () => {
    const full = await readSecurityAggregates(db.appPool, TENANT_A, NOW.getTime());
    expect(full.audit.denied_7d).toBe(4); // 2 finans + email + rate_limited test_connector
    expect(full.deny_reasons.map((r) => r.reason)).toContain("finance_amount_cap");
    expect(full.recovery_events.map((r) => r.action)).toContain("disable_finance_kill_switch");
    expect(full.tainted_confirmations).toEqual([expect.objectContaining({ status: "pending", n: 2 })]);
  });

  it("begrenset (skymodell): finansavslag, avslagsårsaken, finans-gjenopprettingen og finans-bekreftelsen er borte - resten (inkl. rader uten tool_id) er uendret", async () => {
    const r = await readSecurityAggregates(db.appPool, TENANT_A, NOW.getTime(), { restrictFinance: true });
    expect(r.audit.denied_7d).toBe(2);
    expect(r.deny_reasons.map((x) => x.reason).sort()).toEqual(["rate_limited", "step_up_required:signed_device_session"]);
    expect(r.recovery_events.map((x) => x.action)).not.toContain("disable_finance_kill_switch");
    expect(r.recovery_events.map((x) => x.action)).toEqual(expect.arrayContaining(["restore_credential", "deactivate_kill_switch", "resume_domain"]));
    expect(r.tainted_confirmations).toEqual([expect.objectContaining({ status: "pending", n: 1 })]);
    expect(r.access_denials.map((x) => x.type)).toEqual(["device.enrollment_denied"]); // NULL tool_id/action beholdes
    expect(JSON.stringify(r)).not.toContain("finance");
  });
});

describe("M2: Sikkerhet og Drift bygges uten finansavledet tilstand for en skymodell (utførelses-håndhevet i transporten)", () => {
  const stubCenter = (id: "finance" | "value"): ControlCenterDefinition => ({
    id, title_no: id === "finance" ? "Finans" : "Verdi", description_no: "test",
    build: async () => ({ sections: [controlSection({ id: "s", title_no: "S", source: "t", summary_no: "x", items: [controlItem({ id: "i", label: "Rad", status: "OK", detail_no: "d", facts: { amount_ore: 123_456 } })] })], actions: [] })
  });
  function transport(): ExecutiveTransport {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(stubCenter("finance"));
    registry.register(createOperationsCenter({ pool: db.appPool, infraStatus: async () => infra(), processStartedAt: () => new Date(NOW.getTime() - 2 * H) }));
    registry.register(stubCenter("value"));
    registry.register(createSecurityCenter({ pool: db.appPool, toolGateway, ownerControls, killSwitch }));
    const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as never;
    return new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry, servedLocally: (m) => m.provider === "gemma_local" }));
  }
  const call = async (t: ExecutiveTransport, action: string, params: Record<string, string>, servingModel?: { provider: string; model: string }): Promise<Record<string, unknown>> =>
    (await t.invoke(action, params, "cred", { identity: idA, ...(servingModel ? { servingModel } : {}) } as never)).data as unknown as Record<string, unknown>;
  const reportOf = (d: Record<string, unknown>): ControlCenterReport => d["report"] as ControlCenterReport;

  it("Sikkerhet: skymodell - ingen finans-nødbryter, ingen finans-gjenoppretting, ingen finans-markører; lokal modell og siden - begge er der", async () => {
    const t = transport();
    const cloud = reportOf(await call(t, "get_security_center", {}, CLOUD));
    expect(item(cloud, "recovery", "finance_kill_switch")).toBeUndefined();
    expect(item(cloud, "recovery", "recovered:disable_finance_kill_switch")).toBeUndefined();
    for (const m of FINANCE_MARKERS) expect(JSON.stringify(cloud), m).not.toContain(m);
    for (const who of [LOCAL, undefined] as const) {
      const full = reportOf(await call(t, "get_security_center", {}, who));
      expect(item(full, "recovery", "finance_kill_switch")?.status, who?.provider ?? "siden").toBe("WARN");
      expect(item(full, "recovery", "recovered:disable_finance_kill_switch")).toBeDefined();
    }
  });

  it("Drift: skymodell - finansjobbene er ikke i seksjonen, tellingen og sammendraget følger; lokal modell og siden får alle jobbene", async () => {
    const t = transport();
    const cloud = reportOf(await call(t, "get_operations_center", {}, CLOUD));
    expect(sec(cloud, "jobs")?.items.map((i) => i.id).sort()).toEqual(["job:business-open-loop-sweep", "job:memory-retention-sweep"]);
    expect(sec(cloud, "jobs")?.summary_no).toContain("2 daglige jobber");
    for (const m of FINANCE_MARKERS) expect(JSON.stringify(cloud), m).not.toContain(m);
    const local = reportOf(await call(t, "get_operations_center", {}, LOCAL));
    expect(sec(local, "jobs")?.items.map((i) => i.id)).toEqual(expect.arrayContaining(["job:finance-reconcile-sweep", "job:stripe-payment-sync"]));
    expect(sec(local, "jobs")?.summary_no).toContain("4 daglige jobber");
  });

  it("samme regel via get_control_center {center}: skyen får de begrensede rapportene, og Finans og Verdi holdes tilbake HELT", async () => {
    const t = transport();
    expect(reportOf(await call(t, "get_control_center", { center: "security" }, CLOUD)).sections.some((s) => JSON.stringify(s).includes("finance_kill_switch"))).toBe(false);
    for (const center of ["finance", "value"]) expect(await call(t, "get_control_center", { center }, CLOUD)).toMatchObject({ found: true, withheld: true, center });
    expect(reportOf(await call(t, "get_control_center", { center: "security" }, LOCAL)).sections.some((s) => JSON.stringify(s).includes("finance_kill_switch"))).toBe(true);
  });

  it("oversikten til en skymodell: Finans og Verdi står i `withheld` (ikke bygget), Sikkerhet og Drift er bygget UTEN finansavledet tilstand; lokal modell får alle fire", async () => {
    const t = transport();
    const cloud = await call(t, "get_control_center", {}, CLOUD) as { centers: Array<{ center: string; summary_no: string }>; withheld?: string[] };
    expect(cloud.withheld).toEqual(["finance", "value"]);
    expect(cloud.centers.map((c) => c.center).sort()).toEqual(["operations", "security"]);
    for (const m of FINANCE_MARKERS) expect(JSON.stringify(cloud), m).not.toContain(m);
    const local = await call(t, "get_control_center", {}, LOCAL) as { centers: Array<{ center: string }>; withheld?: string[] };
    expect(local.withheld).toBeUndefined();
    expect(local.centers.map((c) => c.center).sort()).toEqual(["finance", "operations", "security", "value"]);
  });
});

describe("M2: en bygging for skyen deler aldri nøkkel med en full bygging (single-flight per målgruppe)", () => {
  it("samtidige bygginger: to for samme målgruppe deler ÉN bygging; én full og én begrenset gir to - og hver får sin egen rapport", async () => {
    let builds = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe: ControlCenterDefinition = {
      id: "security", title_no: "Sikkerhet", description_no: "test",
      async build(ctx) {
        builds += 1;
        await gate;
        return { sections: [controlSection({ id: "s", title_no: "S", source: "t", summary_no: "x", items: [controlItem({ id: ctx.restrictFinance === true ? "begrenset" : "full", label: "Rad", status: "OK", detail_no: "d" })] })], actions: [] };
      }
    };
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(probe);
    const pending = [registry.report("security", idA), registry.report("security", idA), registry.report("security", idA, { restrictFinance: true }), registry.report("security", idA, { restrictFinance: true })];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(builds).toBe(2);
    release?.();
    const [full1, full2, restricted1, restricted2] = (await Promise.all(pending)) as ControlCenterReport[];
    expect(sec(full1, "s")?.items[0]?.id).toBe("full");
    expect(sec(full2, "s")?.items[0]?.id).toBe("full");
    expect(sec(restricted1, "s")?.items[0]?.id).toBe("begrenset");
    expect(sec(restricted2, "s")?.items[0]?.id).toBe("begrenset");
  });

  it("`isFinanceJobName` treffer finansjobbene fra main.ts (og ingen andre)", () => {
    for (const name of ["finance-spend-integrity-sweep", "finance-reconcile-sweep", "stripe-payment-sync", "vipps-payment-sync", "neonomics-sweep", "wallester-sweep"]) expect(isFinanceJobName(name), name).toBe(true);
    for (const name of ["daily-brief", "memory-retention-sweep", "business-open-loop-sweep", "support-inbox-sync", "situation-sweep"]) expect(isFinanceJobName(name), name).toBe(false);
  });
});
