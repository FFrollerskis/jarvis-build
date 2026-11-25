import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  CAR_CRITICAL_OPS, CAR_READ_ACTION, CarTransport, HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HomeAssistantCriticalTransport, PersonalActionJournal, RECONCILE_FAILED_MIN_AGE_MS, actionRequestDigest,
  carCriticalToolDefinitions, executePersonalAction, homeCriticalConfigFromEnv, homeCriticalToolDefinitions, parseCarTargets, personalActionIndex, reconcilePersonalAction,
  type PersonalActionExecutorDeps, type PersonalActionReconcileDeps, type SecretProvider, type ToolGateway
} from "../src/index.ts";
import { FakeCarAdapter } from "./support/fake-car-adapter.ts";
import { FakeHomeAssistant } from "./support/fake-home-assistant.ts";
import { G2_OTHER_TENANT, G2_TENANT, g2Owner, personalGateway, startPersonalDb, type PersonalDb, type PersonalGatewayHarness } from "./support/personal-db-harness.ts";

/**
 * WP-G2c (D-483, JARVIS-113 b, Q-73 pkt 10): avstemming av `outcome_unknown` gjennom EKTE embedded Postgres (migrasjon 144), ekte policy og ekte klasse D-kjede, mot fake Home Assistant og fake bil. Hver rad som avstemmes er en GENUIN
 * `outcome_unknown` laget av eksekutoren (kommando akseptert, men utstyret endret seg aldri / uleselig readback), ikke en håndlaget rad - unntatt der testen eksplisitt gjelder en ødelagt/uverifiserbar rad.
 *  A. `applied`: den ønskede sluttilstanden er bevist -> raden `applied`, ingen ny kommando (`serviceCalls` uendret), kun lese-handlingen kalt, revisjonsrad, replay med samme nøkkel gir lagret utfall.
 *  B. `failed`: bevist ikke utført (uendret `last_changed`/markør + frist) -> `failed`; ellers forblir raden `outcome_unknown` med tidspunkt/antall/begrunnelse, og et nytt forsøk avgjør når beviset finnes.
 *  C. ikke-påstander: nyere handling, handling i flukt (busy), lesing nektet (allowlist, kill switch), ødelagte/manglende parametre, ukjent/annen tenant/annet rom, `requested`, domene ikke slått på, ugyldig id.
 *  D. bil: kun `applied` er mulig; bufret/eldre observasjon bekrefter aldri.
 *  E. idempotens/samtidighet, og at avstemmingen ALDRI kaller skrive-verktøyet (kun `read_*`).
 */
let db: PersonalDb;
let ha: FakeHomeAssistant;
const fakeCar = new FakeCarAdapter();
beforeAll(async () => { db = await startPersonalDb("jarvis_test_g2c_reconcile"); ha = new FakeHomeAssistant(); await ha.start(); }, 240_000);
afterAll(async () => { await ha?.stop(); await db?.stop(); }, 120_000);
beforeEach(() => { ha.reset(); ha.clock = Date.now(); fakeCar.reset(); });

const owner: IdentityContext = { ...g2Owner, memory_space_id: "personal" };
let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : ref === "JARVIS_PERSONAL_CAR_CREDENTIAL" ? "fake-car-credential-for-test" : null) };
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (ms: number): string => iso(Date.now() - ms);
const HOUR = 3_600_000;
/** Reconcile-tiden: 10 min etter nå (fristen for `failed` er 5 min etter at eksekutoren konkluderte). */
const LATER = (): number => Date.now() + 2 * RECONCILE_FAILED_MIN_AGE_MS;

const TARGETS = "lock.front_door,cover.garage,alarm_control_panel.home,scene.evening,script.night,switch.heater";

interface Rig {
  h: PersonalGatewayHarness;
  journal: PersonalActionJournal;
  executor: PersonalActionExecutorDeps;
  /** Alle gateway-kall avstemmingen gjør (verktøy + handling). */
  gatewayCalls: Array<{ tool_id: string; action: string }>;
  reconcile: (action_id: string, id?: IdentityContext, now?: () => number) => ReturnType<typeof reconcilePersonalAction>;
  /** Eksekutor mot den ekte gatewayen (lager `outcome_unknown`-rader). */
  run: (action: string, parameters: Record<string, JsonValue>, k?: string, id?: IdentityContext) => ReturnType<typeof executePersonalAction>;
}

function homeRig(targets = TARGETS): Rig {
  const h = personalGateway(db.appPool, secrets);
  let t = 0;
  const config = homeCriticalConfigFromEnv({ JARVIS_PERSONAL_HOME_TARGETS: targets });
  const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 20_000, pollMs: 1_000, now: () => t, sleep: async (ms) => { t += ms; } });
  for (const d of homeCriticalToolDefinitions(transport, { ...config, settleMs: 20_000, pollMs: 1_000 })) h.gateway.register(d);
  const journal = new PersonalActionJournal(db.appPool);
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  const executor: PersonalActionExecutorDeps = { pool: db.appPool, gateway: h.gateway, journal, index };
  const gatewayCalls: Rig["gatewayCalls"] = [];
  const spy = { get: (toolId: string, action: string) => h.gateway.get(toolId, action), execute: async (req: Parameters<ToolGateway["execute"]>[0]) => { gatewayCalls.push({ tool_id: req.tool_id, action: req.action }); return h.gateway.execute(req); } } as Pick<ToolGateway, "execute" | "get">;
  const deps = (now: () => number): PersonalActionReconcileDeps => ({ executor: { ...executor, gateway: spy }, domains: new Map([["home", { toolId: "home-assistant", readAction: HOME_CRITICAL_READ_ACTION }]]), now });
  return {
    h, journal, executor, gatewayCalls,
    reconcile: (id, who = owner, now = LATER) => reconcilePersonalAction(deps(now), who, { action_id: id }),
    run: (action, parameters, k = key("r"), who = owner) => executePersonalAction(executor, who, { domain: "home", action, parameters, idempotency_key: k })
  };
}

function carRig(): Rig {
  const h = personalGateway(db.appPool, secrets);
  let t = 0;
  const transport = new CarTransport({ adapter: fakeCar, settleMs: 10_000, pollMs: 1_000, now: () => t, sleep: async (ms) => { t += ms; } });
  for (const d of carCriticalToolDefinitions(transport, { targets: parseCarTargets("bil,elbil"), settleMs: 10_000, pollMs: 1_000 })) h.gateway.register(d);
  const journal = new PersonalActionJournal(db.appPool);
  const index = personalActionIndex(CAR_CRITICAL_OPS.map((op) => ({ domain: "car" as const, toolId: "car", op })));
  const executor: PersonalActionExecutorDeps = { pool: db.appPool, gateway: h.gateway, journal, index };
  const gatewayCalls: Rig["gatewayCalls"] = [];
  const spy = { get: (toolId: string, action: string) => h.gateway.get(toolId, action), execute: async (req: Parameters<ToolGateway["execute"]>[0]) => { gatewayCalls.push({ tool_id: req.tool_id, action: req.action }); return h.gateway.execute(req); } } as Pick<ToolGateway, "execute" | "get">;
  const deps = (now: () => number): PersonalActionReconcileDeps => ({ executor: { ...executor, gateway: spy }, domains: new Map([["car", { toolId: "car", readAction: CAR_READ_ACTION }]]), now });
  return {
    h, journal, executor, gatewayCalls,
    reconcile: (id, who = owner, now = LATER) => reconcilePersonalAction(deps(now), who, { action_id: id }),
    run: (action, parameters, k = key("c"), who = owner) => executePersonalAction(executor, who, { domain: "car", action, parameters, idempotency_key: k })
  };
}

const LOCK = { entity: "lock.front_door", locked: true } as Record<string, JsonValue>;

/** En GENUIN `outcome_unknown`: kommandoen er akseptert, men låsen endret seg aldri (`ineffective`) -> readback viser feil sluttilstand (MISMATCH). Verdens tilstand etterpå styres av testen. */
async function unknownLock(rig: Rig, lastChanged: string | null = ago(2 * HOUR)): Promise<string> {
  ha.set("lock.front_door", { state: "unlocked", mode: "ineffective", ...(lastChanged === null ? {} : { last_changed: lastChanged }) });
  const result = await rig.run("critical_lock", LOCK);
  expect(result).toMatchObject({ outcome: "MISMATCH", action: { status: "outcome_unknown", failure_code: "postcondition_mismatch", reconcile_attempts: 0, reconciled_at: null, request_params: LOCK } });
  return result.action.action_id;
}

const audits = async (type = "personal.action_reconciled"): Promise<Array<{ payload: Record<string, unknown>; reason: string | null; decision: string | null; tool_id: string | null; action: string | null }>> =>
  (await db.adminPool.query("SELECT payload, reason, decision, tool_id, action FROM audit_events WHERE tenant_id = $1 AND type = $2 ORDER BY audit_id", [G2_TENANT, type])).rows as never;
const readOnly = (rig: Rig): void => { for (const c of rig.gatewayCalls) expect(c, JSON.stringify(c)).toEqual({ tool_id: "home-assistant", action: HOME_CRITICAL_READ_ACTION }); };

describe("A: applied - den ønskede sluttilstanden er bevist av en ny lesing", () => {
  it("låsen står nå `locked` (en annen kommando/et menneske): raden blir `applied` (failure_code tømt, opprinnelig after_state urørt), INGEN ny kommando sendes, kun lese-handlingen kalles, og revisjonen er skrevet uten innhold", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    const postsBefore = ha.serviceCalls().length;
    expect(postsBefore).toBe(1);
    ha.set("lock.front_door", { state: "locked", last_changed: ago(60_000) });

    const out = await rig.reconcile(id);
    expect(out).toMatchObject({ resolution: "applied", basis: "postcondition_observed", replayed: false, observed: { state: "locked", settled: true, usable: true } });
    expect(out.action).toMatchObject({ status: "applied", failure_code: null, reconcile_attempts: 1, reconcile_basis: "postcondition_observed" });
    expect(out.action.reconciled_at).not.toBeNull();
    expect(out.action.reconciled_state).toMatchObject({ state: "locked" });
    expect(out.action.after_state, "det opprinnelige beviset fra den gangen står uendret").toMatchObject({ state: "unlocked" });
    expect(out.action.before_state).toMatchObject({ state: "unlocked" });
    expect(ha.serviceCalls(), "ALDRI en ny kommando").toHaveLength(postsBefore);
    expect(rig.gatewayCalls).toEqual([{ tool_id: "home-assistant", action: HOME_CRITICAL_READ_ACTION }]);
    const rows = (await audits()).filter((a) => a.payload["action_id"] === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "ALLOW", reason: "postcondition_observed", tool_id: "home-assistant", action: "critical_lock", payload: { result: "applied", basis: "postcondition_observed", attempts: 1, domain: "home", target_ref: "lock.front_door", source: "owner_route" } });
    expect(JSON.stringify(rows[0]).toLowerCase()).not.toMatch(/token|password|code|secret/);
  });

  it("en replay med SAMME idempotensnøkkel gir nå det lagrede utfallet `SUCCESS` uten å sende noe (avstemmingen er ikke en bakdør for retry - den gjør kun at nøkkelens svar blir sant)", async () => {
    const rig = homeRig();
    const k = key("replay");
    ha.set("lock.front_door", { state: "unlocked", mode: "ineffective", last_changed: ago(2 * HOUR) });
    const first = await rig.run("critical_lock", LOCK, k);
    expect(first.outcome).toBe("MISMATCH");
    ha.set("lock.front_door", { state: "locked", last_changed: ago(30_000) });
    await rig.reconcile(first.action.action_id);
    const postsBefore = ha.serviceCalls().length;
    const replay = await rig.run("critical_lock", LOCK, k);
    expect(replay).toMatchObject({ outcome: "SUCCESS", replayed: true, action: { status: "applied" } });
    expect(ha.serviceCalls()).toHaveLength(postsBefore);
  });

  it("scene: markøren har rykket frem siden forhåndsvisningen -> applied (marker_advanced); skript som fortsatt kjører men er startet -> applied", async () => {
    const rig = homeRig();
    const old = ago(3 * HOUR);
    ha.set("scene.evening", { state: old, mode: "ineffective" });
    const scene = await rig.run("critical_scene", { entity: "scene.evening", expected_last_activated: old });
    expect(scene.action.status).toBe("outcome_unknown");
    ha.set("scene.evening", { state: ago(120_000) });
    expect(await rig.reconcile(scene.action.action_id)).toMatchObject({ resolution: "applied", basis: "marker_advanced", action: { status: "applied" } });

    ha.set("script.night", { state: "off", attributes: { last_triggered: old }, mode: "ineffective" });
    const script = await rig.run("critical_script", { entity: "script.night", expected_last_triggered: old });
    expect(script.action.status).toBe("outcome_unknown");
    ha.set("script.night", { state: "on", attributes: { last_triggered: ago(30_000) } }); // kjører nå, markøren har rykket frem
    expect(await rig.reconcile(script.action.action_id)).toMatchObject({ resolution: "applied", basis: "marker_advanced" });
    readOnly(rig);
  });

  it("alarm: ønsket `armed_away` er nådd (etter å ha stått i `arming`) -> applied; en alarm som FORTSATT arming (utgangsforsinkelse) er ikke en sluttilstand -> forblir ukjent", async () => {
    const rig = homeRig();
    ha.set("alarm_control_panel.home", { state: "disarmed", mode: "ineffective", last_changed: ago(2 * HOUR) });
    const r = await rig.run("critical_alarm", { entity: "alarm_control_panel.home", armed: true, mode: "away" });
    expect(r.action.status).toBe("outcome_unknown");
    ha.set("alarm_control_panel.home", { state: "arming", last_changed: ago(5_000) });
    expect(await rig.reconcile(r.action.action_id)).toMatchObject({ resolution: "unknown", basis: "observed_in_transition", action: { status: "outcome_unknown", reconcile_attempts: 1 } });
    ha.set("alarm_control_panel.home", { state: "armed_away", last_changed: ago(1_000) });
    expect(await rig.reconcile(r.action.action_id)).toMatchObject({ resolution: "applied", action: { status: "applied", reconcile_attempts: 2 } });
  });
});

describe("B: failed - kun bevist; ellers forblir raden ukjent (med tidspunkt, antall og begrunnelse), og et nytt forsøk avgjør", () => {
  it("låsen er UENDRET (`last_changed` eldre enn forespørselen) og ikke ønsket, fristen er passert: raden blir `failed` (reconciled_not_executed); en replay gir lagret FAILED; en ny avstemming er `already_terminal` uten å lese eller skrive", async () => {
    const rig = homeRig();
    const k = key("failed");
    ha.set("lock.front_door", { state: "unlocked", mode: "ineffective", last_changed: ago(2 * HOUR) });
    const first = await rig.run("critical_lock", LOCK, k);
    const id = first.action.action_id;
    const out = await rig.reconcile(id);
    expect(out).toMatchObject({ resolution: "failed", basis: "no_state_change_since_request", replayed: false });
    expect(out.action).toMatchObject({ status: "failed", failure_code: "reconciled_not_executed", reconcile_attempts: 1, reconcile_basis: "no_state_change_since_request" });
    expect(out.action.completed_at).not.toBeNull();
    expect(ha.serviceCalls()).toHaveLength(1);

    const callsAfterFirst = rig.gatewayCalls.length;
    const auditsAfterFirst = (await audits()).length;
    const again = await rig.reconcile(id);
    expect(again).toMatchObject({ resolution: "already_terminal", replayed: true, observed: null, action: { status: "failed", reconcile_attempts: 1 } });
    expect(rig.gatewayCalls, "en terminal rad leses ikke på nytt").toHaveLength(callsAfterFirst);
    expect(await audits(), "og skriver ingen ny revisjonsrad").toHaveLength(auditsAfterFirst);

    const replay = await rig.run("critical_lock", LOCK, k);
    expect(replay).toMatchObject({ outcome: "FAILED", replayed: true });
    expect(ha.serviceCalls()).toHaveLength(1);
  });

  it("FOR TIDLIG (under 5 min etter at eksekutoren konkluderte): ukjent med `too_recent_for_failed_proof`; samme bevis 5 min senere gir `failed`", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    const concluded = (await rig.journal.findById(G2_TENANT, "personal", id))?.completed_at;
    expect(concluded).toBeTruthy();
    const early = await rig.reconcile(id, owner, () => Date.now() + 60_000);
    expect(early).toMatchObject({ resolution: "unknown", basis: "too_recent_for_failed_proof", action: { status: "outcome_unknown", reconcile_attempts: 1, reconcile_basis: "too_recent_for_failed_proof" } });
    expect(early.action.completed_at, "et forsøk som ikke avgjør raden endrer ikke tidspunktet eksekutoren konkluderte (fristen for `failed` regnes fra det)").toEqual(concluded);
    expect(early.action.reconciled_at, "tidspunktet for forsøket er lagret").not.toBeNull();
    expect(early.action.reconciled_state).toMatchObject({ state: "unlocked" });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "failed", action: { status: "failed", reconcile_attempts: 2 } });
  });

  it("låsen er `jammed` (kommandoen KAN ha kjørt motoren; `last_changed` er etter forespørselen): aldri failed - forblir `outcome_unknown` (state_changed_since_request)", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    ha.set("lock.front_door", { state: "jammed", last_changed: iso(Date.now() + 5_000) });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "state_changed_since_request", action: { status: "outcome_unknown", failure_code: "postcondition_mismatch" } });
  });

  it("utstyret gir ikke endringstidspunkt: ingen bevisbar failed (change_time_unavailable), og raden står; utilgjengelig utstyr -> observed_unusable; et nytt forsøk når utstyret er tilbake avgjør", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig, null);
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "change_time_unavailable" });
    ha.set("lock.front_door", { state: "unavailable" });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "observed_unusable", action: { reconcile_attempts: 2 } });
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(3 * HOUR) });
    const decided = await rig.reconcile(id);
    expect(decided).toMatchObject({ resolution: "failed", action: { status: "failed", reconcile_attempts: 3 } });
    expect((await audits()).filter((a) => a.payload["action_id"] === id).map((a) => a.payload["result"])).toEqual(["outcome_unknown", "outcome_unknown", "failed"]);
  });

  it("scene: markøren er uendret siden forhåndsvisningen -> failed (marker_unchanged_since_preflight)", async () => {
    const rig = homeRig();
    const old = ago(3 * HOUR);
    ha.set("scene.evening", { state: old, mode: "ineffective" });
    const r = await rig.run("critical_scene", { entity: "scene.evening", expected_last_activated: old });
    expect(await rig.reconcile(r.action.action_id)).toMatchObject({ resolution: "failed", basis: "marker_unchanged_since_preflight", action: { status: "failed", failure_code: "reconciled_not_executed" } });
    readOnly(rig);
  });
});

describe("C: det avstemmingen IKKE påstår", () => {
  it("en NYERE handling mot samme mål kan ha forårsaket tilstanden: raden forblir ukjent (later_action_on_target) selv om ønsket tilstand er observert; en nyere FEILET handling endrer ingenting og hindrer ikke applied", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(2 * HOUR) });
    ha.nextServiceStatus = 400; // en nyere handling som HA avviser: `failed`, endret ingenting
    expect((await rig.run("critical_lock", LOCK)).outcome).toBe("FAILED");
    ha.set("lock.front_door", { state: "locked", last_changed: ago(30_000) });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "applied" });

    const id2 = await unknownLock(rig);
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(2 * HOUR) });
    expect((await rig.run("critical_lock", LOCK)).action.status, "nyere handling som faktisk virket (applied)").toBe("applied");
    ha.set("lock.front_door", { state: "locked", last_changed: ago(10_000) });
    expect(await rig.reconcile(id2)).toMatchObject({ resolution: "unknown", basis: "later_action_on_target", action: { status: "outcome_unknown" } });
  });

  it("en handling i flukt mot SAMME mål (prosess-lokal lås): `personal_action_target_busy`, ingenting leses eller skrives; etter at den er ferdig fungerer avstemmingen igjen", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(2 * HOUR) });
    ha.holdServices = true;
    const inFlight = rig.run("critical_lock", LOCK);
    for (let i = 0; i < 400 && ha.heldCount() < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ha.heldCount()).toBe(1);
    await expect(rig.reconcile(id)).rejects.toThrow("personal_action_target_busy");
    expect(rig.gatewayCalls, "ingen lesing mens målet er opptatt").toEqual([]);
    expect((await rig.journal.findById(G2_TENANT, "personal", id))).toMatchObject({ reconcile_attempts: 0, status: "outcome_unknown" });
    ha.releaseHeld();
    await inFlight;
    expect(await rig.reconcile(id)).toMatchObject({ action: { reconcile_attempts: 1 } });
  });

  it("lesingen går gjennom gatewayen: et mål som ikke lenger står i eierens allowlist, og en aktiv kill switch, gir `read_failed:*` - raden forblir ukjent og telles", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    const gets = (): number => ha.requests.filter((r) => r.method === "GET").length;
    const getsBefore = gets();
    const narrowed = homeRig("cover.garage"); // eieren har fjernet låsen fra listen
    const denied = await narrowed.reconcile(id);
    expect(denied).toMatchObject({ resolution: "unknown", basis: "read_failed:home_target_not_authorized", observed: null, action: { status: "outcome_unknown", reconcile_attempts: 1 } });
    rig.h.killSwitch.activate("test");
    const killed = await rig.reconcile(id);
    rig.h.killSwitch.deactivate();
    expect(killed).toMatchObject({ resolution: "unknown", action: { reconcile_attempts: 2 } });
    expect(killed.basis).toMatch(/^read_failed:/);
    expect(gets(), "ingen lesing nådde HA under allowlist-/kill switch-avslag").toBe(getsBefore);
  });

  it("en rad uten lagrede parametre, med parametre som ikke stemmer med digesten, eller som peker på et annet mål: ukjent (request_params_*), ingenting leses", async () => {
    const rig = homeRig();
    const insert = async (name: string, params: Record<string, JsonValue> | null, digestOf: Record<string, JsonValue>, target = "lock.front_door"): Promise<string> => {
      const id = `pers-act-${name}`;
      await db.adminPool.query(
        `INSERT INTO personal_action_journal (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, request_params)
         VALUES ($1, $2, 'personal', 'home', 'home-assistant', 'critical_lock', 'D', 'reduces', $3, $4, $5, 'outcome_unknown', 'person-g2-p-owner', 'owner_route', $6::jsonb)`,
        [id, G2_TENANT, target, `manual-${name}-key`, actionRequestDigest("home", "critical_lock", digestOf), params === null ? null : JSON.stringify(params)]
      );
      return id;
    };
    const missing = await insert("00000000-0000-0000-0000-000000000001", null, LOCK);
    const tampered = await insert("00000000-0000-0000-0000-000000000002", { entity: "lock.front_door", locked: false }, LOCK); // lagrede parametre er IKKE det digesten dekker
    const otherTarget = await insert("00000000-0000-0000-0000-000000000003", { entity: "lock.back_door", locked: true }, { entity: "lock.back_door", locked: true });
    expect(await rig.reconcile(missing)).toMatchObject({ resolution: "unknown", basis: "request_params_missing" });
    expect(await rig.reconcile(tampered)).toMatchObject({ resolution: "unknown", basis: "request_params_unverifiable" });
    expect(await rig.reconcile(otherTarget)).toMatchObject({ resolution: "unknown", basis: "request_params_unverifiable" });
    expect(rig.gatewayCalls).toEqual([]);
    ha.set("lock.front_door", { state: "locked", last_changed: ago(60_000) });
    expect(await rig.reconcile(missing), "selv om målet står låst blir en rad uten verifiserbar forespørsel aldri applied").toMatchObject({ resolution: "unknown", basis: "request_params_missing", action: { status: "outcome_unknown", reconcile_attempts: 2 } });
  });

  it("feil forhold avvises med en bevisst feilkode UTEN å røre noe: ugyldig id, ukjent id, annen tenant og annet memory space (RLS gir «finnes ikke»), `requested`-rad, domene som ikke er slått på", async () => {
    const rig = homeRig();
    const base = (id: string, over: Record<string, string>): Promise<unknown> => db.adminPool.query(
      `INSERT INTO personal_action_journal (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, request_params)
       VALUES ($1, $2, $3, $4, $5, $6, 'D', 'reduces', $7, $8, $9, $10, $11, 'owner_route', $12::jsonb)`,
      [id, over["tenant"], over["space"], over["domain"], over["tool"], over["action"], over["target"], `k-${id}`, actionRequestDigest(over["domain"]!, over["action"]!, LOCK), over["status"], over["actor"], JSON.stringify(LOCK)]
    );
    const row = { tenant: G2_TENANT, space: "personal", domain: "home", tool: "home-assistant", action: "critical_lock", target: "lock.front_door", status: "outcome_unknown", actor: "person-g2-p-owner" };
    await base("pers-act-aaaaaaaa-0000-0000-0000-000000000001", { ...row, tenant: G2_OTHER_TENANT, actor: "person-g2-p-other" });
    await base("pers-act-aaaaaaaa-0000-0000-0000-000000000002", { ...row, space: "home" });
    await base("pers-act-aaaaaaaa-0000-0000-0000-000000000003", { ...row, status: "requested" });
    await base("pers-act-aaaaaaaa-0000-0000-0000-000000000004", { ...row, domain: "car", tool: "car", action: "lock", target: "bil" });
    for (const bad of ["", "nope", "pers-act-", "pers-act-AAAAAAAA-0000-0000-0000-000000000001", "pers-act-aaaaaaaa-0000-0000-0000-00000000000g", `pers-act-aaaaaaaa-0000-0000-0000-000000000001' OR 1=1 --`]) {
      await expect(rig.reconcile(bad), JSON.stringify(bad)).rejects.toThrow("personal_action_reconcile_id_invalid");
    }
    await expect(rig.reconcile("pers-act-ffffffff-0000-0000-0000-000000000000")).rejects.toThrow("personal_action_not_found");
    await expect(rig.reconcile("pers-act-aaaaaaaa-0000-0000-0000-000000000001"), "annen tenant").rejects.toThrow("personal_action_not_found");
    await expect(rig.reconcile("pers-act-aaaaaaaa-0000-0000-0000-000000000002"), "annet memory space").rejects.toThrow("personal_action_not_found");
    await expect(rig.reconcile("pers-act-aaaaaaaa-0000-0000-0000-000000000003")).rejects.toThrow("personal_action_not_reconcilable");
    await expect(rig.reconcile("pers-act-aaaaaaaa-0000-0000-0000-000000000004")).rejects.toThrow("personal_action_domain_not_enabled");
    expect(rig.gatewayCalls).toEqual([]);
    const untouched = (await db.adminPool.query("SELECT action_id, reconcile_attempts, status FROM personal_action_journal WHERE action_id LIKE 'pers-act-aaaaaaaa-%' ORDER BY action_id")).rows as Array<{ reconcile_attempts: number; status: string }>;
    expect(untouched.map((r) => r.reconcile_attempts)).toEqual([0, 0, 0, 0]);
    expect((await audits()).filter((a) => String(a.payload["action_id"]).startsWith("pers-act-aaaaaaaa-"))).toEqual([]);
  });
});

describe("C3: grensetilfeller rundt lesingen og journalen", () => {
  const insertManual = async (name: string, over: { tool?: string; status?: string } = {}): Promise<string> => {
    const id = `pers-act-${name}`;
    await db.adminPool.query(
      `INSERT INTO personal_action_journal (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, request_params)
       VALUES ($1, $2, 'personal', 'home', $3, 'critical_lock', 'D', 'reduces', 'lock.front_door', $4, $5, $6, 'person-g2-p-owner', 'owner_route', $7::jsonb)`,
      [id, G2_TENANT, over.tool ?? "home-assistant", `manual-${name}-key`, actionRequestDigest("home", "critical_lock", LOCK), over.status ?? "outcome_unknown", JSON.stringify(LOCK)]
    );
    return id;
  };

  it("målet finnes ikke lenger hos HA (404): ukjent `target_not_found` - aldri applied/failed - og forsøket telles", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    ha.entities.delete("lock.front_door");
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "target_not_found", observed: null, action: { status: "outcome_unknown", reconcile_attempts: 1, reconciled_state: null } });
  });

  it("verktøy som ikke samsvarer: en rad hvis verktøy-id ikke er indeksens, eller en gateway uten lese-handlingen, gir `personal_action_domain_not_enabled` (ingenting leses, ingenting skrives)", async () => {
    const rig = homeRig();
    const foreignTool = await insertManual("00000000-0000-0000-0000-0000000000a1", { tool: "other-tool" });
    await expect(rig.reconcile(foreignTool)).rejects.toThrow("personal_action_domain_not_enabled");
    const id = await unknownLock(rig);
    const withoutRead = reconcilePersonalAction(
      { executor: { ...rig.executor, gateway: { get: () => undefined, execute: async () => { throw new Error("skal aldri kalles"); } } as never }, domains: new Map([["home", { toolId: "home-assistant", readAction: HOME_CRITICAL_READ_ACTION }]]) },
      owner, { action_id: id }
    );
    await expect(withoutRead).rejects.toThrow("personal_action_domain_not_enabled");
    expect(rig.gatewayCalls).toEqual([]);
    expect(await rig.journal.findById(G2_TENANT, "personal", id)).toMatchObject({ reconcile_attempts: 0 });
  });

  it("journal.recordReconcile er BETINGET på `outcome_unknown`: en terminal eller `requested` rad returneres uendret (`updated: false`) uten revisjon og uten databaseunntak (en samtidig avgjørelse vinner); ukjent id kaster", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    await rig.reconcile(id); // -> failed (terminal)
    const requested = await insertManual("00000000-0000-0000-0000-0000000000a2", { status: "requested" });
    const auditCount = (await audits()).length;
    const terminalBefore = await rig.journal.findById(G2_TENANT, "personal", id);
    const requestedBefore = await rig.journal.findById(G2_TENANT, "personal", requested);
    for (const status of ["applied", "failed", "outcome_unknown"] as const) {
      const onTerminal = await rig.journal.recordReconcile(owner, "personal", id, { status, basis: "forsok_paa_terminal", observed: { state: "locked" } });
      expect(onTerminal, status).toEqual({ row: terminalBefore, updated: false });
      const onRequested = await rig.journal.recordReconcile(owner, "personal", requested, { status, basis: "forsok_paa_requested", observed: null });
      expect(onRequested, status).toEqual({ row: requestedBefore, updated: false });
    }
    expect(await audits(), "ingen revisjonsrad for en endring som ikke skjedde").toHaveLength(auditCount);
    await expect(rig.journal.recordReconcile(owner, "personal", "pers-act-ffffffff-0000-0000-0000-0000000000ff", { status: "applied", basis: "x_y", observed: null })).rejects.toThrow("personal_action_not_found");
  });
});

describe("C2: hva som lagres i journalen", () => {
  it("`request_params` lagres KUN for parametre som består handlingens strenge skjema (aldri rå klient-JSON): et ukjent felt (her en kode-lignende nøkkel) eller feil type lagres aldri, raden blir `failed` og kan ikke avstemmes", async () => {
    const rig = homeRig();
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(2 * HOUR) });
    for (const params of [{ entity: "lock.front_door", locked: true, code: "1234-fiktiv" }, { entity: "lock.front_door", locked: "ja" }, { entity: "lock.front_door" }] as Array<Record<string, JsonValue>>) {
      const r = await rig.run("critical_lock", params);
      expect(r, JSON.stringify(params)).toMatchObject({ outcome: "FAILED", action: { status: "failed", request_params: null } });
      const stored = await rig.journal.findById(G2_TENANT, "personal", r.action.action_id);
      expect(JSON.stringify(stored)).not.toContain("1234-fiktiv");
      expect(await rig.reconcile(r.action.action_id)).toMatchObject({ resolution: "already_terminal", replayed: true });
    }
    expect(ha.serviceCalls()).toHaveLength(0);
  });

  it("gyldige parametre lagres uendret (også for bil), og digesten regnet på de lagrede parameterne er radens digest (bevis for at ingenting er endret)", async () => {
    const rig = homeRig();
    ha.set("lock.front_door", { state: "unlocked", last_changed: ago(2 * HOUR) });
    const r = await rig.run("critical_lock", { entity: "lock.front_door", locked: true, expected_state: "unlocked" });
    expect(r.action.request_params).toEqual({ entity: "lock.front_door", locked: true, expected_state: "unlocked" });
    expect(actionRequestDigest("home", "critical_lock", r.action.request_params as Record<string, JsonValue>)).toBe(r.action.request_digest);
    const car = carRig();
    fakeCar.set("bil", { lock: "unlocked", climate: "off", charging: "stopped" });
    const c = await car.run("lock", { vehicle_id: "bil" });
    expect(c.action).toMatchObject({ domain: "car", request_params: { vehicle_id: "bil" } });
    expect(actionRequestDigest("car", "lock", c.action.request_params as Record<string, JsonValue>)).toBe(c.action.request_digest);
  });
});

describe("D: bil - kun applied er mulig, og en bufret/eldre observasjon bekrefter aldri noe", () => {
  /** Bil: kommandoen er akseptert, men bilen utfører den aldri (`ineffective`) -> readback viser feil sluttilstand -> `outcome_unknown`. */
  async function unknownCarLock(rig: Rig): Promise<string> {
    fakeCar.set("bil", { lock: "unlocked", climate: "off", charging: "stopped", mode: "ineffective" });
    const r = await rig.run("lock", { vehicle_id: "bil" });
    expect(r).toMatchObject({ outcome: "MISMATCH", action: { status: "outcome_unknown", domain: "car" } });
    return r.action.action_id;
  }

  it("bilen viser nå `locked` med en levende observasjon som ikke er eldre enn forespørselen: applied; ingen ny kommando; kun `read_vehicle_state` kalt", async () => {
    const rig = carRig();
    const id = await unknownCarLock(rig);
    const commands = fakeCar.commandCalls().length;
    fakeCar.set("bil", { lock: "locked", climate: "off", charging: "stopped", observed_at: iso(Date.now() + 1_000) });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "applied", basis: "postcondition_observed", action: { status: "applied", domain: "car", reconcile_attempts: 1 } });
    expect(fakeCar.commandCalls()).toHaveLength(commands);
    expect(rig.gatewayCalls).toEqual([{ tool_id: "car", action: CAR_READ_ACTION }]);
  });

  it("bufret («stale»), eldre enn forespørselen, uten tidsstempel eller feil tilstand: forblir ukjent - og bil blir ALDRI `failed`, uansett hvor gammel raden er", async () => {
    const rig = carRig();
    const id = await unknownCarLock(rig);
    fakeCar.set("bil", { lock: "locked", climate: "off", charging: "stopped", mode: "stale" });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "observed_not_fresh" });
    fakeCar.set("bil", { lock: "locked", climate: "off", charging: "stopped", observed_at: ago(HOUR / 2 - 60_000) }); // levende, men eldre enn forespørselen
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "observed_before_request" });
    fakeCar.set("bil", { lock: "locked", climate: "off", charging: "stopped", observed_at: null });
    expect(await rig.reconcile(id)).toMatchObject({ resolution: "unknown", basis: "observed_at_missing" });
    fakeCar.set("bil", { lock: "unlocked", climate: "off", charging: "stopped", observed_at: iso(Date.now() + 1_000) });
    expect(await rig.reconcile(id, owner, () => Date.now() + 365 * 24 * HOUR)).toMatchObject({ resolution: "unknown", basis: "not_executed_unprovable_for_car", action: { status: "outcome_unknown", reconcile_attempts: 4 } });
  });
});

describe("E: idempotens og samtidighet", () => {
  it("to samtidige avstemminger av SAMME rad: nøyaktig ett forsøk skrives (den andre får `target_busy` eller ser en allerede avgjort rad) - aldri to terminale skrivinger, aldri en feil fra databasen", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    const settled = await Promise.allSettled([rig.reconcile(id), rig.reconcile(id), rig.reconcile(id)]);
    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<Rig["reconcile"]>>> => s.status === "fulfilled");
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    for (const r of rejected) expect((r.reason as Error).message).toBe("personal_action_target_busy");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.filter((f) => f.value.replayed === false)).toHaveLength(1);
    const row = await rig.journal.findById(G2_TENANT, "personal", id);
    expect(row).toMatchObject({ status: "failed", reconcile_attempts: 1 });
    expect((await audits()).filter((a) => a.payload["action_id"] === id)).toHaveLength(1);
  });

  it("raden er den samme før og etter at avstemmingen er `already_terminal` (ingen skriving): `updated_at` og antall revisjonsrader er uendret", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    await rig.reconcile(id);
    const before = await rig.journal.findById(G2_TENANT, "personal", id);
    const auditCount = (await audits()).length;
    for (let i = 0; i < 3; i += 1) expect(await rig.reconcile(id)).toMatchObject({ resolution: "already_terminal", replayed: true });
    expect(await rig.journal.findById(G2_TENANT, "personal", id)).toEqual(before);
    expect(await audits()).toHaveLength(auditCount);
  });

  it("avstemmingen kaller ALDRI skrive-verktøyet: over alle forsøkene i denne filen er kun lese-handlingene brukt, og HA har aldri mottatt en kommando fra den", async () => {
    const rig = homeRig();
    const id = await unknownLock(rig);
    const commands = ha.serviceCalls().length;
    for (const state of [{ state: "unavailable" }, { state: "locking" }, { state: "locked", last_changed: ago(1_000) }]) { ha.set("lock.front_door", state); await rig.reconcile(id); }
    expect(ha.serviceCalls()).toHaveLength(commands);
    readOnly(rig);
    expect(rig.gatewayCalls.length).toBeGreaterThanOrEqual(2);
  });
});
