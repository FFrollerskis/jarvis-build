import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { DOMAIN_WIDE_SCOPE, SituationAutonomyScopeError, pickEffectiveBinding, scopeKeyFor, type EffectivePolicyRow } from "../src/autonomy-scope.ts";
import { SituationAutonomyBindingChangedError } from "../src/service.ts";
import { SimulationService, simulationToolInfoFrom } from "../src/simulation.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { RULES, RULE_CATEGORY, SCOPE_CATEGORIES } from "../src/signal-types.ts";
import { identity, minutesAgo, NOW, OWNER, actorOwner, startG4Db, TENANT_A, TENANT_B, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4b K2 (D-484, Q-75 pkt 7, JARVIS-115 a): autonomi-bindingen kan skopes til EN REGEL eller EN KATEGORI i stedet for hele domenet.
 *  A (rent): skopnøkkel + validering, kategoridekning av regelregisteret, og presedensen (regel > kategori > domene; taket; unntak).
 *  B (ekte Postgres, ekte motor/gateway/buss): bakoverkompatibilitet, kun-regel, presedens, kategori, tak, eksplisitt unntak, bind-tid-validering (+K1/fysisk uendret), clear per skop, claim-vakten, midt-i-løpet-endring,
 *     regelen som VANT på situasjonen, eldre situasjoner uten regel, simulering.
 *  C (migrasjon 148): fra tom DB og oppover fra main-skjemaet (eksisterende rader beholdes som `*`), PK/CHECK, RLS (tenant og rom).
 */
const row = (scope_key: string, active = true, tool_id = "t", action = "a"): EffectivePolicyRow => ({ scope_key, tool_id, action, parameters: {}, active });

describe("A: skopnøkkel, kategorier og presedens (rent)", () => {
  it("hver regel i registeret har nøyaktig én kategori, og kategoriene er de lukkede", () => {
    expect(Object.keys(RULE_CATEGORY).sort()).toEqual(RULES.map((r) => r.rule_key).sort());
    expect(SCOPE_CATEGORIES).toEqual(["alarm", "camera_activity", "camera_security", "doorbell", "health_deviation", "incident", "leak", "opening", "power"]);
  });

  it("scopeKeyFor: `*` uten skop; `rule:`/`category:` kun for det lukkede settet og bindingens EGET domene; alt annet avvises", () => {
    expect(scopeKeyFor("home", undefined)).toBe(DOMAIN_WIDE_SCOPE);
    expect(scopeKeyFor("home", {})).toBe("*");
    expect(scopeKeyFor("home", { rule: "home_assistant:door_open_too_long" })).toBe("rule:home_assistant:door_open_too_long");
    expect(scopeKeyFor("home", { rule: "vision:opening_detected" })).toBe("rule:vision:opening_detected"); // kameraets åpningsregel bor i domenet `home`
    expect(scopeKeyFor("home", { category: "opening" })).toBe("category:opening");
    expect(scopeKeyFor("infra", { rule: "incident:incident_active" })).toBe("rule:incident:incident_active");
    const bad: Array<[string, Parameters<typeof scopeKeyFor>[1], string]> = [
      ["home", { rule: "home_assistant:door_open_too_long", category: "opening" }, "rule_and_category_are_exclusive"],
      ["home", { rule: "home_assistant:finnes_ikke" }, "unknown_rule"], ["home", { rule: "*" }, "unknown_rule"], ["home", { rule: "home_assistant:*" }, "unknown_rule"], ["home", { rule: "" }, "unknown_rule"],
      ["infra", { rule: "home_assistant:door_open_too_long" }, "rule_not_in_domain"], ["home", { rule: "vision:motion_detected" }, "rule_not_in_domain"],
      ["home", { category: "finnes_ikke" }, "unknown_category"], ["home", { category: "*" }, "unknown_category"],
      ["infra", { category: "opening" }, "category_not_in_domain"], ["spend", { category: "leak" }, "category_not_in_domain"], ["pipeline", { rule: "home_assistant:water_leak" }, "rule_not_in_domain"]
    ];
    for (const [domain, scope, detail] of bad) expect(() => scopeKeyFor(domain, scope), JSON.stringify([domain, scope])).toThrow(new SituationAutonomyScopeError(detail));
  });

  const DOOR = "home_assistant:door_open_too_long";
  it("presedens: regel > kategori > domene; den mest spesifikke RADEN avgjør", () => {
    const rows = [row("*", true, "broad"), row("category:opening", true, "cat"), row(`rule:${DOOR}`, true, "rule")];
    expect(pickEffectiveBinding(rows, DOOR)).toMatchObject({ kind: "binding", specificity: "rule", row: { tool_id: "rule" } });
    expect(pickEffectiveBinding([rows[0]!, rows[1]!], DOOR)).toMatchObject({ kind: "binding", specificity: "category", row: { tool_id: "cat" } });
    expect(pickEffectiveBinding([rows[0]!], DOOR)).toMatchObject({ kind: "binding", specificity: "domain", row: { tool_id: "broad" } });
    // en annen regel i samme kategori: kategoribindingen gjelder, regelbindingen for en ANNEN regel gjør det ikke
    expect(pickEffectiveBinding(rows, "vision:opening_detected")).toMatchObject({ specificity: "category" });
    expect(pickEffectiveBinding(rows, "home_assistant:water_leak")).toMatchObject({ specificity: "domain", row: { tool_id: "broad" } });
  });

  it("uten domenebred binding gir en smal binding autonomi for akkurat sitt skop og ingenting annet", () => {
    expect(pickEffectiveBinding([row(`rule:${DOOR}`)], DOOR)).toMatchObject({ kind: "binding", specificity: "rule" });
    expect(pickEffectiveBinding([row(`rule:${DOOR}`)], "home_assistant:water_leak")).toEqual({ kind: "none", reason: "no_binding" });
    expect(pickEffectiveBinding([row("category:opening")], "home_assistant:alarm_triggered")).toEqual({ kind: "none", reason: "no_binding" });
    // en situasjon uten regel (eldre sveip) får aldri en smal binding
    expect(pickEffectiveBinding([row(`rule:${DOOR}`), row("category:opening")], null)).toEqual({ kind: "none", reason: "no_binding" });
    expect(pickEffectiveBinding([row("*"), row(`rule:${DOOR}`)], null)).toMatchObject({ specificity: "domain" });
  });

  it("en AVSLÅTT/utløpt smal rad er et eksplisitt UNNTAK: ingen autonomi for akkurat det skopet, og aldri et stille fall tilbake til den brede", () => {
    expect(pickEffectiveBinding([row("*"), row(`rule:${DOOR}`, false)], DOOR)).toEqual({ kind: "none", reason: "specific_binding_inactive" });
    expect(pickEffectiveBinding([row("*"), row("category:opening", false)], DOOR)).toEqual({ kind: "none", reason: "specific_binding_inactive" });
    expect(pickEffectiveBinding([row("*"), row("category:opening", true), row(`rule:${DOOR}`, false)], DOOR)).toEqual({ kind: "none", reason: "specific_binding_inactive" });
    // andre regler i domenet påvirkes ikke av unntaket
    expect(pickEffectiveBinding([row("*"), row(`rule:${DOOR}`, false)], "home_assistant:water_leak")).toMatchObject({ kind: "binding", specificity: "domain" });
  });

  it("TAKET: en avslått/utløpt domenebred binding gjør ALLE smalere bindinger i domenet uvirksomme (en smalere binding gir aldri mer enn den brede)", () => {
    expect(pickEffectiveBinding([row("*", false), row(`rule:${DOOR}`, true)], DOOR)).toEqual({ kind: "none", reason: "domain_binding_inactive" });
    expect(pickEffectiveBinding([row("*", false), row("category:opening", true)], DOOR)).toEqual({ kind: "none", reason: "domain_binding_inactive" });
    expect(pickEffectiveBinding([row("*", false)], DOOR)).toEqual({ kind: "none", reason: "domain_binding_inactive" });
    expect(pickEffectiveBinding([row("*", false)], null)).toEqual({ kind: "none", reason: "domain_binding_inactive" });
  });

  it("ukjente skopnøkler (rader utenom applikasjonen) matcher aldri; rekkefølgen på radene er uten betydning", () => {
    expect(pickEffectiveBinding([row("rule:ukjent:regel"), row("kaos")], DOOR)).toEqual({ kind: "none", reason: "no_binding" });
    const rows = [row("*", true, "b"), row("category:opening", true, "c"), row(`rule:${DOOR}`, true, "r")];
    for (const perm of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]]) expect(pickEffectiveBinding(perm.map((i) => rows[i]!), DOOR)).toMatchObject({ row: { tool_id: "r" } });
  });
});

describe("B: motoren mot ekte Postgres (ekte buss, gateway og claim-vakt)", () => {
  let db: G4Db;
  let bus: SituationSignalBus;
  beforeAll(async () => {
    db = await startG4Db("wpg4b_scope");
    bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => NOW });
  }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  const DOOR = "home_assistant:door_open_too_long";
  const LEAK = "home_assistant:water_leak";
  const bind = (over: Record<string, unknown>) =>
    db.engine.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" }, ...over } as never, OWNER);

  /** En port åpen i 90 min (`suggest`, regel door_open_too_long) og en lekkasje (`suggest`, regel water_leak). */
  async function seedSuggests(): Promise<{ door: string; leak: string }> {
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }] } }, actorOwner);
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "water_leak", filter: { entities: [{ entity_id: "binary_sensor.lekkasje", role: "leak" }] } }, actorOwner);
    const out = await bus.publishBatch(TENANT_A, "home", [
      { source: "home_assistant", entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(90) },
      { source: "home_assistant", entity_id: "binary_sensor.lekkasje", role: "leak", state: "on", last_changed: minutesAgo(1) }
    ]);
    expect(out.evaluated).toBe(2);
    const sits = await db.engine.getQueue(TENANT_A, "home", {});
    const door = sits.find((s) => s.rule_key === DOOR);
    const leak = sits.find((s) => s.rule_key === LEAK);
    expect(door?.stage).toBe("suggest");
    expect(leak?.stage).toBe("suggest");
    return { door: door!.situation_id, leak: leak!.situation_id };
  }
  const act = (gateway: ReturnType<G4Db["newGateway"]>["gateway"]) => db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
  const closed = (actuator: { calls: Array<{ action: string; parameters: Record<string, unknown> }> }): string[] => actuator.calls.filter((c) => c.action === "close").map((c) => String(c.parameters["situation_id"]));

  it("bakoverkompatibelt: en domenebred binding (som alle eksisterende) gjelder ALLE regler i domenet, og raden har scope_key `*`", async () => {
    const { gateway, actuator } = db.newGateway();
    const ids = await seedSuggests();
    await bind({});
    expect((await db.engine.listAutonomyPolicies(TENANT_A, "home")).map((p) => p.scope_key)).toEqual(["*"]);
    expect(await act(gateway)).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(closed(actuator).sort()).toEqual([ids.door, ids.leak].sort());
  });

  it("kun en regelbinding: akkurat den regelen utføres, resten av domenet får INGEN autonomi", async () => {
    const { gateway, actuator } = db.newGateway();
    const ids = await seedSuggests();
    await bind({ rule: DOOR });
    expect(await act(gateway)).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(closed(actuator)).toEqual([ids.door]);
    const leak = (await db.engine.getQueue(TENANT_A, "home", {})).find((s) => s.situation_id === ids.leak)!;
    expect(leak).toMatchObject({ stage: "suggest", act_idempotency_key: null });
  });

  it("kategoribinding: `opening` gjelder porten, ikke lekkasjen; en regelbinding har forrang over kategorien", async () => {
    const { gateway, actuator, telegram } = db.newGateway();
    const ids = await seedSuggests();
    await bind({ category: "opening" });
    expect(await act(gateway)).toMatchObject({ attempted: 1 });
    expect(closed(actuator)).toEqual([ids.door]);
    // forrang: samme porten, men nå med en regelbinding til en ANNEN handling - den vinner (kategoribindingen brukes ikke)
    await db.reset();
    const again = db.newGateway();
    const ids2 = await seedSuggests();
    await bind({ category: "opening" });
    await bind({ rule: DOOR, tool_id: "telegram", action: "notify", parameters: { message: "Porten har stått åpen" } });
    expect(await act(again.gateway)).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(closed(again.actuator)).toEqual([]);
    expect(again.telegram.messages.some((m) => m === "Porten har stått åpen")).toBe(true);
    expect(telegram.messages).toHaveLength(1); // kun motorens eget ACT+NOTIFY fra første del (kategoribindingen utførte aktuatoren), ingenting fra den andre gatewayen
    expect(ids2.door).not.toBe(ids.door);
  });

  it("presedens regel > domene: lekkasjen følger regelbindingen (telegram), alt annet følger den domenebrede (aktuatoren)", async () => {
    const { gateway, actuator, telegram } = db.newGateway();
    const ids = await seedSuggests();
    await bind({});
    await bind({ rule: LEAK, tool_id: "telegram", action: "notify", parameters: { message: "Lekkasje oppdaget" } });
    expect(await act(gateway)).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(closed(actuator)).toEqual([ids.door]);
    expect(telegram.messages.filter((m) => m === "Lekkasje oppdaget")).toHaveLength(1);
  });

  it("TAKET: en avslått domenebred binding stanser også de smale; slås den på igjen virker de; en UTLØPT domenebred stanser dem også", async () => {
    const { gateway, actuator } = db.newGateway();
    const ids = await seedSuggests();
    await bind({ enabled: false });
    await bind({ rule: DOOR });
    expect(await act(gateway)).toMatchObject({ attempted: 0 });
    expect(closed(actuator)).toEqual([]);
    await bind({ enabled: true });
    // utløpt (skrevet direkte: applikasjonen avviser en utløpstid i fortiden ved binding)
    await db.adminPool.query(`UPDATE situation_autonomy_policies SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND scope_key = '*'`, [TENANT_A]);
    expect(await act(gateway)).toMatchObject({ attempted: 0 });
    await db.adminPool.query(`UPDATE situation_autonomy_policies SET expires_at = NULL WHERE tenant_id = $1 AND scope_key = '*'`, [TENANT_A]);
    expect(await act(gateway)).toMatchObject({ attempted: 2 });
    expect(closed(actuator).sort()).toEqual([ids.door, ids.leak].sort());
  });

  it("eksplisitt UNNTAK: en avslått regelbinding stanser akkurat den regelen mens den domenebrede fortsatt gjelder resten", async () => {
    const { gateway, actuator } = db.newGateway();
    const ids = await seedSuggests();
    await bind({});
    await bind({ rule: DOOR, enabled: false });
    expect(await act(gateway)).toMatchObject({ attempted: 1 });
    expect(closed(actuator)).toEqual([ids.leak]);
    expect((await db.engine.getQueue(TENANT_A, "home", {})).find((s) => s.situation_id === ids.door)).toMatchObject({ stage: "suggest", act_idempotency_key: null });
  });

  it("bind-tid: ugyldig skop avvises uten rad; K1 (default-deny) og fysiske navnerom gjelder uendret for et smalt skop", async () => {
    db.newGateway();
    for (const [scope, detail] of [[{ rule: "home_assistant:finnes_ikke" }, "unknown_rule"], [{ rule: "vision:motion_detected" }, "rule_not_in_domain"], [{ category: "camera_activity" }, "category_not_in_domain"], [{ rule: DOOR, category: "opening" }, "rule_and_category_are_exclusive"]] as const) {
      await expect(bind(scope), JSON.stringify(scope)).rejects.toMatchObject({ name: "SituationAutonomyScopeError", message: `situation_autonomy_scope_invalid:${detail}` });
    }
    await expect(bind({ rule: DOOR, tool_id: "home-assistant", action: "lock_set" })).rejects.toMatchObject({ code: "physical_action_not_bindable" });
    await expect(bind({ category: "opening", tool_id: "make", action: "run_scenario" })).rejects.toMatchObject({ code: "action_not_bindable" });
    expect(await db.engine.listAutonomyPolicies(TENANT_A, "home")).toEqual([]);
  });

  it("clear: uten skop fjernes KUN den domenebrede raden; med skop akkurat den regel-/kategoribindingen; set erstatter per skop", async () => {
    db.newGateway();
    await bind({});
    await bind({ rule: DOOR });
    await bind({ category: "leak" });
    await bind({ rule: DOOR, tool_id: "telegram", action: "notify", parameters: { message: "erstattet" } }); // erstatter KUN regelraden
    const scopes = async (): Promise<string[]> => (await db.engine.listAutonomyPolicies(TENANT_A, "home")).map((p) => p.scope_key);
    expect(await scopes()).toEqual(["*", "category:leak", `rule:${DOOR}`]);
    expect((await db.engine.getAutonomyPolicy(TENANT_A, "home", "home", `rule:${DOOR}`))?.tool_id).toBe("telegram");
    expect((await db.engine.getAutonomyPolicy(TENANT_A, "home", "home"))?.tool_id).toBe("test_actuator");
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER)).toBe(true);
    expect(await scopes()).toEqual(["category:leak", `rule:${DOOR}`]);
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER)).toBe(false);
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER, { rule: DOOR })).toBe(true);
    expect(await db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", OWNER, { category: "leak" })).toBe(true);
    expect(await scopes()).toEqual([]);
    await expect(db.engine.clearAutonomyPolicy(TENANT_A, "home", "home", "person-g4-other", { rule: DOOR })).rejects.toThrow(/unauthorized/);
  });

  it("claim-vakten bruker samme avgjørelse: en binding for en ANNEN regel gir aldri claim for denne situasjonen (BindingChanged), og ingen kall", async () => {
    const { gateway, actuator } = db.newGateway();
    const ids = await seedSuggests();
    await bind({ rule: DOOR });
    await expect(
      db.engine.actOn(TENANT_A, "home", ids.leak, { tool_id: "test_actuator", action: "close", parameters: { situation_id: ids.leak } }, gateway, identity(TENANT_A, "home"), { autoActGuard: { max_age_seconds: 3600 } })
    ).rejects.toBeInstanceOf(SituationAutonomyBindingChangedError);
    expect(closed(actuator)).toEqual([]);
    expect((await db.engine.getQueue(TENANT_A, "home", {})).find((s) => s.situation_id === ids.leak)?.act_idempotency_key).toBeNull();
  });

  it("midt i løpet: fjerner eieren regelbindingen mens første situasjon utføres, hoppes neste over (ingen ACT uten binding)", async () => {
    const { gateway, actuator } = db.newGateway();
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "cover.garasje", role: "garage_door" }, { entity_id: "cover.port", role: "gate" }] } }, actorOwner);
    await bus.publishBatch(TENANT_A, "home", [
      { source: "home_assistant", entity_id: "cover.garasje", role: "garage_door", state: "open", last_changed: minutesAgo(90) },
      { source: "home_assistant", entity_id: "cover.port", role: "gate", state: "open", last_changed: minutesAgo(91) }
    ]);
    await bind({ rule: DOOR });
    // (direkte SQL, som i act-dchain-testen: `clearAutonomyPolicy` tar domenelåsen som `actOn` holder under hele utførelsen)
    actuator.onClose = async () => { await db.adminPool.query(`DELETE FROM situation_autonomy_policies WHERE tenant_id = $1 AND scope_key = $2`, [TENANT_A, `rule:${DOOR}`]); };
    const result = await act(gateway);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, skipped: 1 });
    expect(closed(actuator)).toHaveLength(1);
  });

  it("regelen som VANT følger situasjonen (som prioritet): en senere, lavere prioritet fra en annen regel overskriver den ikke; lik prioritet gjør det; eldre sveip gir `null`", async () => {
    const key = "home:opening:cover.test@1";
    const base = { domain: "home", detection_key: key, reason: "r", no_downgrade: true } as const;
    const a = await db.engine.evaluateCandidate(TENANT_A, "home", { ...base, priority: "high", confidence: 0.9, rule_key: DOOR }, NOW);
    expect(a.situation.rule_key).toBe(DOOR);
    const lower = await db.engine.evaluateCandidate(TENANT_A, "home", { ...base, priority: "low", rule_key: "vision:opening_detected" }, NOW);
    expect(lower.situation.rule_key).toBe(DOOR);
    const equal = await db.engine.evaluateCandidate(TENANT_A, "home", { ...base, priority: "high", confidence: 0.9, rule_key: "vision:opening_detected" }, NOW);
    expect(equal.situation.rule_key).toBe("vision:opening_detected");
    const sweep = await db.engine.evaluateCandidate(TENANT_A, "business", { domain: "pipeline", detection_key: "followup:1", priority: "high", confidence: 0.9, reason: "r" }, NOW);
    expect(sweep.situation.rule_key).toBeNull();
    // en kandidat uten regel overskriver aldri en eksisterende regel
    const unset = await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: key, priority: "high", confidence: 0.9, reason: "r2" }, NOW);
    expect(unset.situation.rule_key).toBe("vision:opening_detected");
    await expect(db.engine.evaluateCandidate(TENANT_A, "home", { ...base, priority: "high", rule_key: "UGYLDIG" }, NOW)).rejects.toThrow();
  });

  it("eldre situasjoner uten regel (sveipene): kun en domenebred binding gjelder; en smal binding gir dem aldri autonomi", async () => {
    const { gateway, actuator } = db.newGateway();
    const sweep = await db.engine.evaluateCandidate(TENANT_A, "business", { domain: "infra", detection_key: "infra:sweep:1", priority: "high", confidence: 0.9, reason: "r" }, NOW);
    await db.engine.setAutonomyPolicy(TENANT_A, "business", { domain: "infra", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" }, rule: "incident:incident_active" } as never, OWNER);
    const none = await db.engine.autoActPending(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(none).toMatchObject({ attempted: 0 });
    await db.engine.setAutonomyPolicy(TENANT_A, "business", { domain: "infra", tool_id: "test_actuator", action: "close", parameters: { situation_id: "{{situation_id}}" } } as never, OWNER);
    const some = await db.engine.autoActPending(TENANT_A, "business", gateway, identity(TENANT_A, "business"));
    expect(some).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(closed(actuator)).toEqual([sweep.situation.situation_id]);
  });

  it("simuleringen bruker den effektive bindingen: regelbindingen gjelder porten, ikke lekkasjen", async () => {
    const { gateway } = db.newGateway();
    const ids = await seedSuggests();
    await bind({ rule: DOOR });
    const sim = new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW);
    const forDoor = await sim.simulate(TENANT_A, "home", ids.door);
    const forLeak = await sim.simulate(TENANT_A, "home", ids.leak);
    expect(forDoor.scenarios.find((s) => s.id === "acted_at_suggest")?.blocked_by).not.toContain("no_binding");
    expect(forLeak.scenarios.find((s) => s.id === "acted_at_suggest")?.blocked_by).toContain("no_binding");
  });
});

describe("C: migrasjon 148 (fra tom DB og oppover fra main-skjemaet), PK/CHECK og RLS", () => {
  const MIGRATIONS = fileURLToPath(new URL("../../core/src/db/migrations", import.meta.url));
  let stop: (() => Promise<void>) | undefined;
  let admin: pg.Pool;
  let app: pg.Pool;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g4b-mig-"));
    const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
    stop = leased.stop;
    await leased.postgres.createDatabase("jarvis_test");
    admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
    admin.on("error", () => undefined);
    // 1) «main-skjemaet»: alle migrasjoner FØR 148 (en midlertidig katalog med kopier; ingenting slettes).
    const before = await mkdtemp(join(tmpdir(), "jarvis-mig-before148-"));
    for (const file of (await readdir(MIGRATIONS)).filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) < 148)) await copyFile(join(MIGRATIONS, file), join(before, file));
    await mkdir(before, { recursive: true });
    await runMigrations(admin, before);
    await admin.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','person'), ('${TENANT_B}','B','person');
      INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}');
      INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id) VALUES
        ('${TENANT_A}','home','home','telegram','notify','{"message":"x"}'::jsonb,true,'${OWNER}'),
        ('${TENANT_A}','business','pipeline','business','create_followup','{}'::jsonb,false,'${OWNER}'),
        ('${TENANT_B}','home','home','telegram','notify','{"message":"b"}'::jsonb,true,'${OWNER}');
      INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, detection_key, stage, priority, reason) VALUES ('sit-old-1','${TENANT_A}','home','home','home:old:1','suggest','high','gammel');
    `);
    // 2) oppover fra main-skjemaet: KUN 148 (og eventuelt senere) gjenstår
    const applied = await runMigrations(admin);
    expect(applied.some((f) => f.startsWith("148_"))).toBe(true);
    await admin.query("CREATE ROLE jarvis_g4b_mig LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
    await admin.query("GRANT jarvis_app TO jarvis_g4b_mig");
    app = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g4b_mig", password: "pw2" });
    app.on("error", () => undefined);
  }, 300_000);
  afterAll(async () => { await app?.end(); await admin?.end(); await stop?.(); }, 120_000);

  const asApp = async <T>(tenant: string, spaces: string[], fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [tenant, spaces.join(",")]);
      const out = await fn(client);
      await client.query("ROLLBACK");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  it("eksisterende rader beholdes uendret og får `scope_key = '*'`; eksisterende situasjon får `rule_key = NULL`", async () => {
    const { rows } = await admin.query("SELECT tenant_id, domain, scope_key, tool_id, enabled FROM situation_autonomy_policies ORDER BY tenant_id, domain");
    expect(rows).toEqual([
      { tenant_id: TENANT_A, domain: "home", scope_key: "*", tool_id: "telegram", enabled: true },
      { tenant_id: TENANT_A, domain: "pipeline", scope_key: "*", tool_id: "business", enabled: false },
      { tenant_id: TENANT_B, domain: "home", scope_key: "*", tool_id: "telegram", enabled: true }
    ]);
    expect((await admin.query("SELECT rule_key FROM situations WHERE situation_id = 'sit-old-1'")).rows[0]).toEqual({ rule_key: null });
  });

  it("primærnøkkelen er (tenant, rom, domene, skop): flere skop i samme domene, men ikke to like; CHECK avviser ugyldige nøkler", async () => {
    const insert = (scope: string) => admin.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, scope_key, actor_person_id) VALUES ('${TENANT_A}','home','home','telegram','notify',$1,'${OWNER}')`, [scope]
    );
    await insert("rule:home_assistant:water_leak");
    await insert("category:leak");
    await expect(insert("rule:home_assistant:water_leak")).rejects.toThrow(/duplicate key|situation_autonomy_policies_pkey/);
    for (const bad of ["", "rule:", "rule:Stor:Bokstav", "category:", "category:a", "category:med mellomrom", "alle", "rule:a:b", "*/", "rule:home_assistant:water_leak;drop"]) {
      await expect(insert(bad), bad).rejects.toThrow(/situation_autonomy_policies_scope_key_ck/);
    }
    await expect(admin.query("UPDATE situations SET rule_key = 'UGYLDIG' WHERE situation_id = 'sit-old-1'")).rejects.toThrow(/situations_rule_key_ck/);
    await admin.query("UPDATE situations SET rule_key = 'home_assistant:water_leak' WHERE situation_id = 'sit-old-1'");
    await admin.query("UPDATE situations SET rule_key = NULL WHERE situation_id = 'sit-old-1'");
  });

  it("RLS: app-rollen ser og skriver kun egen tenant og egne rom (målt UTEN tenantfilter i spørringen), også for smale bindinger", async () => {
    const seenA = await asApp(TENANT_A, ["home"], async (c) => (await c.query("SELECT tenant_id, memory_space_id, domain, scope_key FROM situation_autonomy_policies ORDER BY scope_key")).rows);
    expect(seenA.every((r) => r.tenant_id === TENANT_A && r.memory_space_id === "home")).toBe(true);
    expect(seenA.map((r) => r.scope_key)).toEqual(["*", "category:leak", "rule:home_assistant:water_leak"]);
    const seenB = await asApp(TENANT_B, ["home"], async (c) => (await c.query("SELECT tenant_id, scope_key FROM situation_autonomy_policies")).rows);
    expect(seenB).toEqual([{ tenant_id: TENANT_B, scope_key: "*" }]);
    // et annet rom er skjult selv for riktig tenant
    expect(await asApp(TENANT_A, ["personal"], async (c) => (await c.query("SELECT 1 FROM situation_autonomy_policies")).rows)).toEqual([]);
    // kryss-tenant-skriving avvises av WITH CHECK
    await expect(asApp(TENANT_A, ["home"], async (c) => c.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, scope_key, actor_person_id) VALUES ('${TENANT_B}','home','home','telegram','notify','category:alarm','${OWNER}')`
    ))).rejects.toThrow(/row-level security/);
    await expect(asApp(TENANT_A, ["home"], async (c) => c.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, scope_key, actor_person_id) VALUES ('${TENANT_A}','business','home','telegram','notify','category:alarm','${OWNER}')`
    ))).rejects.toThrow(/row-level security/);
  });
});
