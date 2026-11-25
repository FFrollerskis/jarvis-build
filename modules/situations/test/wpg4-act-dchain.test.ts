import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { homeAssistantTools, homeCriticalToolDefinitions, parseHomeTargets, type ClassDNotification, type ClassDNotifier, type ToolTransport } from "@jarvis/tool-gateway";
import { autonomyActionBlocker, SituationActActionForbiddenError } from "../src/autonomy-guard.ts";
import { SimulationService, simulationToolInfoFrom } from "../src/simulation.ts";
import { detectSpendSpike, detectStaleJobs, mapSpendSpikeToCandidate, mapStaleJobToCandidate } from "../src/anomaly-detectors.ts";
import { openingDetectionKey } from "../src/home-bridge.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { identity, minutesAgo, NOW, OWNER, actorOwner, record, startG4Db, TENANT_A, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4 (D-466) P2e: «D-klasse-handlinger gir umiddelbart varsel + gjenopprettingskontekst» og «INFORM-kun for anomalier», bevist gjennom den EKTE `ToolGateway`/`PolicyGateway`/`SituationEngine` mot ekte Postgres:
 *  A: en situasjonsdrevet (autonom) klasse D-handling går gjennom klasse D-kjeden - umiddelbart varsel med gjenopprettingstekst, og uten en klar varsler utføres den ALDRI (situasjonen eskalerer).
 *  B: de ekte G2-hjemmehandlingene (klasse D, step-up) nektes for den autonome sveipe-identiteten (Q-55) - ingen kall til Home Assistant, ærlig årsak i revisjonssporet, situasjonen eskalerer.
 *  C: kandidatene fra de nye anomali-detektorene er INFORM-kun: de når aldri `suggest`, og et autonomt ACT-løp berører dem aldri, selv med en eier-binding for domenet.
 */
const DAY = 86_400_000;
const GATE_ROLLBACK = "åpne porten igjen via test_gate.open og bekreft readback (før-tilstanden står i varselet)";

class FakeNotifier implements ClassDNotifier {
  sent: ClassDNotification[] = [];
  constructor(private ready_ = true) {}
  ready(): boolean { return this.ready_; }
  async notify(n: ClassDNotification): Promise<void> { this.sent.push(n); }
}

class HaSpy implements ToolTransport {
  calls: string[] = [];
  async invoke(action: string): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push(action);
    return { data: {} };
  }
}

let db: G4Db;
let bus: SituationSignalBus;

beforeAll(async () => {
  db = await startG4Db("dchain");
  bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => NOW });
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => { await db.reset(); });

function buildGateway(notifier: ClassDNotifier) {
  const built = db.newGateway({ classDPipeline: { enforce: true, notifier } });
  // En FULLSTENDIG klasse D-handling (preflight med målkrav, etterbetingelse og gjenopprettingsplan). Ingen step-up: viser selve varslings-/gjenopprettingskjeden.
  built.gateway.register({
    tool_id: "test_gate", action: "close", description: "test", input_schema: record({ situation_id: z.string() }), capability_class: "D", scopes: [], reversible: true, rollback_procedure: GATE_ROLLBACK,
    idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_GATE_TOKEN", output_trust: "internal", transport: built.actuator,
    preflight_action: "read_state", preflight_requires_target: true, postcondition_predicate: (after) => (after as { done?: boolean } | null)?.done === true,
    autonomy_bindable: TEST_BINDABLE
  });
  return built;
}

/** En garasjeport som har stått åpen i 90 min: høy prioritet + konfidens 0,9 => stadiet `suggest` (den eneste veien til auto-ACT). */
async function seedGateSuggest(entity = "cover.garasje"): Promise<string> {
  await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: entity, role: "garage_door" }] } }, actorOwner);
  const out = await bus.publishBatch(TENANT_A, "home", [{ source: "home_assistant", entity_id: entity, role: "garage_door", state: "open", last_changed: minutesAgo(90) }]);
  expect(out.evaluated).toBe(1);
  const situation = await db.engine.findByDetectionKey(TENANT_A, "home", openingDetectionKey(entity, Date.parse(minutesAgo(90))));
  expect(situation!.stage).toBe("suggest");
  return situation!.situation_id;
}

const bind = (tool_id: string, action: string, parameters: Record<string, unknown>, domain = "home", space: "home" | "business" = "home") =>
  db.engine.setAutonomyPolicy(TENANT_A, space, { domain, tool_id, action, parameters } as never, OWNER);

const deniedAudit = async (toolId: string, action: string) =>
  (await db.adminPool.query(`SELECT reason FROM audit_events WHERE type = 'tool.denied' AND tenant_id = $1 AND tool_id = $2 AND action = $3 ORDER BY audit_id DESC`, [TENANT_A, toolId, action])).rows as Array<{ reason: string }>;

describe("A: autonom klasse D-handling går gjennom klasse D-kjeden (umiddelbart varsel + gjenopprettingskontekst)", () => {
  it("utført handling: varsleren får «executed» med gjenopprettingsteksten og målets referanse, i tillegg til motorens eget ACT+NOTIFY - og kun ÉN utførelse", async () => {
    const notifier = new FakeNotifier(true);
    const { gateway, telegram, actuator } = buildGateway(notifier);
    const situationId = await seedGateSuggest();
    await bind("test_gate", "close", { situation_id: "{{situation_id}}" });
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, denied: 0 });
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
    expect(actuator.calls.some((c) => c.action === "read_state")).toBe(true); // fersk tilstandslesing (preflight/readback)
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ tenant_id: TENANT_A, person_id: OWNER, tool_id: "test_gate", action: "close", outcome: "executed", recovery: GATE_ROLLBACK });
    expect(notifier.sent[0]!.idempotency_key.length).toBeGreaterThan(0);
    expect(telegram.messages.filter((m) => m.startsWith("Jarvis utførte en handling"))).toHaveLength(1);
    const after = await db.engine.findByDetectionKey(TENANT_A, "home", openingDetectionKey("cover.garasje", Date.parse(minutesAgo(90))));
    expect(after).toMatchObject({ situation_id: situationId, stage: "act_notify", act_result: "succeeded" });
    // et nytt løp gjør ingenting mer (idempotent: ingen ny utførelse, ingen nytt varsel)
    const again = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(again.attempted).toBe(0);
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("varsleren er ikke klar: handlingen utføres ALDRI (ingen stille handling uten umiddelbart varsel) og situasjonen eskalerer ærlig", async () => {
    const notifier = new FakeNotifier(false);
    const { gateway, actuator, telegram } = buildGateway(notifier);
    await seedGateSuggest();
    await bind("test_gate", "close", { situation_id: "{{situation_id}}" });
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, denied: 1 });
    expect(actuator.calls).toEqual([]);
    expect(notifier.sent).toEqual([]);
    expect(telegram.messages.some((m) => m.startsWith("Jarvis utførte en handling"))).toBe(false);
    const sit = await db.engine.findByDetectionKey(TENANT_A, "home", openingDetectionKey("cover.garasje", Date.parse(minutesAgo(90))));
    expect(sit).toMatchObject({ stage: "escalate", act_result: "denied" });
    expect((await deniedAudit("test_gate", "close")).map((r) => r.reason)).toContain("class_d_notifier_not_ready");
  });

  it("en klasse D-handling uten fullstendig kjede (mangler målvalidering) er utilgjengelig også for autonom ACT: ingen utførelse, ingen varsel", async () => {
    const notifier = new FakeNotifier(true);
    const { gateway, actuator } = buildGateway(notifier);
    await seedGateSuggest();
    // `test_actuator.close` (testharnessen) har preflight og etterbetingelse, men ingen målvalidering => ufullstendig kjede
    await bind("test_actuator", "close", { situation_id: "{{situation_id}}" });
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, denied: 1 });
    expect(actuator.calls).toEqual([]);
    expect(notifier.sent).toEqual([]);
    expect((await deniedAudit("test_actuator", "close")).map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/class_d_pipeline_incomplete/)]));
  });
});

describe("A2: bindingen re-verifiseres med LEVENDE parametre rett før hvert kall", () => {
  class ParamSpy implements ToolTransport {
    calls: Array<Record<string, JsonValue>> = [];
    /** Kjøres midt i det første kallet (simulerer at eieren endrer bindingen mens sveipet pågår; direkte mot databasen, siden en pågående ACT holder domenets advisory-lås). */
    onFirst: (() => Promise<void>) | undefined;
    async invoke(_action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
      this.calls.push(parameters);
      const hook = this.onFirst;
      this.onFirst = undefined;
      if (hook) await hook();
      return { external_id: `p-${this.calls.length}` };
    }
  }

  it("endrer eieren målet (parametrene) midt i løpet, får neste situasjon det SISTE valget - aldri øyeblikksbildet fra utvalget", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    const spy = new ParamSpy();
    gateway.register({
      tool_id: "test_param", action: "apply", description: "test", input_schema: record({ situation_id: z.string(), target: z.string() }), capability_class: "B", scopes: [], reversible: true,
      rollback_procedure: "angre via test_param", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_PARAM_TOKEN", output_trust: "internal", transport: spy, autonomy_bindable: TEST_BINDABLE
    });
    await seedGateSuggest("cover.garasje");
    await seedGateSuggest("cover.port");
    await bind("test_param", "apply", { situation_id: "{{situation_id}}", target: "A" });
    spy.onFirst = async () => {
      await db.adminPool.query(`UPDATE situation_autonomy_policies SET parameters = $2::jsonb WHERE tenant_id = $1`, [TENANT_A, JSON.stringify({ situation_id: "{{situation_id}}", target: "B" })]);
    };
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 2, succeeded: 2, denied: 0 });
    expect(spy.calls.map((c) => c["target"])).toEqual(["A", "B"]);
  });

  it("bytter eieren verktøy/handling midt i løpet, hoppes neste situasjon over (ingen ACT med et annet verktøy enn det som var valgt ved utvalget)", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    const spy = new ParamSpy();
    gateway.register({
      tool_id: "test_param", action: "apply", description: "test", input_schema: record({ situation_id: z.string(), target: z.string() }), capability_class: "B", scopes: [], reversible: true,
      rollback_procedure: "angre via test_param", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_PARAM_TOKEN", output_trust: "internal", transport: spy, autonomy_bindable: TEST_BINDABLE
    });
    await seedGateSuggest("cover.garasje");
    await seedGateSuggest("cover.port");
    await bind("test_param", "apply", { situation_id: "{{situation_id}}", target: "A" });
    spy.onFirst = async () => {
      await db.adminPool.query(`UPDATE situation_autonomy_policies SET tool_id = 'test_gate', action = 'close', parameters = $2::jsonb WHERE tenant_id = $1`, [TENANT_A, JSON.stringify({ situation_id: "{{situation_id}}" })]);
    };
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, skipped: 1 });
    expect(spy.calls).toHaveLength(1);
  });
});

describe("B: fysiske/kritiske handlinger (lås, alarm, lys, klima, bil, critical_*) kan aldri bindes til eller utføres av autonom ACT (A-HIGH-1)", () => {
  /** Et «hus»: lås og alarm med tilstand. `read_state` gir etter-/før-tilstanden; kommandoene endrer den (som i reviewens probe). */
  class House implements ToolTransport {
    locked = true;
    armed = true;
    calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
    async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
      this.calls.push({ action, parameters });
      if (action === "read_state") return { data: { locked: this.locked, armed: this.armed } };
      if (action === "lock_set") { this.locked = parameters["locked"] === true; return { external_id: "lock-1", data: { locked: this.locked } }; }
      if (action === "alarm_set") { this.armed = parameters["armed"] === true; return { external_id: "alarm-1", data: { armed: this.armed } }; }
      return { data: {} };
    }
  }
  /** Skriver en binding DIREKTE i databasen (som en binding fra før regelen): omgår bind-tids-sperren, så kjøre-tids-sperren er den som måles. */
  const bindRaw = (tool_id: string, action: string, parameters: Record<string, unknown>) =>
    db.adminPool.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id) VALUES ($1, 'home', 'home', $2, $3, $4::jsonb, true, $5)`,
      [TENANT_A, tool_id, action, JSON.stringify(parameters), OWNER]
    );
  const gateOpening = () => openingDetectionKey("cover.garasje", Date.parse(minutesAgo(90)));
  const PHYSICAL: Array<[string, string]> = [
    ["home-assistant", "lock_set"], ["home-assistant", "alarm_set"], ["home-assistant", "light_set"], ["home-assistant", "climate_set"],
    ["home-assistant", "critical_lock"], ["home-assistant", "critical_alarm"], ["home-assistant", "critical_cover"], ["home-assistant", "critical_valve"], ["home-assistant", "critical_switch"],
    ["home-assistant", "critical_scene"], ["home-assistant", "critical_script"], ["home-assistant", "critical_climate_mode"],
    ["car", "lock"], ["car", "unlock"], ["car", "climate_set"], ["car", "charge_set"],
    // allowlist-tankegang: en NY/ukjent handling i de fysiske navnerommene er fysisk til noen bevisst legger den på lese-listen
    ["home-assistant", "open_garage_v2"], ["car", "honk"]
  ];

  it("regelen er ren og fail-closed: kun kjente LESE-handlinger i `home-assistant`/`car` er bindbare; alt annet der (også ukjent/ugyldig) er fysisk; andre navnerom er uendret", () => {
    for (const [tool, action] of PHYSICAL) expect(autonomyActionBlocker(tool, action), `${tool}.${action}`).toEqual({ code: "physical_action_not_bindable", tool_id: tool, action });
    for (const read of ["list_states", "read_state", "read_state_detail", "read_states_detail", "read_critical_state"]) expect(autonomyActionBlocker("home-assistant", read), read).toBeNull();
    expect(autonomyActionBlocker("car", "read_vehicle_state")).toBeNull();
    for (const other of [["telegram", "notify"], ["test_gate", "close"], ["email", "send"], ["github", "merge_pr"], ["docker", "stop_container"]]) expect(autonomyActionBlocker(other[0], other[1]), other.join(".")).toBeNull();
    // ugyldig inndata er alltid nektet (aldri en stille «bindbar»)
    for (const bad of [[undefined, "x"], ["home-assistant", undefined], ["", "x"], ["x", ""], [null, null], [5, "x"]]) expect(autonomyActionBlocker(bad[0], bad[1]), String(bad)).not.toBeNull();
    // navnerommet er eksakt (ingen prefikstreff): `home-assistant-x` er et annet verktøy, og store/små bokstaver er et ANNET verktøy-id (registeret er eksakt)
    expect(autonomyActionBlocker("home-assistant-x", "lock_set")).toBeNull();
    expect(autonomyActionBlocker("Home-Assistant", "lock_set")).toBeNull();
  });

  it("bind-tid: ALLE fysiske/kritiske handlinger avvises med stabil årsakskode og ingenting lagres; lese-handlinger er ikke bindbare (default-deny) og andre navnerom kun når definisjonen sier det", async () => {
    for (const [tool, action] of PHYSICAL) {
      await expect(bind(tool, action, { entity: "x" }), `${tool}.${action}`).rejects.toMatchObject({ name: "SituationActActionForbiddenError", message: `situation_autonomy_action_forbidden:physical_action_not_bindable:${tool}.${action}` });
    }
    expect(await db.engine.listAutonomyPolicies(TENANT_A, "home")).toEqual([]);
    // WP-G4b K1 (D-484): navnerom-vakten slipper kun kjente lese-handlinger forbi (testet rent over), men bindbarhet er nå DEFAULT-DENY: en lesing er ikke en handling og ingen definisjon erklærer den bindbar.
    await expect(bind("home-assistant", "read_state", { entity: "lock.x" })).rejects.toMatchObject({ name: "SituationActActionForbiddenError", message: "situation_autonomy_action_forbidden:action_not_bindable:home-assistant.read_state" });
    expect(await db.engine.listAutonomyPolicies(TENANT_A, "home")).toEqual([]);
    // Et annet navnerom er bindbart KUN fordi definisjonen erklærer det (`test_actuator.close` i G4Db-gatewayen).
    await bind("test_actuator", "close", { situation_id: "{{situation_id}}" });
    expect((await db.engine.listAutonomyPolicies(TENANT_A, "home")).map((p) => `${p.tool_id}.${p.action}`)).toEqual(["test_actuator.close"]);
  });

  it("de GAMLE klasse D-verktøyene (lock_set/alarm_set) i ekte ToolGateway + klasse D-kjede + sveipens identitet: en binding fra før regelen utføres ALDRI (ingen claim, ingen kall, huset urørt)", async () => {
    for (const [action, params, state] of [
      ["lock_set", { site_id: "hjem", room_id: "inngang", entity: "lock.inngangsdor", locked: false }, (h: House) => h.locked],
      ["alarm_set", { site_id: "hjem", room_id: "inngang", armed: false }, (h: House) => h.armed]
    ] as const) {
      await db.reset();
      const notifier = new FakeNotifier(true);
      const { gateway, telegram } = buildGateway(notifier);
      const house = new House();
      for (const def of homeAssistantTools(house)) gateway.register(def);
      await seedGateSuggest();
      await bindRaw("home-assistant", action, params);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let result;
      let logged: string[] = [];
      try {
        result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
        await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home")); // et nytt løp gir ingen ny logglinje (én per binding og prosess)
        logged = errors.mock.calls.map((c) => String(c[0]));
      } finally {
        errors.mockRestore();
      }
      // den blokkerte bindingen er SYNLIG (én strukturert logglinje), ikke stille hoppet over
      const blockedLines = logged.filter((l) => l.includes("situation_auto_act_blocked"));
      expect(blockedLines, action).toHaveLength(1);
      expect(blockedLines[0], action).toContain(`"tool_id":"home-assistant","action":"${action}"`);
      expect(result, action).toEqual({ attempted: 0, succeeded: 0, denied: 0, skipped: 1 });
      expect(house.calls, action).toEqual([]); // verken preflight, kommando eller readback
      expect(state(house), action).toBe(true); // huset står som det var (låst/armert)
      expect(notifier.sent, action).toEqual([]);
      expect(telegram.messages.some((m) => m.startsWith("Jarvis utførte en handling")), action).toBe(false);
      const sit = await db.engine.findByDetectionKey(TENANT_A, "home", gateOpening());
      expect(sit, action).toMatchObject({ stage: "suggest", act_result: null, act_idempotency_key: null }); // ikke claimet: ingen skrivinger fra ACT-stien
      expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'home-assistant'`, [TENANT_A])).rows[0].n, action).toBe(0);
    }
  });

  it("actOn() direkte (uten autoActPending) nekter også FØR claim/lås/kall: stabil feilkode, ingen skrivinger", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    const house = new House();
    for (const def of homeAssistantTools(house)) gateway.register(def);
    await seedGateSuggest();
    const sit = (await db.engine.findByDetectionKey(TENANT_A, "home", gateOpening()))!;
    await expect(db.engine.actOn(TENANT_A, "home", sit.situation_id, { tool_id: "home-assistant", action: "lock_set", parameters: { site_id: "hjem", room_id: "inngang", entity: "lock.inngangsdor", locked: false } }, gateway, identity(TENANT_A, "home")))
      .rejects.toMatchObject({ name: "SituationActActionForbiddenError", code: "physical_action_not_bindable" });
    expect(house.calls).toEqual([]);
    expect(await db.engine.findByDetectionKey(TENANT_A, "home", gateOpening())).toMatchObject({ act_idempotency_key: null, act_result: null, stage: "suggest" });
  });

  it("G2-verktøyene (critical_*): bind-tid avviser dem, en binding fra før regelen hoppes over uten HA-kall, og selve gatewayen nekter sveipe-identiteten via step-up (forsvar i dybden)", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    const ha = new HaSpy();
    for (const def of homeCriticalToolDefinitions(ha, { targets: parseHomeTargets("cover.garasje"), settleMs: 20_000, pollMs: 1_000 })) gateway.register(def);
    await seedGateSuggest("cover.garasje");
    await expect(bind("home-assistant", "critical_cover", { entity: "cover.garasje", target: "closed" })).rejects.toBeInstanceOf(SituationActActionForbiddenError);
    await bindRaw("home-assistant", "critical_cover", { entity: "cover.garasje", target: "closed" });
    expect(await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"))).toMatchObject({ attempted: 0, skipped: 1 });
    expect(ha.calls).toEqual([]);
    // forsvar i dybden: selv direkte gjennom gatewayen nektes sveipe-identiteten (ikke signert enhetsøkt) før noe når Home Assistant
    const direct = await gateway.execute({ identity: identity(TENANT_A, "home"), tool_id: "home-assistant", action: "critical_cover", parameters: { entity: "cover.garasje", target: "closed" }, idempotency_key: "direct-1" });
    expect(direct).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect(ha.calls).toEqual([]);
    // mål utenfor eierens allowlist nektes av mål-autorisasjonen (uavhengig av regelen over)
    const other = await gateway.execute({ identity: identity(TENANT_A, "home"), tool_id: "home-assistant", action: "critical_cover", parameters: { entity: "cover.annen_port", target: "closed" }, idempotency_key: "direct-2" });
    expect(other).toMatchObject({ ok: false, reason: "home_target_not_authorized" });
  });

  it("simuleringen leser step-up fra verktøydefinisjonen (ikke klassen) og sier ærlig at en fysisk binding aldri utføres: legacy lock_set (klasse D uten step-up) gir `physical_action_not_bindable`, ikke `step_up_required`", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    for (const def of homeAssistantTools(new House())) gateway.register(def);
    gateway.register({
      tool_id: "test_stepup", action: "apply", description: "test", input_schema: record({ situation_id: z.string() }), capability_class: "D", scopes: [], reversible: true, rollback_procedure: "angre via test_stepup",
      idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_STEPUP_TOKEN", output_trust: "internal", transport: new HaSpy(), step_up_required: true, autonomy_bindable: TEST_BINDABLE
    });
    await seedGateSuggest();
    const sit = (await db.engine.findByDetectionKey(TENANT_A, "home", gateOpening()))!;
    const sim = new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW);
    await bindRaw("home-assistant", "lock_set", { locked: false });
    const physical = await sim.simulate(TENANT_A, "home", sit.situation_id);
    expect(physical.scenarios[0]!.blocked_by).toContain("physical_action_not_bindable");
    expect(physical.scenarios[0]!.blocked_by).not.toContain("step_up_required"); // lock_set har ikke step_up_required i definisjonen
    expect(physical.scenarios[0]!.requires_owner_approval).toBe(true);
    expect(physical.caveats.join(" ")).toMatch(/fysisk\/kritisk/);
    expect(physical.caveats.join(" ")).not.toMatch(/klasse D uten step-up/); // en blokkert fysisk binding «kan ikke utføres» - ingen villedende klasse D-påstand
    // en klasse D UTEN step-up (utenfor de fysiske navnerommene) er ikke nektet av step-up: simuleringen sier at den kan utføres autonomt
    await db.adminPool.query(`DELETE FROM situation_autonomy_policies`);
    await bind("test_gate", "close", { situation_id: "{{situation_id}}" });
    const classD = await sim.simulate(TENANT_A, "home", sit.situation_id);
    expect(classD.scenarios[0]!.blocked_by).toEqual([]);
    expect(classD.caveats.join(" ")).toMatch(/klasse D uten step-up/);
    // en definisjon MED step_up_required gir `step_up_required`
    await db.adminPool.query(`DELETE FROM situation_autonomy_policies`);
    await bind("test_stepup", "apply", { situation_id: "{{situation_id}}" });
    const stepUp = await sim.simulate(TENANT_A, "home", sit.situation_id);
    expect(stepUp.scenarios[0]!.blocked_by).toEqual(["step_up_required"]);
    expect(stepUp.scenarios[0]!.requires_owner_approval).toBe(true);
  });
});

describe("C: kandidater fra de nye anomali-detektorene er INFORM-kun og når aldri auto-ACT", () => {
  const spikeCandidate = () => {
    const amounts = Array.from({ length: 28 }, (_, i) => 10_000 + ((i % 5) - 2) * 400);
    const series = [...amounts, 60_000].map((amount, i, arr) => ({ day: new Date(NOW - (arr.length - i) * DAY).toISOString().slice(0, 10), amount }));
    return mapSpendSpikeToCandidate(detectSpendSpike(series, NOW)!, "ai_cost");
  };

  it("kostnadssprang: én situasjon (idempotent), stadium `inform`, ETT varsel (ingen spam), og et autonomt løp berører den ikke selv med eier-binding for `spend`", async () => {
    const { gateway, telegram, actuator } = buildGateway(new FakeNotifier(true));
    await bind("test_gate", "close", { situation_id: "{{situation_id}}" }, "spend", "business");
    const candidate = spikeCandidate();
    const first = await db.engine.evaluateCandidate(TENANT_A, "business", candidate, NOW);
    const second = await db.engine.evaluateCandidate(TENANT_A, "business", candidate, NOW + 60_000);
    expect(second.situation.situation_id).toBe(first.situation.situation_id);
    expect(first.situation).toMatchObject({ domain: "spend", stage: "inform", priority: "high" });
    expect(first.situation.confidence).toBeNull();
    const auto = await db.engine.autoActPending(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(auto.attempted).toBe(0);
    expect(actuator.calls).toEqual([]);
    const delivered = await db.engine.deliverPendingInformNotifications(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(delivered.delivered).toBe(1);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]).toMatch(/høyere enn din vanlige dag/);
    const redelivered = await db.engine.deliverPendingInformNotifications(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(redelivered.delivered).toBe(0);
    expect(telegram.messages).toHaveLength(1);
  });

  it("stilnet jobb: domenet `operations` (rører ikke infra-løsningen), `inform`, og samme episode gir samme situasjon", async () => {
    const { gateway, actuator } = buildGateway(new FakeNotifier(true));
    await bind("test_gate", "close", { situation_id: "{{situation_id}}" }, "operations", "business");
    const stale = detectStaleJobs([{ job_name: "situation-sweep", last_completed_at: new Date(NOW - 100 * 3_600_000).toISOString(), expected_interval_hours: 24 }], NOW)[0]!;
    const candidate = mapStaleJobToCandidate(stale);
    const a = await db.engine.evaluateCandidate(TENANT_A, "business", candidate, NOW);
    const b = await db.engine.evaluateCandidate(TENANT_A, "business", candidate, NOW + 3_600_000);
    expect(b.situation.situation_id).toBe(a.situation.situation_id);
    expect(a.situation).toMatchObject({ domain: "operations", stage: "inform", priority: "high" });
    expect((await db.engine.autoActPending(TENANT_A, "business", gateway, identity(TENANT_A, "business"))).attempted).toBe(0);
    expect(actuator.calls).toEqual([]);
    // den daglige infra-løsningen (som løser alle åpne `infra`-situasjoner uten aktiv incident) rører den ikke
    const resolved = await db.engine.resolveStaleForDomain(TENANT_A, "business", "infra", []);
    expect(resolved).toBe(0);
    expect((await db.engine.findByDetectionKey(TENANT_A, "business", candidate.detection_key))!.status).toBe("open");
  });
});
