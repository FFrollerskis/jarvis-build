import { describe, expect, it } from "vitest";
import {
  DIGEST_EXCLUDED_PARAMETERS, IDEMPOTENCY_RULE_REASONS, applyIdempotencyDecisions, decideIdempotency, firstWaveTools, inferEffect, isJarvisCoreNamespace,
  type IdempotencyRuleId, type ToolDefinition, type ToolTransport
} from "../src/index.ts";

/**
 * WP-T1 K4: reglene som utleder nøkkelkravet (`idempotency`) per handling, og merkingen ved komposisjonsroten. Ren logikk, ingen database. Produksjonsregisteret (alle ~500 definisjoner) er festet i
 * `apps/api/test/wpt1-idempotency-decisions.test.ts`; her testes hver regel isolert med syntetiske definisjoner, slik at en feil regel feller en test selv om registeret skulle sammenfalle.
 */
type Probe = Pick<ToolDefinition, "tool_id" | "action" | "capability_class" | "idempotent_external">;
const probe = (tool_id: string, action: string, capability_class: ToolDefinition["capability_class"], idempotent_external: boolean): Probe => ({ tool_id, action, capability_class, idempotent_external });

describe("decideIdempotency: hver regel (første treff gjelder)", () => {
  const cases: Array<[string, Probe, "required" | "optional" | "none", IdempotencyRuleId]> = [
    ["R0 nødbryter (klasse D-unntak)", probe("owner_controls", "activate_kill_switch", "D", true), "optional", "R0_safety_switch"],
    ["R0 nødbryter, finans", probe("finance", "enable_kill_switch", "D", true), "optional", "R0_safety_switch"],
    ["R0 selvgjenoppretting", probe("owner_controls", "restore_credential", "C", true), "optional", "R0_safety_switch"],
    ["R1 klasse A", probe("calendar", "read_events", "A", true), "none", "R1_read"],
    ["R1 effekt read på klasse B", probe("situations", "resolve", "B", true), "none", "R1_read"],
    ["R2 klasse D (ekstern)", probe("docker", "redeploy_container", "D", false), "required", "R2_class_d"],
    ["R2 klasse D (Jarvis-eid, idempotent)", probe("finance", "submit_payment_intent", "D", true), "required", "R2_class_d"],
    ["R3 penger", probe("openai_images", "generate_image", "C", false), "required", "R3_money"],
    ["R3 penger, idempotent leverandør", probe("finance_wallester", "submit_card", "C", true), "required", "R3_money"],
    ["R4 utsendelse", probe("slack", "notify", "C", false), "required", "R4_outbound"],
    ["R4 utsendelse, Jarvis-eid", probe("support", "reply", "C", true), "required", "R4_outbound"],
    ["R4 utsendelse, klasse B", probe("telegram", "notify", "B", false), "required", "R4_outbound"],
    ["R5 sletting, Jarvis-eid", probe("business", "delete_lead", "C", true), "required", "R5_delete"],
    ["R5 sletting, ekstern idempotent", probe("drive", "trash", "C", true), "required", "R5_delete"],
    ["R6 ekstern skriving som ikke er idempotent", probe("calendar", "create_event", "C", false), "required", "R6_external_not_idempotent"],
    ["R6 klasse B ekstern skriving", probe("notion", "create_page", "B", false), "required", "R6_external_not_idempotent"],
    ["R7a ekstern skriving, idempotent leverandør", probe("drive", "rename", "C", true), "optional", "R7a_external_idempotent"],
    ["R7a ekstern styring (lås/tilstand), idempotent", probe("finance_wallester", "freeze_card", "B", true), "optional", "R7a_external_idempotent"],
    ["R7b Jarvis-eid intern tilstand", probe("situations", "pause_domain", "C", true), "optional", "R7b_internal_state"],
    ["R7b Jarvis-eid intern skriving som ikke er idempotent", probe("operations", "escalate_task", "C", false), "optional", "R7b_internal_state"]
  ];
  for (const [name, def, mode, rule] of cases) {
    it(`${name}: ${mode} (${rule})`, () => {
      const decision = decideIdempotency(def);
      expect({ mode: decision.mode, rule: decision.rule }).toEqual({ mode, rule });
      expect(decision.reason).toBe(IDEMPOTENCY_RULE_REASONS[rule]);
      expect(decision.reason.length).toBeGreaterThan(20);
    });
  }

  it("hver regel har en begrunnelse, og begrunnelsene er forskjellige", () => {
    const reasons = Object.values(IDEMPOTENCY_RULE_REASONS);
    expect(Object.keys(IDEMPOTENCY_RULE_REASONS)).toHaveLength(9);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("er deterministisk og avhenger kun av definisjonens fakta (samme inn = samme ut, ingen tilstand)", () => {
    const def = probe("calendar", "create_event", "C", false);
    expect(decideIdempotency(def)).toEqual(decideIdempotency({ ...def }));
    expect(inferEffect("calendar", "create_event")).toBe("write");
    expect(isJarvisCoreNamespace("situations")).toBe(true);
    expect(isJarvisCoreNamespace("calendar")).toBe(false);
  });

  it("`idempotent_external` avgjør KUN ekstern skriving/styring (R6 mot R7a); penger/utsendelse/sletting/klasse D er required uansett", () => {
    expect(decideIdempotency(probe("notion", "create_page", "B", true)).mode).toBe("optional");
    expect(decideIdempotency(probe("notion", "create_page", "B", false)).mode).toBe("required");
    expect(decideIdempotency(probe("slack", "notify", "C", true)).mode).toBe("required");
    expect(decideIdempotency(probe("drive", "trash", "C", true)).mode).toBe("required");
    expect(decideIdempotency(probe("docker", "stop_container", "D", true)).mode).toBe("required");
  });
});

describe("applyIdempotencyDecisions: merking ved komposisjonsroten", () => {
  const transport: ToolTransport = { invoke: async () => ({}) };
  const base = (over: Partial<ToolDefinition>): ToolDefinition => ({
    tool_id: "calendar", action: "create_event", description: "x", input_schema: { safeParse: () => ({ success: true }) } as never, capability_class: "C", scopes: [], reversible: true,
    rollback_procedure: "m", idempotent_external: false, timeout_ms: 1000, rate_limit_per_minute: 10, credential_ref: "X", output_trust: "internal", transport, ...over
  });

  it("setter `idempotency` fra reglene og returnerer KOPIER (originalene endres aldri)", () => {
    const original = base({});
    const [marked] = applyIdempotencyDecisions([original]);
    expect(marked?.idempotency).toBe("required");
    expect(marked).not.toBe(original);
    expect(original.idempotency).toBeUndefined();
    expect(marked?.transport).toBe(original.transport);
  });

  it("en definisjon som SELV har tatt stilling beholder sin verdi (eksplisitt stilling slår listen)", () => {
    const [none] = applyIdempotencyDecisions([base({ idempotency: "none" })]);
    const [optional] = applyIdempotencyDecisions([base({ idempotency: "optional" })]);
    expect(none?.idempotency).toBe("none");
    expect(optional?.idempotency).toBe("optional");
  });

  it("er idempotent (en ny kjøring endrer ingenting) og bevarer rekkefølgen", () => {
    const defs = [base({}), base({ tool_id: "slack", action: "notify" }), base({ tool_id: "calendar", action: "read_events", capability_class: "A" })];
    const once = applyIdempotencyDecisions(defs);
    const twice = applyIdempotencyDecisions(once);
    expect(twice.map((d) => d.idempotency)).toEqual(once.map((d) => d.idempotency));
    expect(once.map((d) => `${d.tool_id}.${d.action}`)).toEqual(["calendar.create_event", "slack.notify", "calendar.read_events"]);
    expect(once.map((d) => d.idempotency)).toEqual(["required", "required", "none"]);
  });

  it("per-definisjon-utelatelse hentes fra tabellen (kun for de navngitte handlingene), og en eksplisitt verdi på definisjonen vinner", () => {
    expect(DIGEST_EXCLUDED_PARAMETERS["owner_controls.set_connector_credential"]).toEqual(["value"]);
    expect(DIGEST_EXCLUDED_PARAMETERS["vercel.upsert_env"]).toEqual(["value"]);
    const [cred] = applyIdempotencyDecisions([base({ tool_id: "owner_controls", action: "set_connector_credential" })]);
    expect(cred?.digest_exclude_parameters).toEqual(["value"]);
    const [other] = applyIdempotencyDecisions([base({})]);
    expect("digest_exclude_parameters" in (other as object)).toBe(false);
    const [explicit] = applyIdempotencyDecisions([base({ tool_id: "owner_controls", action: "set_connector_credential", digest_exclude_parameters: ["annet"] })]);
    expect(explicit?.digest_exclude_parameters).toEqual(["annet"]);
  });

  it("`firstWaveTools()` merker ALLE returnerte definisjoner (også de som kommer inn via additionalTools)", () => {
    const extra = base({ tool_id: "extra_ext", action: "create_thing" });
    const defs = firstWaveTools({}, { additionalTools: [extra] });
    expect(defs.length).toBeGreaterThan(300);
    for (const d of defs) expect(["required", "optional", "none"], `${d.tool_id}.${d.action}`).toContain(d.idempotency);
    expect(defs.find((d) => d.tool_id === "extra_ext")?.idempotency).toBe("required");
    expect(defs.find((d) => d.tool_id === "email" && d.action === "send")?.idempotency).toBe("required");
    expect(defs.find((d) => d.tool_id === "calendar" && d.action === "read_events")?.idempotency).toBe("none");
  });
});
