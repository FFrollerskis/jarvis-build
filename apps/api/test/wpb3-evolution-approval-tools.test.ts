import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_ACTION_ALLOWED, CONTROL_CENTER_READ_TOOLS, EVOLUTION_DECISIONS, EVOLUTION_DECISION_AUDIT_TYPE, EVOLUTION_DECISION_REFUSALS, ExecutiveService, ExecutiveTransport, executiveToolDefinitions, isEvolutionDecision,
  summarizeEvolutionDecisionNo, type EvolutionDecisionInput, type EvolutionDecisionRecorder, type EvolutionDecisionResult, type ExecutiveToolOptions
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, KnowledgeSearchTransport, MODEL_SURFACE_ALLOWLIST, MemorySearchTransport, SURFACE_TOOL_GRANTS, ToolManifestViolationError, assertManifestInvariants, buildToolManifest,
  firstWaveTools, homeAssistantTools, inferEffect, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, scopeFieldsOf, selectSurfaceTools, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { EXECUTIVE_MUTATE_ACTIONS, EXECUTIVE_MUTATE_FLAGGED_ACTIONS } from "../src/server.ts";
import { STEP_UP_EXEMPT_ACTIONS, actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";

/**
 * WP-B3 (D-475, EV-23) - VERKTØYET `executive.record_evolution_decision` (eierens avgjørelse om et endringsforslag; KUN en registrering i revisjonssporet, ingen virkning):
 *  1. FLAGG: finnes kun med `evolutionApproval`; med flagget AV er verktøylisten identisk med main og ruten kjenner ikke navnet;
 *  2. KONTRAKT: klasse C, effekt control, step-up også i gatewayen, 10 kall/min, strengt skjema uten identitetsfelt, digest-bundet;
 *  3. PORT: eier + signert enhetsøkt, fail-closed uten register; step-up for alle andre veier enn en signert enhet fra en eier-kanal;
 *  4. INGEN MODELLFLATE: verken i noe nivå, på noen flate eller via utvalget - og manifestet forbyr det strukturelt (effekt control);
 *  5. TRANSPORT: identitet kun fra konteksten, fast norsk svar som alltid sier «ingen virkning», avslag med FASTE koder, ingenting uten skriver.
 */
const keyOf = "executive.record_evolution_decision";
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const authority = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const HEX = (c: string): string => c.repeat(64);
const find = (list: ToolDefinition[], action: string): ToolDefinition | undefined => list.find((d) => d.tool_id === "executive" && d.action === action);
const names = (list: ToolDefinition[]): string[] => list.map((d) => `${d.tool_id}.${d.action}`);

const defsOff = productionToolDefinitions();
const defsOn = productionToolDefinitions({ evolutionApproval: true });
const def = (): ToolDefinition => find(defsOn, "record_evolution_decision")!;

/** Hele produksjonssammensetningen (alle namespaces som har noe på en modellflate), slik at flate-/utvalgsinvariantene kan kjøres uten «tildelt men ikke registrert»-støy. */
function fullDefinitions(options: ExecutiveToolOptions = {}): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  const registry = createControlCenterRegistry({ authority });
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: registry })), { controlCenters: CONTROL_CENTER_READ_TOOLS.map((t) => t.center), ...options }),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const fullOn = fullDefinitions({ evolutionApproval: true });
const fullOff = fullDefinitions();

/** Med et register (eier-kun) slik produksjonen har det - `productionToolDefinitions` har ikke noe, og portene feiler da lukket. */
function withRegistry(registry: ReturnType<typeof createControlCenterRegistry> | null): ToolDefinition[] {
  const gw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(gw, registry ? { controlCenters: registry } : {})), { evolutionApproval: true });
}

describe("1. flagg: finnes kun med `evolutionApproval` - AV er identisk med main", () => {
  it("uten flagg (utelatt, false) er verktøyet ikke registrert, og verktøylisten er den samme", () => {
    expect(find(defsOff, "record_evolution_decision")).toBeUndefined();
    const explicitOff = productionToolDefinitions({ evolutionApproval: false });
    expect(find(explicitOff, "record_evolution_decision")).toBeUndefined();
    expect(names(explicitOff)).toEqual(names(defsOff));
  });

  it("med flagget kommer NØYAKTIG ett verktøy til - ingen andre endres", () => {
    expect(names(defsOn).filter((n) => !names(defsOff).includes(n))).toEqual([keyOf]);
    expect(names(defsOff).every((n) => names(defsOn).includes(n))).toBe(true);
  });

  it("de andre flaggstyrte handlingene påvirkes ikke og slår ikke på dette", () => {
    const others = productionToolDefinitions({ goldenSuite: true, autonomyRevoke: true });
    expect(find(others, "record_evolution_decision")).toBeUndefined();
    expect(find(others, "run_golden_suite")).toBeDefined();
    expect(find(defsOn, "run_golden_suite")).toBeUndefined();
    expect(find(defsOn, "revoke_autonomy_binding")).toBeUndefined();
  });
});

describe("2. kontrakt: klasse C, step-up i gatewayen, strengt skjema uten identitetsfelt", () => {
  it("klasse C, scope executive.control, kan «angres» ved ny registrering, 10 kall/min, step-up også på GATEWAY-nivå", () => {
    expect(def()).toMatchObject({ capability_class: "C", scopes: ["executive.control"], reversible: true, rate_limit_per_minute: 10, step_up_required: true, idempotent_external: true, output_trust: "internal" });
    expect(def().rollback_procedure).toContain("evolution.owner_decision");
    expect(def().parameterAuthorizer).toBeTypeOf("function");
  });

  it("beskrivelsen sier at det KUN er en registrering uten virkning, og at selvendring er frosset", () => {
    expect(def().description).toContain("KUN en registrering");
    expect(def().description).toContain("ingenting utføres, godkjennes i endringsregisteret eller aktiveres");
    expect(def().description).toContain("D-397");
    expect(def().description).toContain("signert enhetsøkt");
  });

  it("skjemaet har ingen identitets-/scope-felt, og godtar kun id (1-60), versjons-digest (64 små hex) og en av tre avgjørelser", () => {
    expect(scopeFieldsOf(def())).toEqual([]);
    const parse = (p: Record<string, unknown>) => def().input_schema.safeParse(p).success;
    const ok = { change_id: "forslag-1", proposal_digest: HEX("a"), decision: "approve" };
    expect(parse(ok)).toBe(true);
    for (const decision of EVOLUTION_DECISIONS) expect(parse({ ...ok, decision })).toBe(true);
    expect(parse({ ...ok, change_id: "x".repeat(60) })).toBe(true);
    const bad: Array<Record<string, unknown>> = [
      {}, { change_id: "a" }, { change_id: "a", proposal_digest: HEX("a") }, { proposal_digest: HEX("a"), decision: "approve" },
      { ...ok, change_id: "" }, { ...ok, change_id: "x".repeat(61) }, { ...ok, change_id: 5 }, { ...ok, change_id: ["a"] },
      { ...ok, proposal_digest: "abc" }, { ...ok, proposal_digest: "A".repeat(64) }, { ...ok, proposal_digest: "g".repeat(64) }, { ...ok, proposal_digest: "a".repeat(65) }, { ...ok, proposal_digest: "a".repeat(63) },
      { ...ok, decision: "execute" }, { ...ok, decision: "merge" }, { ...ok, decision: "deploy" }, { ...ok, decision: "APPROVE" }, { ...ok, decision: "" }, { ...ok, decision: 1 },
      { ...ok, tenant_id: "andre" }, { ...ok, person_id: "x" }, { ...ok, memory_space: "business" }, { ...ok, actor_person_id: "x" }, { ...ok, session_id: "s" }, { ...ok, channel: "web" },
      { ...ok, effect: "execute" }, { ...ok, activation_decision: true }, { ...ok, activate: true }, { ...ok, reason: "x" }
    ];
    for (const p of bad) expect(parse(p), JSON.stringify(p)).toBe(false);
  });

  it("avgjørelsene er nøyaktig godkjenn/avvis/utsett - ingen «utfør» finnes", () => {
    expect([...EVOLUTION_DECISIONS]).toEqual(["approve", "reject", "defer"]);
    for (const d of EVOLUTION_DECISIONS) expect(isEvolutionDecision(d)).toBe(true);
    for (const d of ["execute", "merge", "deploy", "APPROVE", "", null, undefined, 1, {}, ["approve"]]) expect(isEvolutionDecision(d)).toBe(false);
    expect(EVOLUTION_DECISION_AUDIT_TYPE).toBe("evolution.owner_decision");
  });
});

describe("3. port og step-up: eier + signert enhetsøkt, fail-closed", () => {
  const NON_OWNERS: IdentityContext[] = [
    { ...owner, person_id: "person-member" }, { ...owner, delegation_id: "deleg-1" }, { ...owner, person_id: "person-guest", memory_space_id: "guest" }, { ...owner, tenant_id: "tenant-annen" }
  ];
  const registry = createControlCenterRegistry({ authority });
  const on = (): ToolDefinition => find(withRegistry(registry), "record_evolution_decision")!;
  const params = { change_id: "p1", proposal_digest: HEX("a"), decision: "reject" } as const;

  it("eieren fra en signert enhetsøkt slipper gjennom porten", () => {
    expect(on().parameterAuthorizer?.({ ...params }, owner)).toEqual({ allowed: true, reason: "owner" });
  });

  it("alle andre (medlem, delegert, gjest, annen tenant) nektes av porten FØR noe kalles", () => {
    for (const id of NON_OWNERS) expect(on().parameterAuthorizer?.({ ...params }, id), JSON.stringify(id)).toMatchObject({ allowed: false });
  });

  it("eieren fra en passiv eller aktiv økt (ikke enhetssignert) nektes av porten", () => {
    for (const auth_strength of ["passive", "active"] as const) {
      expect(on().parameterAuthorizer?.({ ...params }, { ...owner, auth_strength }), auth_strength).toEqual({ allowed: false, reason: "control_center_requires_signed_device_session" });
    }
  });

  it("uten register (eier-sjekken er ikke koblet inn) feiler porten LUKKET - også for eieren", () => {
    const bare = find(withRegistry(null), "record_evolution_decision")!;
    expect(bare.parameterAuthorizer?.({ ...params }, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
  });

  it("step-up kreves: ikke unntatt, signert enhet fra en eier-kanal, og tale/Telegram/system nektes av ruten", () => {
    expect(STEP_UP_EXEMPT_ACTIONS.has("record_evolution_decision")).toBe(false);
    expect(actionRequiresStepUp("record_evolution_decision")).toBe(true);
    expect(stepUpDenial({ auth_strength: "signed", channel: "web" }, "record_evolution_decision")).toBeUndefined();
    for (const channel of ["telegram", "voice", "system"] as const) expect(stepUpDenial({ auth_strength: "signed", channel }, "record_evolution_decision"), channel).toBeDefined();
    for (const auth_strength of ["passive", "active"] as const) expect(stepUpDenial({ auth_strength, channel: "web" }, "record_evolution_decision"), auth_strength).toBeDefined();
  });
});

describe("4. ruten: kjent kun som flaggstyrt navn, og kontrakten speiler det", () => {
  it("står i den FLAGGSTYRTE listen - ikke i main sin allowliste på 13 - og i knappenes tillatelsestabell", () => {
    expect(EXECUTIVE_MUTATE_ACTIONS as readonly string[]).not.toContain("record_evolution_decision");
    expect(EXECUTIVE_MUTATE_FLAGGED_ACTIONS as readonly string[]).toContain("record_evolution_decision");
    expect(CONTROL_ACTION_ALLOWED["/executive/mutate"]).toContain("record_evolution_decision");
  });
});

describe("5. INGEN modellflate: ingen flate, ingen nivå, ikke utvalgbart - og manifestet forbyr det strukturelt", () => {
  it("står på ingen flate (surfaces er tom) og i ingen modellnivå, med flagget PÅ", () => {
    const manifest = buildToolManifest(defsOn);
    expect(manifest.get(keyOf)?.surfaces).toEqual([]);
    for (const tier of [CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, CHAT_ACT_TIER, CHAT_DELEGATE_TIER]) expect(tier.some((g) => `${g.tool_id}.${g.action}` === keyOf)).toBe(false);
    for (const surface of Object.keys(SURFACE_TOOL_GRANTS) as Array<keyof typeof SURFACE_TOOL_GRANTS>) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === keyOf), surface).toBe(false);
  });

  it("effekten er `control` (navneinferens ville gitt `write`) - klasse C, med dokumentert gjenoppretting", () => {
    expect(inferEffect("executive", "record_evolution_decision")).toBe("control");
    expect(buildToolManifest(defsOn).get(keyOf)).toMatchObject({ risk: "C", effect: "control", cost: "free", output_trust: "internal", recovery: "documented", scope_fields: [] });
  });

  it("manifestinvariantene holder med flagget på, og HVIS verktøyet noen gang ble gitt en modellflate ville de feilet (control kan aldri stå på en modellflate)", () => {
    for (const list of [fullOff, fullOn]) expect(() => assertManifestInvariants(buildToolManifest(list))).not.toThrow();
    const manifest = buildToolManifest(fullOn);
    const entry = manifest.get(keyOf)!;
    const tampered = new Map(manifest);
    tampered.set(keyOf, { ...entry, surfaces: ["web_chat"] });
    expect(() => assertManifestInvariants(tampered)).toThrow(ToolManifestViolationError);
    expect(() => assertManifestInvariants(tampered)).toThrow(/pay\/control kan aldri stå på en modellflate/);
  });

  it("ingen melding - uansett ordlyd eller flate - velger verktøyet, og det finnes ikke på modellens verktøyflate", () => {
    const gw = { list: () => fullOn } as unknown as ToolGateway;
    const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });
    expect(surface.some((s) => `${s.tool_id}.${s.action}` === keyOf)).toBe(false);
    const messages = [
      "godkjenn forslaget", "registrer godkjenning av endringsforslaget", "godkjenn endringsforslag p1", "avvis endringsforslaget", "utsett forslaget", "approve the change proposal", "record_evolution_decision",
      "executive.record_evolution_decision", "vis evolusjonssenteret", "hva venter på min avgjørelse", "godkjenn alt", "aktiver evolusjon"
    ];
    for (const message of messages) {
      for (const s of ["web_chat", "voice", "telegram", "background"] as const) {
        const keys = selectSurfaceTools(s, message, surface).selected.map((m) => `${m.tool_id}.${m.action}`);
        expect(keys, `${s}: ${message}`).not.toContain(keyOf);
      }
    }
  });
});

describe("6. transporten: identitet kun fra konteksten, fast svar, FASTE avslagskoder, ingenting uten skriver", () => {
  const result = (over: Partial<EvolutionDecisionResult> = {}): EvolutionDecisionResult => ({
    outcome: "recorded", decision: "approve", change_id: "p1", proposal_digest: HEX("a"), previous_decision: null, effect: "none", activation_decision: false, ...over
  });
  function transportWith(recorder?: EvolutionDecisionRecorder): ExecutiveTransport {
    const registry = createControlCenterRegistry({ authority });
    const gw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    return new ExecutiveTransport(new ExecutiveService(gw, { controlCenters: registry, ...(recorder ? { evolutionDecisions: recorder } : {}) }));
  }
  const run = (t: ExecutiveTransport, parameters: Record<string, unknown>) => t.invoke("record_evolution_decision", parameters as never, "cred", { identity: owner } as never);
  const ok = { change_id: "p1", proposal_digest: HEX("a"), decision: "approve" };

  it("kaller skriveren med den UENDREDE identiteten fra konteksten og kun de tre feltene - aldri tenant/person/rom fra parametre", async () => {
    const calls: Array<{ identity: IdentityContext; input: EvolutionDecisionInput }> = [];
    const t = transportWith({ record: async (identity, input) => { calls.push({ identity, input }); return result(); } });
    await run(t, { ...ok, tenant_id: "andre", person_id: "x", memory_space: "business", actor_person_id: "y" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.identity).toBe(owner);
    expect(calls[0]?.input).toEqual({ change_id: "p1", proposal_digest: HEX("a"), decision: "approve" });
  });

  it("svaret har `summary_no` FØRST, og resultatet sier effect «none» og activation_decision false; `external_id` er id + de 12 første tegnene av versjonen", async () => {
    const out = await run(transportWith({ record: async () => result() }), ok);
    expect(out.external_id).toBe(`p1:${"a".repeat(12)}`);
    const data = out.data as unknown as Record<string, unknown>;
    expect(Object.keys(data)[0]).toBe("summary_no");
    expect(data).toMatchObject({ outcome: "recorded", decision: "approve", change_id: "p1", previous_decision: null, effect: "none", activation_decision: false });
    expect(String(data["summary_no"])).toContain("INGEN virkning");
  });

  it("den faste norske teksten sier alltid at ingenting utføres - for registrert, allerede registrert og overstyrt avgjørelse - og ordene er riktige", () => {
    for (const decision of EVOLUTION_DECISIONS) {
      const label = { approve: "godkjent", reject: "avvist", defer: "utsatt" }[decision];
      for (const outcome of ["recorded", "already_recorded"] as const) {
        for (const previous of [null, "reject"] as const) {
          const text = summarizeEvolutionDecisionNo(result({ decision, outcome, previous_decision: previous }));
          expect(text, `${decision}/${outcome}/${previous}`).toContain(`«${label}»`);
          expect(text).toContain("INGEN virkning");
          expect(text).toContain("selvendring er frosset, D-397");
          expect(text).toContain("p1");
        }
      }
    }
    expect(summarizeEvolutionDecisionNo(result({ previous_decision: "reject" }))).toContain("den overstyrer din forrige avgjørelse «avvist»");
    expect(summarizeEvolutionDecisionNo(result({ outcome: "already_recorded" }))).toContain("ingenting ble skrevet på nytt");
  });

  it("ugyldig avgjørelse avvises FØR skriveren kalles (fast kode); manglende id/versjon avvises som manglende parameter", async () => {
    let called = 0;
    const t = transportWith({ record: async () => { called += 1; return result(); } });
    for (const decision of ["execute", "APPROVE", "", 5, null, undefined]) await expect(run(t, { ...ok, decision }), String(decision)).rejects.toThrow("invalid_evolution_decision_input");
    await expect(run(t, { proposal_digest: HEX("a"), decision: "approve" })).rejects.toThrow("missing_parameter:change_id");
    await expect(run(t, { change_id: "p1", decision: "approve" })).rejects.toThrow("missing_parameter:proposal_digest");
    await expect(run(t, { ...ok, change_id: "" })).rejects.toThrow("missing_parameter:change_id");
    expect(called).toBe(0);
  });

  it("uten skriver (flagget AV) feiler handlingen lukket med en fast kode - selv om verktøyet skulle bli registrert", async () => {
    await expect(run(transportWith(), ok)).rejects.toThrow("evolution_decisions_not_configured");
  });

  it("skriverens avslag forplanter seg med SAMME faste kode - og alle kodene er i den lukkede listen", async () => {
    for (const code of EVOLUTION_DECISION_REFUSALS) {
      const t = transportWith({ record: async () => { throw new Error(code); } });
      await expect(run(t, ok), code).rejects.toThrow(code);
    }
    expect([...EVOLUTION_DECISION_REFUSALS].sort()).toEqual([
      "decision_record_failed", "evolution_decision_model_origin_denied", "evolution_decisions_not_configured", "invalid_evolution_decision_input", "proposal_class_forbidden", "proposal_digest_mismatch", "proposal_not_found", "proposal_not_open"
    ]);
  });

  it("L2 (gjennomgang) DYBDEFORSVAR: en modellbetjent tur (`servingModel` satt - sky ELLER lokal) kan ALDRI registrere eierens avgjørelse; skriveren kalles aldri, med en fast kode - kun siden (ingen modell) slipper gjennom", async () => {
    let called = 0;
    const t = transportWith({ record: async () => { called += 1; return result(); } });
    const withModel = (servingModel: { provider: string; model: string } | undefined) => t.invoke("record_evolution_decision", ok as never, "cred", { identity: owner, ...(servingModel ? { servingModel } : {}) } as never);
    for (const model of [{ provider: "anthropic", model: "claude-test" }, { provider: "gemma_local", model: "gemma-local" }, { provider: "", model: "" }, { provider: "ukjent-leverandor", model: "x" }]) {
      await expect(withModel(model), JSON.stringify(model)).rejects.toThrow("evolution_decision_model_origin_denied");
    }
    expect(called).toBe(0);
    // modellopphavet avvises FØR noe annet (selv ved ugyldig input), så ingenting om forslaget eller skriveren når en modell
    await expect(t.invoke("record_evolution_decision", { change_id: "finnes-ikke", proposal_digest: "x", decision: "execute" } as never, "cred", { identity: owner, servingModel: { provider: "anthropic", model: "m" } } as never)).rejects.toThrow("evolution_decision_model_origin_denied");
    expect(called).toBe(0);
    await withModel(undefined); // siden: ingen modell i løkka
    expect(called).toBe(1);
    expect((EVOLUTION_DECISION_REFUSALS as readonly string[]).includes("evolution_decision_model_origin_denied")).toBe(true);
  });

  it("DYBDEFORSVAR: tjenesten håndhever SELV eier + signert enhetsøkt + step-up (uavhengig av verktøydefinisjonens port) - skriveren kalles aldri for andre, med faste koder", async () => {
    let called = 0;
    const t = transportWith({ record: async () => { called += 1; return result(); } });
    const call = (identity: IdentityContext) => t.invoke("record_evolution_decision", ok as never, "cred", { identity } as never);
    for (const identity of [{ ...owner, person_id: "person-member" }, { ...owner, delegation_id: "deleg-1" }, { ...owner, tenant_id: "tenant-annen" }, { ...owner, person_id: "person-guest", memory_space_id: "guest" as const }]) {
      await expect(call(identity), JSON.stringify(identity)).rejects.toThrow("control_center_owner_only");
    }
    for (const auth_strength of ["passive", "active"] as const) await expect(call({ ...owner, auth_strength }), auth_strength).rejects.toThrow("control_center_requires_signed_device_session");
    for (const channel of ["telegram", "voice", "system"] as const) await expect(call({ ...owner, channel }), channel).rejects.toThrow(`step_up_required:channel_${channel}_not_allowed`);
    expect(called).toBe(0);
    // uten register er også eieren avvist (fail-closed)
    const gw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
    const bare = new ExecutiveTransport(new ExecutiveService(gw, { evolutionDecisions: { record: async () => { called += 1; return result(); } } }));
    await expect(bare.invoke("record_evolution_decision", ok as never, "cred", { identity: owner } as never)).rejects.toThrow("control_center_owner_check_not_configured");
    expect(called).toBe(0);
    // eieren fra en signert enhet på en eier-kanal slipper gjennom
    await call(owner);
    await call({ ...owner, channel: "desktop" });
    expect(called).toBe(2);
  });

  it("uten invocation-context feiler transporten lukket (som alle executive-handlinger)", async () => {
    await expect(transportWith({ record: async () => result() }).invoke("record_evolution_decision", ok as never, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});
