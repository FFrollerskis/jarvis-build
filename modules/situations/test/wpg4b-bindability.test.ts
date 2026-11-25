import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import {
  AUTONOMY_FORBIDDEN_NAMESPACES, AUTONOMY_REASON_MIN_CHARS, ToolManifestViolationError, assertManifestInvariants, autonomyBindabilityOf, buildToolManifest, firstWaveTools,
  type ToolDefinition, type ToolTransport
} from "@jarvis/tool-gateway";
import { PHYSICAL_NAMESPACES, SituationActActionForbiddenError, autonomyBindBlocker } from "../src/autonomy-guard.ts";
import { SituationEngine } from "../src/service.ts";
import { SimulationService, simulationToolInfoFrom } from "../src/simulation.ts";
import { NOW, OWNER, identity, record, startG4Db, TENANT_A, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4b K1 (D-484, Q-75 pkt 11, JARVIS-115 m): BINDBARHET til autonom ACT er en egenskap per verktøydefinisjon, DEFAULT-DENY.
 *  A (rent): vakten `autonomyBindBlocker` (fysisk først, så egenskapen; fail-closed ved alt uklart) og `autonomyBindabilityOf`.
 *  B (rent): manifestet bærer erklæringen, og `assertManifestInvariants` feller en feilmerket definisjon (begrunnelse, fysiske navnerom, pay/control/delete, step-up).
 *  C (ekte Postgres, ekte motor/gateway): bind-tid avviser, utførelse nekter (ingen claim, ingen kall), en lagret binding slettes aldri og vises til eieren, definisjonen er sannheten, fysiske navnerom forblir stengt.
 */
const REASON = "Rent testverktøy uten ekstern effekt, brukes kun til å bevise bindbarhetsvakten.";

describe("A: autonomyBindBlocker er fysisk-først og DEFAULT-DENY (fail-closed ved alt uklart)", () => {
  const bindable = { autonomy_bindable: { reason: REASON } };
  const lookup = (table: Record<string, unknown>) => (t: string, a: string) => table[`${t}.${a}`] as { autonomy_bindable?: unknown } | undefined;

  it("bindbar KUN når definisjonen erklærer det med en reell begrunnelse", () => {
    expect(autonomyBindBlocker("telegram", "notify", lookup({ "telegram.notify": bindable }))).toBeNull();
    expect(autonomyBindBlocker("telegram", "notify", lookup({ "telegram.notify": {} }))).toEqual({ code: "action_not_bindable", tool_id: "telegram", action: "notify" });
  });

  it("ingen oppslagsfunksjon, ukjent handling og en kastet feil gir `action_not_bindable` (aldri en stille «bindbar»)", () => {
    expect(autonomyBindBlocker("telegram", "notify", undefined)?.code).toBe("action_not_bindable");
    expect(autonomyBindBlocker("ukjent", "handling", lookup({}))?.code).toBe("action_not_bindable");
    expect(autonomyBindBlocker("telegram", "notify", () => { throw new Error("register nede"); })?.code).toBe("action_not_bindable");
  });

  it("ugyldige erklæringer teller ikke: `true`, tom/kort begrunnelse, liste, feil type", () => {
    for (const declared of [true, "ja", 1, [], { reason: "" }, { reason: "   " }, { reason: "for kort" }, { reason: "x".repeat(AUTONOMY_REASON_MIN_CHARS - 1) }, { reason: 5 }, { why: REASON }, null]) {
      expect(autonomyBindBlocker("t", "a", lookup({ "t.a": { autonomy_bindable: declared } }))?.code, JSON.stringify(declared)).toBe("action_not_bindable");
      expect(autonomyBindabilityOf({ autonomy_bindable: declared }), JSON.stringify(declared)).toBeNull();
    }
    expect(autonomyBindabilityOf({ autonomy_bindable: { reason: ` ${"x".repeat(AUTONOMY_REASON_MIN_CHARS)} ` } })?.reason).toBe("x".repeat(AUTONOMY_REASON_MIN_CHARS));
    expect(autonomyBindabilityOf(undefined)).toBeNull();
    expect(autonomyBindabilityOf(null)).toBeNull();
  });

  it("de fysiske navnerommene er stengt FØRST: en definisjon som (feilaktig) erklærer seg bindbar åpner dem aldri", () => {
    const any = () => bindable;
    for (const [tool, action] of [["home-assistant", "lock_set"], ["home-assistant", "critical_cover"], ["car", "unlock"], ["home-assistant", "ukjent_ny"]]) {
      expect(autonomyBindBlocker(tool, action, any), `${tool}.${action}`).toEqual({ code: "physical_action_not_bindable", tool_id: tool, action });
    }
    // og ugyldig inndata er alltid fysisk-nektet (som før)
    for (const bad of [[undefined, "x"], ["x", undefined], ["", "x"], [5, "x"]]) expect(autonomyBindBlocker(bad[0], bad[1], any)?.code, String(bad)).toBe("physical_action_not_bindable");
  });

  it("settet av fysiske navnerom i tool-gateway (manifestinvarianten) er det samme som vaktens", () => {
    expect([...AUTONOMY_FORBIDDEN_NAMESPACES].sort()).toEqual([...PHYSICAL_NAMESPACES].sort());
  });
});

describe("B: manifestet bærer erklæringen og invariantene feller en feilmerket definisjon", () => {
  const def = (over: Partial<ToolDefinition> & { tool_id: string; action: string }): ToolDefinition => ({
    description: "test", input_schema: record({}), capability_class: "B", scopes: [], reversible: true, rollback_procedure: "angre", idempotent_external: true, timeout_ms: 1000, rate_limit_per_minute: 10,
    credential_ref: "", output_trust: "internal", transport: { invoke: async () => ({}) }, ...over
  });
  const violationsOf = (d: ToolDefinition): string[] => {
    try {
      assertManifestInvariants(buildToolManifest([d]), { ignoreUnregisteredGrants: true });
      return [];
    } catch (err) {
      if (err instanceof ToolManifestViolationError) return err.violations;
      throw err;
    }
  };

  it("uten erklæring: autonomy_bindable=false (default-deny), og ingen invariant utløses", () => {
    const entry = buildToolManifest([def({ tool_id: "business", action: "create_followup" })]).get("business.create_followup")!;
    expect(entry).toMatchObject({ autonomy_bindable: false, autonomy_reason: null, step_up_required: false });
    expect(violationsOf(def({ tool_id: "business", action: "create_followup" }))).toEqual([]);
  });

  it("med gyldig erklæring: entry bærer begrunnelsen og invariantene holder", () => {
    const d = def({ tool_id: "business", action: "create_followup", autonomy_bindable: { reason: REASON } });
    expect(buildToolManifest([d]).get("business.create_followup")).toMatchObject({ autonomy_bindable: true, autonomy_reason: REASON });
    expect(violationsOf(d)).toEqual([]);
  });

  it("ugyldig begrunnelse, fysisk navnerom, effekt pay/control/delete og step-up er hver for seg en invariantbrudd", () => {
    expect(violationsOf(def({ tool_id: "business", action: "create_followup", autonomy_bindable: { reason: "kort" } })).join("|")).toMatch(/krever en begrunnelse/);
    expect(violationsOf(def({ tool_id: "home-assistant", action: "read_state", capability_class: "A", autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/fysiske navnerom kan aldri/);
    expect(violationsOf(def({ tool_id: "car", action: "read_vehicle_state", capability_class: "A", autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/fysiske navnerom kan aldri/);
    expect(violationsOf(def({ tool_id: "business", action: "delete_lead", capability_class: "C", autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/effekt «delete»/);
    expect(violationsOf(def({ tool_id: "stripe", action: "refund", capability_class: "C", autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/effekt «pay»/);
    expect(violationsOf(def({ tool_id: "owner_controls", action: "kill_switch", capability_class: "C", autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/effekt «control»/);
    expect(violationsOf(def({ tool_id: "business", action: "create_followup", step_up_required: true, autonomy_bindable: { reason: REASON } })).join("|")).toMatch(/step-up/);
  });

  it("de produksjonsdefinisjonene som erklærer seg bindbare består invariantene (begrunnelse, effekt, ingen step-up)", () => {
    const bindableDefs = firstWaveTools({}).filter((d) => d.autonomy_bindable !== undefined);
    expect(bindableDefs.map((d) => `${d.tool_id}.${d.action}`).sort()).toEqual(["business.assign_open_loop", "business.create_followup", "telegram.notify"]);
    assertManifestInvariants(buildToolManifest(bindableDefs), { ignoreUnregisteredGrants: true });
  });
});

describe("C: motoren avviser ved bind-tid og nekter ved utførelse (ekte Postgres, ekte gateway)", () => {
  let db: G4Db;
  beforeAll(async () => { db = await startG4Db("wpg4b_bind"); }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => { await db.reset(); });

  class CountingTransport implements ToolTransport {
    calls = 0;
    async invoke(): Promise<{ external_id?: string; data?: JsonValue }> {
      this.calls += 1;
      return { external_id: `c-${this.calls}`, data: { done: true } };
    }
  }
  const tool = (tool_id: string, action: string, over: Partial<ToolDefinition> = {}): Omit<ToolDefinition, "transport"> & Partial<ToolDefinition> => ({
    tool_id, action, description: "test", input_schema: record({ situation_id: z.string().optional() }), capability_class: "C", scopes: [], reversible: true, rollback_procedure: "angre", idempotent_external: false,
    timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TOKEN", output_trust: "internal", ...over
  });
  const world = () => {
    const built = db.newGateway();
    const make = new CountingTransport();
    const n8n = new CountingTransport();
    const mail = new CountingTransport();
    // Slik repoet faktisk ser ut: klasse C UTEN step-up som kan utløse fysiske effekter via et scenario/en arbeidsflyt, og klasse D uten step-up (e-post). INGEN av dem erklærer bindbarhet.
    built.gateway.register({ ...tool("make", "run_scenario"), transport: make } as ToolDefinition);
    built.gateway.register({ ...tool("n8n", "activate_workflow"), transport: n8n } as ToolDefinition);
    built.gateway.register({ ...tool("email", "send", { capability_class: "D" }), transport: mail } as ToolDefinition);
    return { ...built, make, n8n, mail };
  };
  const bind = (tool_id: string, action: string, domain = "home", space: "home" | "business" = "home") =>
    db.engine.setAutonomyPolicy(TENANT_A, space, { domain, tool_id, action, parameters: { situation_id: "{{situation_id}}" } }, OWNER);
  const seedSuggest = async (key = "home:test:1", domain = "home") => (await db.engine.evaluateCandidate(TENANT_A, "home", { domain, detection_key: key, priority: "high", confidence: 0.9, reason: "r" }, NOW)).situation;
  const insertPolicy = (tool_id: string, action: string, domain = "home") => db.adminPool.query(
    `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id) VALUES ($1, 'home', $2, $3, $4, $5::jsonb, true, $6)`,
    [TENANT_A, domain, tool_id, action, JSON.stringify({ situation_id: "{{situation_id}}" }), OWNER]
  );

  it("bind-tid: `make.run_scenario`, `n8n.activate_workflow` og klasse D uten step-up (e-post) avvises (ikke erklært bindbare) og ingenting lagres", async () => {
    world();
    for (const [t, a] of [["make", "run_scenario"], ["n8n", "activate_workflow"], ["email", "send"], ["ukjent", "handling"]]) {
      await expect(bind(t!, a!), `${t}.${a}`).rejects.toMatchObject({ name: "SituationActActionForbiddenError", code: "action_not_bindable", message: `situation_autonomy_action_forbidden:action_not_bindable:${t}.${a}` });
    }
    expect((await db.adminPool.query("SELECT count(*)::int AS n FROM situation_autonomy_policies WHERE tenant_id = $1", [TENANT_A])).rows[0]).toEqual({ n: 0 });
  });

  it("en handling som ERKLÆRER seg bindbar kan bindes, og er den eneste måten: `telegram.notify` og `test_actuator.close` ja, resten nei", async () => {
    world();
    await bind("test_actuator", "close");
    const rows = await db.engine.listAutonomyPolicies(TENANT_A, "home");
    expect(rows.map((r) => `${r.tool_id}.${r.action}`)).toEqual(["test_actuator.close"]);
    expect(rows[0]).not.toHaveProperty("blocked_code"); // en bindbar rad er byte-lik før og etter
  });

  it("DEFAULT-DENY i motoren: uten oppslagsfunksjon er ingenting bindbart (heller ikke en handling som ellers erklærer seg bindbar)", async () => {
    world();
    const bare = new SituationEngine(db.appPool, db.domainPauses, { owner_person_id: OWNER });
    await expect(bare.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "telegram", action: "notify", parameters: { message: "x" } }, OWNER)).rejects.toBeInstanceOf(SituationActActionForbiddenError);
    expect(await db.engine.listAutonomyPolicies(TENANT_A, "home")).toEqual([]);
  });

  it("de fysiske navnerommene forblir stengt selv om en (feilmerket) definisjon erklærer seg bindbar", async () => {
    const { gateway } = world();
    gateway.register({ ...tool("home-assistant", "lock_set", { capability_class: "D", autonomy_bindable: TEST_BINDABLE }), transport: new CountingTransport() } as ToolDefinition);
    await expect(bind("home-assistant", "lock_set")).rejects.toMatchObject({ code: "physical_action_not_bindable" });
    expect((await db.adminPool.query("SELECT count(*)::int AS n FROM situation_autonomy_policies WHERE tenant_id = $1", [TENANT_A])).rows[0]).toEqual({ n: 0 });
  });

  it("utførelse: en LAGRET binding til en ikke-bindbar handling feiler lukket (ingen claim, ingen kall), slettes aldri og merkes for eieren; én logglinje per binding", async () => {
    const { gateway, make } = world();
    await insertPolicy("make", "run_scenario"); // skrevet direkte i databasen / eldre enn regelen
    const sit = await seedSuggest();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i += 1) {
        const result = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
        expect(result).toMatchObject({ attempted: 0, succeeded: 0, denied: 0, skipped: 1 });
      }
      const lines = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("situation_auto_act_blocked"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "situation_auto_act_blocked", domain: "home", tool_id: "make", action: "run_scenario", code: "action_not_bindable" });
    } finally {
      logged.mockRestore();
    }
    expect(make.calls).toBe(0);
    const row = (await db.adminPool.query("SELECT act_idempotency_key, stage FROM situations WHERE situation_id = $1", [sit.situation_id])).rows[0] as { act_idempotency_key: string | null; stage: string };
    expect(row).toEqual({ act_idempotency_key: null, stage: "suggest" });
    // bindingen er ikke slettet, og eieren ser at den ikke virker
    const listed = await db.engine.listAutonomyPolicies(TENANT_A, "home");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tool_id: "make", action: "run_scenario", enabled: true, blocked_code: "action_not_bindable" });
  });

  it("definisjonen er sannheten ved utførelse: en handling som SLUTTER å være bindbar etter at den ble bundet utføres ikke lenger; kommer erklæringen tilbake, utføres den", async () => {
    const { gateway, actuator } = world();
    await bind("test_actuator", "close");
    await seedSuggest();
    const original = gateway.get("test_actuator", "close")!;
    const { autonomy_bindable: _removed, ...withoutDeclaration } = original;
    void _removed;
    gateway.register(withoutDeclaration); // erklæringen fjernet i en senere versjon
    const blocked = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(blocked).toMatchObject({ attempted: 0, skipped: 1 });
    expect(actuator.calls).toHaveLength(0);
    expect((await db.engine.listAutonomyPolicies(TENANT_A, "home"))[0]).toMatchObject({ blocked_code: "action_not_bindable" });
    gateway.register(original);
    const acted = await db.engine.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
    expect(acted).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(actuator.calls.filter((c) => c.action === "close")).toHaveLength(1);
  });

  it("dybdeforsvar i `actOn`: den autonome veien (auto-ACT-vakt) nekter en ikke-bindbar handling FØR claim og kall; en eksplisitt `actOn` uten vakt er ikke autonom og uendret", async () => {
    const { gateway, make } = world();
    const sit = await seedSuggest();
    await expect(
      db.engine.actOn(TENANT_A, "home", sit.situation_id, { tool_id: "make", action: "run_scenario", parameters: { situation_id: sit.situation_id } }, gateway, identity(TENANT_A, "home"), { autoActGuard: { max_age_seconds: 3600 } })
    ).rejects.toMatchObject({ name: "SituationActActionForbiddenError", code: "action_not_bindable" });
    expect(make.calls).toBe(0);
    expect((await db.adminPool.query("SELECT act_idempotency_key FROM situations WHERE situation_id = $1", [sit.situation_id])).rows[0]).toEqual({ act_idempotency_key: null });
    const explicit = await db.engine.actOn(TENANT_A, "home", sit.situation_id, { tool_id: "make", action: "run_scenario", parameters: { situation_id: sit.situation_id } }, gateway, identity(TENANT_A, "home"));
    expect(explicit.tool_result.ok).toBe(true);
    expect(make.calls).toBe(1);
  });

  it("simuleringen sier ærlig at en ikke-bindbar handling blokkerer autonom ACT (`action_not_bindable`), uten sideeffekt", async () => {
    const { gateway } = world();
    await insertPolicy("make", "run_scenario");
    const sit = await seedSuggest();
    const sim = new SimulationService(db.appPool, simulationToolInfoFrom(gateway), () => NOW);
    const report = await sim.simulate(TENANT_A, "home", sit.situation_id);
    const acted = report.scenarios.find((s) => s.id === "acted_at_suggest")!;
    expect(acted.blocked_by).toContain("action_not_bindable");
    expect(acted.requires_owner_approval).toBe(true);
    expect(report.caveats.join(" ")).toMatch(/autonomy_bindable/);
  });
});
