import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HomeAssistantCriticalTransport, PersonalActionJournal, ToolGateway, executePersonalAction, homeCriticalToolDefinitions, parseHomeTargets,
  personalActionIndex, type ClassDNotification, type SecretProvider
} from "../src/index.ts";
import { FakeHomeAssistant } from "./support/fake-home-assistant.ts";

/**
 * WP-G2 P1a (D-464): de kritiske hjemmehandlingene gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede, lokal fake Home Assistant) + handlingsjournalen.
 * Bevist: step-up (strengeste standard) også for «autonome» identiteter, mål-allowlist FØR transporten, hele klasse D-kjeden (preflight/idempotens/ventetid/readback/varsling), feil sluttilstand vises
 * umiddelbart (MISMATCH), uavklart utfall gir aldri en ny kommando (replay), journal med før-/etter-tilstand, uforanderlighet, RLS og at hemmeligheter (alarmkoden) aldri lagres.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let ha: FakeHomeAssistant;
const TENANT = "tenant-g2-home";
const OTHER_TENANT = "tenant-g2-other";
const owner: IdentityContext = { person_id: "person-g2-owner", tenant_id: TENANT, memory_space_id: "home", session_id: "sess-g2", device_id: "dev-g2", channel: "api", auth_strength: "signed" };
const PIN = "9876-fake-pin-for-test";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-g2-home-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_g2_home LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_g2_home");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','G2','person'), ('${OTHER_TENANT}','G2 other','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-g2-owner','Owner'), ('person-g2-delegate','Delegate'), ('person-g2-other','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-g2-owner','${TENANT}'), ('person-g2-delegate','${TENANT}'), ('person-g2-other','${OTHER_TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_g2_home", password: "pw2" });
  ha = new FakeHomeAssistant();
  await ha.start();
}, 240_000);

afterAll(async () => {
  await ha?.stop();
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(() => { ha.reset(); });

interface Harness {
  gateway: ToolGateway; notifications: ClassDNotification[]; killSwitch: KillSwitch; controls: OwnerControls; journal: PersonalActionJournal;
  executor: Parameters<typeof executePersonalAction>[0]; setNotifierReady(v: boolean): void;
}

function harness(opts: { targets?: string; alarmCode?: boolean } = {}): Harness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : null) };
  const notifications: ClassDNotification[] = [];
  let ready = true;
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => ready, notify: async (n) => { notifications.push(n); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  let t = 0;
  const transport = new HomeAssistantCriticalTransport({
    baseUrl: async () => ha.baseUrl, settleMs: 5_000, pollMs: 500, now: () => t, sleep: async (ms) => { t += ms; },
    ...(opts.alarmCode ? { alarmCode: async () => PIN } : {})
  });
  const config = { targets: parseHomeTargets(opts.targets ?? "lock.front_door,cover.garage,alarm_control_panel.home,valve.main_water,switch.hot_water,scene.good_night,script.leaving,climate.living"), settleMs: 5_000, pollMs: 500 };
  for (const d of homeCriticalToolDefinitions(transport, config)) gateway.register(d);
  const journal = new PersonalActionJournal(appPool);
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  return { gateway, notifications, killSwitch, controls, journal, executor: { pool: appPool, gateway, journal, index }, setNotifierReady: (v) => { ready = v; } };
}

let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const run = (h: Harness, action: string, params: Record<string, JsonValue>, idempotencyKey?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: "home-assistant", action, parameters: params, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) });
async function ledger(k: string) {
  return (await adminPool.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as
    { status: string; before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null; postcondition_reason: string | null } | undefined;
}

describe("A: lås gjennom hele klasse D-kjeden", () => {
  it("happy path: ok, ledger `succeeded` med fersk før- og etter-tilstand, nøyaktig ett tjenestekall og et umiddelbart eier-varsel med redigert sammendrag", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    ha.transitionReads = 2;
    const k = key("lock");
    const result = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k);
    expect(result).toMatchObject({ ok: true, notified: true, deduplicated: false });
    expect(ha.serviceCalls()).toHaveLength(1);
    const row = await ledger(k);
    expect(row?.status).toBe("succeeded");
    expect(row?.before_state).toMatchObject({ state: "unlocked", settled: true });
    expect(row?.after_state).toMatchObject({ state: "locked", locked: true });
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({ outcome: "executed", tool_id: "home-assistant", action: "critical_lock", idempotency_key: k });
    expect(h.notifications[0]?.summary).toBe("lås lock.front_door: unlocked -> locked (ønsket)");
    expect(h.notifications[0]?.recovery).toMatch(/motsatt/);
  });

  it("samme nøkkel på nytt etter suksess: lagret resultat, INGEN ny kommando (idempotens)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    const k = key("idem");
    expect((await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k)).ok).toBe(true);
    const again = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k);
    expect(again).toMatchObject({ ok: true, deduplicated: true });
    expect(ha.serviceCalls()).toHaveLength(1);
  });

  it("alle åtte handlingstypene fullfører kjeden mot fake HA med riktig sluttilstand", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "locked" });
    ha.set("cover.garage", { state: "closed" });
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.set("valve.main_water", { state: "open" });
    ha.set("switch.hot_water", { state: "off" });
    ha.set("scene.good_night", { state: "unknown" });
    ha.set("script.leaving", { state: "off", attributes: { last_triggered: null } });
    ha.set("climate.living", { state: "heat", attributes: { hvac_modes: ["off", "heat", "cool"] } });
    ha.transitionReads = 1;
    const cases: Array<[string, Record<string, JsonValue>]> = [
      ["critical_lock", { entity: "lock.front_door", locked: false }],
      ["critical_cover", { entity: "cover.garage", target: "open" }],
      ["critical_alarm", { entity: "alarm_control_panel.home", armed: true, mode: "night" }],
      ["critical_valve", { entity: "valve.main_water", target: "closed" }],
      ["critical_switch", { entity: "switch.hot_water", on: true }],
      ["critical_scene", { entity: "scene.good_night", expected_last_activated: null }],
      ["critical_script", { entity: "script.leaving", expected_last_triggered: null }],
      ["critical_climate_mode", { entity: "climate.living", hvac_mode: "off" }]
    ];
    for (const [action, params] of cases) expect(await run(h, action, params, key(action)), action).toMatchObject({ ok: true, notified: true });
    expect(h.notifications.map((n) => n.outcome)).toEqual(Array(8).fill("executed"));
    expect(ha.serviceCalls().map((r) => r.path)).toEqual([
      "/api/services/lock/unlock", "/api/services/cover/open_cover", "/api/services/alarm_control_panel/alarm_arm_night", "/api/services/valve/close_valve",
      "/api/services/switch/turn_on", "/api/services/scene/turn_on", "/api/services/script/turn_on", "/api/services/climate/set_hvac_mode"
    ]);
  });
});

describe("B: step-up er den strengeste standarden - ingen identitet, kanal eller «autonomi» lemper på den", () => {
  it("svak økt (active), tale (signed), Telegram, system/autonomi (active og signed) og klokke: avvist FØR HA nås, ingen kommando, ingen preflight", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    const cases: Array<[string, IdentityContext, string]> = [
      ["active", { ...owner, auth_strength: "active" }, "step_up_required:signed_device_session"],
      ["passive", { ...owner, auth_strength: "passive" }, "step_up_required:signed_device_session"],
      ["voice signed", { ...owner, channel: "voice" }, "step_up_required:channel_voice_not_allowed"],
      ["telegram signed", { ...owner, channel: "telegram" }, "step_up_required:channel_telegram_not_allowed"],
      ["system (autonomi-binding/auto-ACT) active", { ...owner, channel: "system", auth_strength: "active" }, "step_up_required:signed_device_session"],
      ["system signed", { ...owner, channel: "system" }, "step_up_required:channel_system_not_allowed"],
      ["watch signed", { ...owner, channel: "watch" }, "step_up_required:channel_watch_not_allowed"]
    ];
    for (const [name, identity, reason] of cases) {
      const result = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("su"), identity);
      expect(result, name).toEqual({ ok: false, reason });
    }
    expect(ha.requests).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });

  it("en delegat (annen person i samme tenant) og en annen tenant avvises (credential bundet til eieren), uten HA-kall", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    const delegate: IdentityContext = { ...owner, person_id: "person-g2-delegate", session_id: "sess-d" };
    const foreign: IdentityContext = { ...owner, tenant_id: OTHER_TENANT, person_id: "person-g2-other" };
    for (const id of [delegate, foreign]) {
      const result = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("deleg"), id);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toMatch(/^(credential_not_bound_to_identity|owner_only|class_d_missing_approval)/);
    }
    expect(ha.requests).toHaveLength(0);
  });
});

describe("C: mål-allowlist FØR transporten, og fail-closed ved ukjent/ugyldig mål", () => {
  it("ikke-allowlistet entitet og tom allowlist avvises uten HA-kall; lesehandlingen følger samme allowlist", async () => {
    const h = harness({ targets: "lock.front_door" });
    ha.set("lock.back_door", { state: "unlocked" });
    expect(await run(h, "critical_lock", { entity: "lock.back_door", locked: true }, key("t1"))).toEqual({ ok: false, reason: "home_target_not_authorized" });
    expect(await run(h, HOME_CRITICAL_READ_ACTION, { entity: "lock.back_door" })).toEqual({ ok: false, reason: "home_target_not_authorized" });
    const empty = harness({ targets: "" });
    expect(await run(empty, "critical_lock", { entity: "lock.front_door", locked: true }, key("t2"))).toEqual({ ok: false, reason: "home_target_not_authorized" });
    expect(ha.requests).toHaveLength(0);
  });

  it("allowlistet, men FINNES IKKE i Home Assistant: `preflight_target_not_found` - kommandoen sendes aldri", async () => {
    const h = harness();
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("nf"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(ha.serviceCalls()).toHaveLength(0);
  });

  it("ugyldig før-tilstand (jammed, utilgjengelig, midt i overgang, endret forutsetning) avvises med årsak før kommandoen", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "jammed" });
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("j"))).toEqual({ ok: false, reason: "preflight_invalid:lock_jammed" });
    ha.set("lock.front_door", { state: "unavailable" });
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("u"))).toEqual({ ok: false, reason: "preflight_invalid:entity_unavailable" });
    ha.set("lock.front_door", { state: "locked" });
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: false, expected_state: "unlocked" }, key("e"))).toEqual({ ok: false, reason: "preflight_invalid:precondition_changed" });
    expect(await run(h, "critical_scene", { entity: "scene.good_night", expected_last_activated: null }, key("s"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(ha.serviceCalls()).toHaveLength(0);
  });

  it("klasse D uten idempotensnøkkel og med varsler som ikke er klar: avvist (ingen stille standard, ingen handling uten out-of-band-varsel)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true })).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    h.setNotifierReady(false);
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("nr"))).toEqual({ ok: false, reason: "class_d_notifier_not_ready" });
    expect(ha.serviceCalls()).toHaveLength(0);
  });

  it("kill switch, frys av tool_id og frys av connector-id (`home_assistant`) stanser handlingen", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    h.killSwitch.activate("test");
    expect((await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("ks"))).ok).toBe(false);
    h.killSwitch.deactivate();
    h.controls.freezeConnector("home-assistant");
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("f1"))).toEqual({ ok: false, reason: "connector_frozen" });
    h.controls.unfreezeConnector("home-assistant");
    h.controls.freezeConnector("home_assistant");
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("f2"))).toEqual({ ok: false, reason: "connector_frozen" });
    expect(ha.serviceCalls()).toHaveLength(0);
    h.controls.unfreezeConnector("home_assistant");
    expect((await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("f3"))).ok).toBe(true);
  });
});

describe("D: feil sluttilstand og uavklart utfall vises UMIDDELBART - aldri en fabrikkert suksess", () => {
  it("låsen sitter fast (jammed): kommandoen aksepteres, readback viser jammed -> `postcondition_mismatch`, ledger `unverified`, varsel «utført men ikke verifisert»", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked", mode: "jam" });
    const k = key("jam");
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    const row = await ledger(k);
    expect(row).toMatchObject({ status: "unverified", postcondition_reason: "postcondition_mismatch" });
    expect(row?.after_state).toMatchObject({ state: "jammed" });
    expect(h.notifications.at(-1)).toMatchObject({ outcome: "unverified" });
  });

  it("kommando akseptert men uvirksom (bryteren endret seg aldri): mismatch med den gamle tilstanden i etter-bildet", async () => {
    const h = harness();
    ha.set("switch.hot_water", { state: "off", mode: "ineffective" });
    const k = key("noeff");
    expect(await run(h, "critical_switch", { entity: "switch.hot_water", on: true }, k)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(k))?.after_state).toMatchObject({ state: "off" });
  });

  it("porten sitter fast i «closing» til fristen: mismatch (ikke antatt åpen/lukket), og varselet sier at utfallet ikke er verifisert", async () => {
    const h = harness();
    ha.set("cover.garage", { state: "open", mode: "stall" });
    const k = key("stall");
    expect(await run(h, "critical_cover", { entity: "cover.garage", target: "closed" }, k)).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(k))?.after_state).toMatchObject({ state: "closing", settled: false });
    expect(h.notifications.at(-1)?.outcome).toBe("unverified");
  });

  it("HA svarer 5xx etter kommandoen: UTFALL UKJENT (`unverified`), varsel «ukjent», og en replay med samme nøkkel sender ALDRI en ny kommando", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    const k = key("5xx");
    ha.nextServiceStatus = 500;
    const first = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k);
    expect(first).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:home_service_http_500" });
    expect((await ledger(k))?.status).toBe("unverified");
    expect(h.notifications.at(-1)?.outcome).toBe("unknown");
    const posts = ha.serviceCalls().length;
    const replay = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, k);
    expect(replay.ok).toBe(false);
    expect(ha.serviceCalls()).toHaveLength(posts);
  });

  it("HA kobler fra etter å ha mottatt kommandoen: utfall ukjent (aldri retry-bar); HA avviser (400): entydig feil, `failed`, retry med samme nøkkel TILLATT", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    const dropped = key("drop");
    ha.dropNextService = true;
    const result = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, dropped);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/^tool_failed:outcome_unknown:home_service_transport_/);
    expect((await ledger(dropped))?.status).toBe("unverified");

    const rejected = key("rej");
    ha.nextServiceStatus = 400;
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, rejected)).toEqual({ ok: false, reason: "tool_failed:home_assistant_rejected_400" });
    expect((await ledger(rejected))?.status).toBe("failed");
    const retried = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, rejected);
    expect(retried.ok).toBe(true);
  });
});

describe("E: hemmeligheter - alarmkoden når HA, men aldri ledger, audit, varsel eller journal", () => {
  it("armering med kode: HA mottar koden; ingen lagret tilstand, audit-rad, varsel eller journalrad inneholder den", async () => {
    const h = harness({ alarmCode: true });
    ha.requireAlarmCode = PIN;
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 2;
    const result = await executePersonalAction(h.executor, owner, { domain: "home", action: "critical_alarm", parameters: { entity: "alarm_control_panel.home", armed: true }, idempotency_key: key("pin") });
    expect(result).toMatchObject({ outcome: "SUCCESS", replayed: false });
    expect(ha.serviceCalls().at(-1)?.code_present).toBe(true);
    const dump = JSON.stringify([
      (await adminPool.query("SELECT * FROM tool_executions")).rows, (await adminPool.query("SELECT * FROM audit_events")).rows, (await adminPool.query("SELECT * FROM personal_action_journal")).rows, h.notifications
    ]);
    expect(dump).not.toContain(PIN);
    expect(dump).not.toContain("9876");
    expect(dump).not.toMatch(/IGNORE ALL PREVIOUS INSTRUCTIONS/); // utstyrets fritekst (friendly_name) når aldri ledger/audit/journal
  });
});

describe("F: handlingsjournalen via eksekutoren", () => {
  const exec = (h: Harness, action: string, parameters: Record<string, JsonValue>, k: string, identity: IdentityContext = owner) =>
    executePersonalAction(h.executor, identity, { domain: "home", action, parameters, idempotency_key: k });

  it("SUCCESS: raden er `applied` med før-/etter-tilstand, målet, risikoretning, aktør og proveniens (person/tenant/space/kilde/session)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "locked" });
    const k = key("j-ok");
    const result = await exec(h, "critical_lock", { entity: "lock.front_door", locked: false }, k);
    expect(result).toMatchObject({ outcome: "SUCCESS", reason: null, replayed: false });
    expect(result.action).toMatchObject({
      status: "applied", domain: "home", tool_id: "home-assistant", action: "critical_lock", risk_class: "D", risk_direction: "increases", target_ref: "lock.front_door", idempotency_key: k,
      actor_person_id: owner.person_id, tenant_id: TENANT, memory_space_id: "home", source: "owner_route", session_id: owner.session_id, failure_code: null
    });
    expect(result.action.before_state).toMatchObject({ state: "locked" });
    expect(result.action.after_state).toMatchObject({ state: "unlocked" });
    expect(result.action.external_id).toBe("lock.unlock:lock.front_door");
    expect(result.action.completed_at).not.toBeNull();
  });

  it("replay av en fullført handling returnerer den lagrede raden uten ny kommando; samme nøkkel for en ANNEN forespørsel er en konflikt (aldri «det lagrede resultatet»)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "locked" });
    const k = key("j-replay");
    await exec(h, "critical_lock", { entity: "lock.front_door", locked: false }, k);
    const posts = ha.serviceCalls().length;
    const replay = await exec(h, "critical_lock", { entity: "lock.front_door", locked: false }, k);
    expect(replay).toMatchObject({ outcome: "SUCCESS", replayed: true });
    expect(ha.serviceCalls()).toHaveLength(posts);
    await expect(exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, k)).rejects.toThrow("personal_action_idempotency_conflict");
    await expect(exec(h, "critical_cover", { entity: "cover.garage", target: "open" }, k)).rejects.toThrow("personal_action_idempotency_conflict");
  });

  it("MISMATCH og UNKNOWN: raden er `outcome_unknown` (aldri applied) med årsakskoden og det som faktisk ble lest; replay etterpå gir fortsatt ingen ny kommando", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked", mode: "jam" });
    const km = key("j-mm");
    const mismatch = await exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, km);
    expect(mismatch).toMatchObject({ outcome: "MISMATCH", reason: "postcondition_mismatch" });
    expect(mismatch.action).toMatchObject({ status: "outcome_unknown", failure_code: "postcondition_mismatch" });
    expect(mismatch.action.after_state).toMatchObject({ state: "jammed" });

    ha.set("lock.back", { state: "unlocked" });
    const h2 = harness({ targets: "lock.back" });
    const ku = key("j-unk");
    ha.nextServiceStatus = 500;
    const unknown = await exec(h2, "critical_lock", { entity: "lock.back", locked: true }, ku);
    expect(unknown).toMatchObject({ outcome: "UNKNOWN" });
    expect(unknown.action.status).toBe("outcome_unknown");
    const posts = ha.serviceCalls().length;
    expect(await exec(h2, "critical_lock", { entity: "lock.back", locked: true }, ku)).toMatchObject({ outcome: "UNKNOWN", replayed: true });
    expect(ha.serviceCalls()).toHaveLength(posts);
  });

  it("FAILED: avvist FØR utstyret (mål ikke tillatt, step-up mangler) gir `failed` med årsakskoden - og en avvisning på en replay nedgraderer ALDRI en rad som kan ha vært utført", async () => {
    const h = harness({ targets: "lock.front_door" });
    ha.set("lock.front_door", { state: "unlocked" });
    const denied = await exec(h, "critical_lock", { entity: "lock.other", locked: true }, key("j-den"));
    expect(denied).toMatchObject({ outcome: "FAILED", reason: "home_target_not_authorized" });
    expect(denied.action).toMatchObject({ status: "failed", failure_code: "home_target_not_authorized" });
    // Åpen rad (ukjent utfall), så en replay fra en svak økt: avvist av step-up, men raden forblir åpen og svaret er UKJENT.
    const k = key("j-nodown");
    ha.nextServiceStatus = 500;
    expect((await exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, k)).outcome).toBe("UNKNOWN");
    const weak = await exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, k, { ...owner, auth_strength: "active" });
    expect(weak).toMatchObject({ outcome: "UNKNOWN", replayed: true });
    expect(weak.action.status).toBe("outcome_unknown");
    expect((await h.journal.findByKey(TENANT, "home", k))?.status).toBe("outcome_unknown");
  });

  it("nøkkelkollisjon: en nøkkel som allerede er brukt av en ANNEN handling i ToolGateway-ledgeren gir FAILED (aldri en annen handlings «deduplisert» resultat)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "unlocked" });
    ha.set("cover.garage", { state: "closed" });
    const k = key("j-coll");
    expect((await run(h, "critical_cover", { entity: "cover.garage", target: "open" }, k)).ok).toBe(true);
    const result = await exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, k);
    expect(result).toMatchObject({ outcome: "FAILED", reason: "personal_action_idempotency_key_collision" });
    expect(ha.serviceCalls().filter((r) => r.path.includes("/lock/"))).toHaveLength(0);
  });

  it("inngangsvalidering: ukjent handling/domene, ugyldig nøkkel, manglende mål, og lesehandlingen kan ikke utføres som en mutasjon", async () => {
    const h = harness();
    await expect(exec(h, "critical_nuke", { entity: "lock.a" }, key("x"))).rejects.toThrow("personal_action_unknown_action");
    await expect(exec(h, HOME_CRITICAL_READ_ACTION, { entity: "lock.front_door" }, key("x"))).rejects.toThrow("personal_action_unknown_action");
    await expect(executePersonalAction(h.executor, owner, { domain: "car", action: "critical_lock", parameters: {}, idempotency_key: key("x") })).rejects.toThrow("personal_action_unknown_action");
    await expect(exec(h, "critical_lock", { entity: "lock.front_door", locked: true }, "kort")).rejects.toThrow("personal_action_idempotency_key_invalid");
    await expect(exec(h, "critical_lock", { locked: true }, key("x"))).rejects.toThrow("personal_action_target_missing");
  });

  it("list: filtrert på domene/status/mål, nyeste først, begrenset", async () => {
    const h = harness();
    const rows = await h.journal.list(TENANT, "home", { domain: "home", limit: 500 });
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.tenant_id === TENANT && r.domain === "home")).toBe(true);
    const times = rows.map((r) => Date.parse(r.requested_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await h.journal.list(TENANT, "home", { status: "outcome_unknown" })).every((r) => r.status === "outcome_unknown")).toBe(true);
    expect((await h.journal.list(TENANT, "home", { target_ref: "lock.front_door", limit: 2 })).length).toBeLessThanOrEqual(2);
  });
});

describe("G: journalen er uforanderlig, tenant-/rom-isolert og merket (DB-vakter)", () => {
  it("kjernekolonner kan ikke endres, terminale statuser endres ikke, ugyldig overgang avvises (trigger)", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "locked" });
    const r = await executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: key("imm") });
    const id = r.action.action_id;
    for (const sql of [
      "UPDATE personal_action_journal SET target_ref = 'lock.x' WHERE action_id = $1", "UPDATE personal_action_journal SET request_digest = repeat('a', 64) WHERE action_id = $1",
      "UPDATE personal_action_journal SET actor_person_id = 'person-g2-delegate' WHERE action_id = $1", "UPDATE personal_action_journal SET status = 'failed' WHERE action_id = $1",
      "UPDATE personal_action_journal SET after_state = '{}'::jsonb WHERE action_id = $1", "UPDATE personal_action_journal SET risk_direction = 'reduces' WHERE action_id = $1"
    ]) await expect(adminPool.query(sql, [id]), sql).rejects.toThrow(/personal_action_journal_(immutable_column|terminal_status)/);
  });

  it("actor må være MEDLEM av tenanten (sammensatt FK), og ugyldige verdier avvises av CHECK", async () => {
    await expect(adminPool.query(
      `INSERT INTO personal_action_journal (action_id, tenant_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, actor_person_id, source)
       VALUES ('x1', '${TENANT}', 'home', 'home-assistant', 'critical_lock', 'D', 'reduces', 'lock.a', 'idem-key-12345', repeat('a', 64), 'person-g2-other', 'owner_route')`
    )).rejects.toThrow(/foreign key|violates/i);
    await expect(adminPool.query(
      `INSERT INTO personal_action_journal (action_id, tenant_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, actor_person_id, source)
       VALUES ('x2', '${TENANT}', 'garage', 'home-assistant', 'critical_lock', 'D', 'reduces', 'lock.a', 'idem-key-12346', repeat('a', 64), 'person-g2-owner', 'owner_route')`
    )).rejects.toThrow(/check/i);
  });

  it("RLS: en annen tenant og et annet memory space ser ikke radene; riktig kontekst ser dem", async () => {
    const h = harness();
    ha.set("lock.front_door", { state: "locked" });
    const k = key("rls");
    await executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: k });
    expect(await h.journal.findByKey(TENANT, "home", k)).not.toBeNull();
    expect(await h.journal.findByKey(TENANT, "personal" as MemorySpace, k)).toBeNull(); // annet rom i samme tenant
    expect(await h.journal.findByKey(OTHER_TENANT, "home", k)).toBeNull(); // annen tenant
    expect((await h.journal.list(OTHER_TENANT, "home")).length).toBe(0);
    // Uten tenant-kontekst ser app-rollen ingenting (FORCE RLS).
    const client = await appPool.connect();
    try {
      expect((await client.query("SELECT count(*)::int AS n FROM personal_action_journal")).rows[0]).toEqual({ n: 0 });
    } finally { client.release(); }
  });
});
