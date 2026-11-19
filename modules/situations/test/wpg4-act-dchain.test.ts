import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { homeCriticalToolDefinitions, parseHomeTargets, type ClassDNotification, type ClassDNotifier, type ToolTransport } from "@jarvis/tool-gateway";
import { detectSpendSpike, detectStaleJobs, mapSpendSpikeToCandidate, mapStaleJobToCandidate } from "../src/anomaly-detectors.ts";
import { openingDetectionKey } from "../src/home-bridge.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { identity, minutesAgo, NOW, OWNER, actorOwner, record, startG4Db, TENANT_A, type G4Db } from "./support/wpg4-db.ts";

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
    preflight_action: "read_state", preflight_requires_target: true, postcondition_predicate: (after) => (after as { done?: boolean } | null)?.done === true
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
      rollback_procedure: "angre via test_param", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_PARAM_TOKEN", output_trust: "internal", transport: spy
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
      rollback_procedure: "angre via test_param", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_PARAM_TOKEN", output_trust: "internal", transport: spy
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

describe("B: de ekte G2-hjemmehandlingene nektes for den autonome sveipe-identiteten (step-up, Q-55) - fail-closed", () => {
  it("critical_cover med eierens binding: nektet av step-up FØR noe kall til Home Assistant; situasjonen eskalerer; ingen varsel om utført handling", async () => {
    const notifier = new FakeNotifier(true);
    const { gateway, telegram } = buildGateway(notifier);
    const ha = new HaSpy();
    for (const def of homeCriticalToolDefinitions(ha, { targets: parseHomeTargets("cover.garasje"), settleMs: 20_000, pollMs: 1_000 })) gateway.register(def);
    await seedGateSuggest("cover.garasje");
    await bind("home-assistant", "critical_cover", { entity: "cover.garasje", target: "closed" });
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, denied: 1 });
    expect(ha.calls).toEqual([]); // verken lesing (preflight) eller kommando nådde utstyret
    expect(notifier.sent).toEqual([]);
    expect(telegram.messages.some((m) => m.startsWith("Jarvis utførte en handling"))).toBe(false);
    expect((await deniedAudit("home-assistant", "critical_cover")).map((r) => r.reason)).toContain("step_up_required:signed_device_session");
    const sit = await db.engine.findByDetectionKey(TENANT_A, "home", openingDetectionKey("cover.garasje", Date.parse(minutesAgo(90))));
    expect(sit).toMatchObject({ stage: "escalate", act_result: "denied" });
  });

  it("et mål utenfor eierens allowlist nektes uansett (mål-autorisasjon), også uten step-up-spørsmålet", async () => {
    const { gateway } = buildGateway(new FakeNotifier(true));
    const ha = new HaSpy();
    for (const def of homeCriticalToolDefinitions(ha, { targets: parseHomeTargets("cover.annen_port"), settleMs: 20_000, pollMs: 1_000 })) gateway.register(def);
    await seedGateSuggest("cover.garasje");
    await bind("home-assistant", "critical_cover", { entity: "cover.garasje", target: "closed" });
    const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, denied: 1 });
    expect(ha.calls).toEqual([]);
    expect((await deniedAudit("home-assistant", "critical_cover")).map((r) => r.reason)).toContain("home_target_not_authorized");
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
