import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_ACTION_ALLOWED, CONTROL_CENTER_READ_ACTIONS, CONTROL_CENTER_READ_TOOLS, ControlCenterRegistry, ExecutiveService, ExecutiveTransport, controlCenterForReadAction, controlItem, controlSection,
  executiveToolDefinitions, type ControlCenterDefinition, type ControlCenterId, type ControlCenterReport, type GoldenSuiteControl, type GoldenSuiteRunResult
} from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import {
  CHAT_ACT_TIER, CHAT_DELEGATE_TIER, CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, MemorySearchTransport, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants, buildToolManifest, inferEffect,
  KnowledgeSearchTransport, financeToolIntent, firstWaveTools, homeAssistantTools, knowledgeToolDefinitions, memoryToolDefinitions, resolveModelToolSurface, scopeFieldsOf, selectSurfaceTools,
  type ToolDefinition, type ToolGateway, type ToolResult
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { createControlCenterRegistry } from "../src/control-center/register.ts";
import { CONTROL_CENTER_FLAGS, activeRestrictedControlTools, financeIntentOptions } from "../src/control-center/shared.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { EXECUTIVE_MUTATE_ACTIONS, EXECUTIVE_MUTATE_FLAGGED_ACTIONS } from "../src/server.ts";
import { STEP_UP_EXEMPT_ACTIONS, actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";

/**
 * WP-H2: de fire nye per-senter lese-verktøyene (`get_operations_center`, `get_value_center`, `get_privacy_center`, `get_security_center`) og de to FLAGGSTYRTE executive-handlingene
 * `run_golden_suite` (klasse A, lesende selvtest) og `revoke_autonomy_binding` (klasse C, eier-kun, step-up). Hele verktøytabellen (7) og de generelle reglene er låst av wph1-control-tools.test.ts (den går over
 * `CONTROL_CENTER_READ_TOOLS`); her låses det som er NYTT: tabellen, sensitivitet, utvalg per melding, de to flaggstyrte verktøyene (registrering, port, step-up, kontrakt) og transportens oppførsel.
 */
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const keyOf = (action: string): string => `executive.${action}`;
const H2_ACTIONS = ["get_operations_center", "get_value_center", "get_privacy_center", "get_security_center"] as const;
const ownerOnly = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
/** Gjennomgang M1: per-senter-verktøyene registreres kun for sentre med flagg på (`controlCentersWithTools` i main.ts) - disse testene har alle sju sentrene på; de to funksjonsflaggene styres av `options`. */
const ALL_CENTERS: ControlCenterId[] = CONTROL_CENTER_READ_TOOLS.map((t) => t.center);

/** De reelle definisjonene produksjonen registrerer (samme sammensetning som wph1-control-tools.test.ts), med de to flaggstyrte executive-handlingene av/på. */
function productionDefinitions(options: Parameters<typeof executiveToolDefinitions>[1] = {}): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, { controlCenters: ownerOnly })), { controlCenters: ALL_CENTERS, ...options }),
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
const defsOff = productionDefinitions();
const defsOn = productionDefinitions({ goldenSuite: true, autonomyRevoke: true });
const find = (list: ToolDefinition[], action: string): ToolDefinition | undefined => list.find((d) => d.tool_id === "executive" && d.action === action);

/** `registry: null` = ingen register i tjenesten (fail-closed-sjekken); utelatt = eier-registeret. (`undefined` ville falt tilbake til standardverdien.) */
function withRegistry(options: Parameters<typeof executiveToolDefinitions>[1] = {}, registry: ControlCenterRegistry | null = ownerOnly): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw, registry ? { controlCenters: registry } : {})), { controlCenters: ALL_CENTERS, ...options });
}

describe("tabellen: syv verktøy, de fire nye bakerst", () => {
  it("rekkefølge og navn er stabile (legg til, aldri omdøp), og hvert verktøy er knyttet til sitt eget senter", () => {
    // WP-B3 (D-475) la til `get_evolution_center` (tilleggssenter) sist; de syv første er uendret.
    expect(CONTROL_CENTER_READ_TOOLS.map((t) => t.action)).toEqual(["get_finance_center", "get_memory_center", "get_agent_center", ...H2_ACTIONS, "get_evolution_center"]);
    expect(CONTROL_CENTER_READ_TOOLS.slice(3, 7).map((t) => t.center)).toEqual(["operations", "value", "privacy", "security"]);
    for (const a of H2_ACTIONS) expect(controlCenterForReadAction(a)).toBe(a.replace(/^get_/, "").replace(/_center$/, ""));
    expect(controlCenterForReadAction("get_evolution_center")).toBe("evolution");
    expect(CONTROL_CENTER_READ_ACTIONS.size).toBe(8);
  });

  it("alle ti sentre er nå dekket: H0-sentrene (integration, authority, ai) har ikke et eget verktøy, de syv andre har", () => {
    const covered = new Set<ControlCenterId>(CONTROL_CENTER_READ_TOOLS.map((t) => t.center));
    // + tilleggssenteret Evolusjon (D-475), som ikke teller blant masterplanens ti
    expect([...covered].sort()).toEqual(["agent", "evolution", "finance", "memory", "operations", "privacy", "security", "value"]);
  });

  it("beskrivelsene for de nye sier kun lesing, eier + signert enhet, ukjent er ukjent - og nevner det de ikke måler", () => {
    for (const a of H2_ACTIONS) {
      const d = find(defsOff, a)!.description;
      expect(d, a).toContain("KUN lesing");
      expect(d, a).toMatch(/Kun eieren får svar, og kun fra en signert enhetsøkt/);
    }
    expect(find(defsOff, "get_operations_center")!.description).toMatch(/diskplass|oppetid-prosent/);
    expect(find(defsOff, "get_value_center")!.description).toMatch(/IKKE målt/);
    expect(find(defsOff, "get_privacy_center")!.description).toMatch(/ikke en juridisk vurdering/);
    expect(find(defsOff, "get_security_center")!.description).toMatch(/Aldri innhold eller hemmeligheter/);
  });
});

describe("manifest og modellflate for de fire nye", () => {
  it("sensitivitet: Drift, Personvern og Sikkerhet er `private` (eierens konfigurasjonsmetadata); Finans og Verdi er `restricted` (gjennomgang M2: Verdi viser AI-kostnad i øre - strengeste regel inntil eieren har avgjort noe annet)", () => {
    const manifest = buildToolManifest(defsOff);
    for (const a of ["get_operations_center", "get_privacy_center", "get_security_center"]) expect(manifest.get(keyOf(a))?.sensitivity, a).toBe("private");
    for (const a of ["get_finance_center", "get_value_center"]) expect(manifest.get(keyOf(a))?.sensitivity, a).toBe("restricted");
  });

  it("står kun på web_chat (lese-nivået), aldri på tale/Telegram/bakgrunn/koding og ikke i det minimale, handlings- eller delegeringsnivået", () => {
    const manifest = buildToolManifest(defsOff);
    for (const a of H2_ACTIONS) {
      expect(manifest.get(keyOf(a))?.surfaces, a).toEqual(["web_chat"]);
      expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === keyOf(a)), a).toHaveLength(1);
      for (const tier of [MODEL_SURFACE_ALLOWLIST, CHAT_ACT_TIER, CHAT_DELEGATE_TIER]) expect(tier.some((g) => `${g.tool_id}.${g.action}` === keyOf(a)), a).toBe(false);
      for (const surface of ["voice", "telegram", "background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === keyOf(a)), `${surface}/${a}`).toBe(false);
    }
  });

  it("de to flaggstyrte handlingene står på INGEN modellflate og ikke i noe nivå", () => {
    const manifest = buildToolManifest(defsOn);
    for (const a of ["run_golden_suite", "revoke_autonomy_binding"]) {
      expect(manifest.get(keyOf(a))?.surfaces, a).toEqual([]);
      for (const tier of [CHAT_READ_TIER, MODEL_SURFACE_ALLOWLIST, CHAT_ACT_TIER, CHAT_DELEGATE_TIER]) expect(tier.some((g) => `${g.tool_id}.${g.action}` === keyOf(a)), a).toBe(false);
      for (const surface of Object.keys(SURFACE_TOOL_GRANTS) as Array<keyof typeof SURFACE_TOOL_GRANTS>) expect(SURFACE_TOOL_GRANTS[surface].some((g) => `${g.tool_id}.${g.action}` === keyOf(a)), `${surface}/${a}`).toBe(false);
    }
  });

  it("boot-invariantene holder både med flaggene AV og PÅ", () => {
    for (const list of [defsOff, defsOn]) {
      const gw = { list: () => list } as unknown as ToolGateway;
      expect(() => assertManifestInvariants(buildToolManifest(list))).not.toThrow();
      expect(() => assertChatReadTier(gw)).not.toThrow();
      expect(() => resolveModelToolSurface(gw, { includeChatReadTier: true })).not.toThrow();
    }
  });
});

describe("utvalg per melding", () => {
  const gw = { list: () => defsOff } as unknown as ToolGateway;
  const surface = resolveModelToolSurface(gw, { includeChatReadTier: true });
  const picked = (text: string, s: "web_chat" | "voice" = "web_chat") => selectSurfaceTools(s, text, surface);
  const keys = (text: string, s: "web_chat" | "voice" = "web_chat") => picked(text, s).selected.map((m) => `${m.tool_id}.${m.action}`);

  it("eksplisitte senterspørsmål gir det aktuelle verktøyet - og kun det senteret", () => {
    expect(keys("vis driftssenteret")).toContain(keyOf("get_operations_center"));
    expect(keys("hvordan står det til med backup-status")).toContain(keyOf("get_operations_center"));
    expect(keys("når var siste restore-test")).toContain(keyOf("get_operations_center"));
    expect(keys("vis verdisenteret")).toContain(keyOf("get_value_center"));
    expect(keys("hvor mye spart tid har jeg")).toContain(keyOf("get_value_center"));
    expect(keys("vis personvernsenteret")).toContain(keyOf("get_privacy_center"));
    expect(keys("hva er status på dpia")).toContain(keyOf("get_privacy_center"));
    expect(keys("vis behandlingsoversikten")).toContain(keyOf("get_privacy_center"));
    expect(keys("vis sikkerhetssenteret")).toContain(keyOf("get_security_center"));
    expect(keys("kjør selvtest av golden-suite")).toContain(keyOf("get_security_center"));
    expect(keys("vis revisjonsloggen")).toContain(keyOf("get_security_center"));
    expect(keys("vis driftssenteret")).not.toContain(keyOf("get_security_center"));
    expect(keys("vis sikkerhetssenteret")).not.toContain(keyOf("get_operations_center"));
  });

  it("«driftsstatus» og «status på driften» går fortsatt til infra-statusen (E1) - ikke til Drift-senteret (ingen dobbeltvalg)", () => {
    for (const msg of ["hva er driftsstatus", "hva er status på driften"]) {
      expect(keys(msg), msg).toContain("executive.get_infra_status");
      expect(keys(msg), msg).not.toContain(keyOf("get_operations_center"));
    }
  });

  it("småprat og urelaterte meldinger får ingen av de fire; kun Verdi (som Finans) låser turen lokalt (SECRET_RESTRICTED) - Drift, Personvern og Sikkerhet gjør det ikke", () => {
    for (const msg of ["hei", "hva er klokka", "snakk om været", "hvem er kunden min", "hva husker du om meg"]) for (const a of H2_ACTIONS) expect(keys(msg), `${msg} → ${a}`).not.toContain(keyOf(a));
    for (const msg of ["vis driftssenteret", "vis personvernsenteret", "vis sikkerhetssenteret"]) expect(picked(msg).min_sensitivity, msg).toBeUndefined();
    for (const msg of ["vis verdisenteret", "hvor mye spart tid har jeg", "hva er bruksfrekvens"]) expect(picked(msg).min_sensitivity, msg).toBe("SECRET_RESTRICTED");
  });

  it("en stemmeflate får aldri noen av dem, uansett hva som sies", () => {
    for (const msg of ["vis driftssenteret", "vis verdisenteret", "vis personvernsenteret", "vis sikkerhetssenteret"]) for (const a of H2_ACTIONS) expect(keys(msg, "voice"), `${msg} → ${a}`).not.toContain(keyOf(a));
  });
});

describe("de to flaggstyrte executive-handlingene: finnes kun med flagg", () => {
  it("AV (standard): verken `run_golden_suite` eller `revoke_autonomy_binding` er registrert - H0/H1-verktøylisten er uendret", () => {
    for (const list of [defsOff, withRegistry(), withRegistry({})]) {
      expect(find(list, "run_golden_suite")).toBeUndefined();
      expect(find(list, "revoke_autonomy_binding")).toBeUndefined();
    }
    expect(find(withRegistry({ goldenSuite: false, autonomyRevoke: false }), "run_golden_suite")).toBeUndefined();
    expect(withRegistry({ goldenSuite: false, autonomyRevoke: false }).map((d) => d.action)).toEqual(withRegistry().map((d) => d.action));
  });

  it("hvert flagg slår på KUN sin handling", () => {
    const golden = withRegistry({ goldenSuite: true });
    expect(find(golden, "run_golden_suite")).toBeDefined();
    expect(find(golden, "revoke_autonomy_binding")).toBeUndefined();
    const revoke = withRegistry({ autonomyRevoke: true });
    expect(find(revoke, "revoke_autonomy_binding")).toBeDefined();
    expect(find(revoke, "run_golden_suite")).toBeUndefined();
  });

  it("run_golden_suite: klasse A, effekt read, parameterløst strengt skjema, 6 kall/min, uten identitetsfelt", () => {
    const def = find(defsOn, "run_golden_suite")!;
    expect(def).toMatchObject({ capability_class: "A", reversible: true, rate_limit_per_minute: 6 });
    expect(inferEffect("executive", "run_golden_suite")).toBe("read");
    expect(scopeFieldsOf(def)).toEqual([]);
    const parse = (p: Record<string, unknown>) => def.input_schema.safeParse(p).success;
    expect(parse({})).toBe(true);
    for (const bad of [{ center: "security" }, { tenant_id: "t" }, { person_id: "p" }, { extra: 1 }, { model: "claude" }]) expect(parse(bad), JSON.stringify(bad)).toBe(false);
    expect(def.description).toMatch(/Ingen modell kalles, ingenting skrives/);
  });

  it("revoke_autonomy_binding: klasse C, effekt control, KAN IKKE ANGRES, step-up i gatewayen, kun `domain` (1-100 tegn) uten identitetsfelt, 30 kall/min", () => {
    const def = find(defsOn, "revoke_autonomy_binding")!;
    expect(def).toMatchObject({ capability_class: "C", reversible: false, rate_limit_per_minute: 30, step_up_required: true }); // L1: step-up også på gateway-nivå
    expect(inferEffect("executive", "revoke_autonomy_binding")).toBe("control");
    expect(scopeFieldsOf(def)).toEqual([]);
    const parse = (p: Record<string, unknown>) => def.input_schema.safeParse(p).success;
    expect(parse({ domain: "pipeline" })).toBe(true);
    for (const bad of [{}, { domain: "" }, { domain: "x".repeat(101) }, { domain: 5 }, { domain: "p", tenant_id: "andre" }, { domain: "p", actor_person_id: "x" }, { domain: "p", memory_space: "business" }, { domain: "p", tool_id: "t" }, { domains: ["a"] }]) {
      expect(parse(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(def.rollback_procedure).toMatch(/autonomy_binding\.revoke_requested/); // før-bildet i revisjonsraden (L1)
  });

  it("portene: golden-suite = eier + signert økt (som kontrollsentrene), tilbakekall = eier - og begge er FAIL-CLOSED uten register", () => {
    const golden = find(defsOn, "run_golden_suite")!;
    const revoke = find(defsOn, "revoke_autonomy_binding")!;
    const bare = withRegistry({ goldenSuite: true, autonomyRevoke: true }, null);
    const NON_OWNERS: IdentityContext[] = [
      { ...owner, person_id: "person-member" }, { ...owner, delegation_id: "deleg-1" }, { ...owner, person_id: "person-guest", memory_space_id: "guest" }, { ...owner, tenant_id: "tenant-annen" }
    ];
    // withRegistry-listene bruker `ownerOnly`; productionToolDefinitions bruker et register uten eier - bruk derfor withRegistry for det som skal slippe gjennom
    const withOwner = withRegistry({ goldenSuite: true, autonomyRevoke: true });
    expect(find(withOwner, "run_golden_suite")!.parameterAuthorizer?.({}, owner)).toEqual({ allowed: true, reason: "owner" });
    expect(find(withOwner, "revoke_autonomy_binding")!.parameterAuthorizer?.({ domain: "pipeline" }, owner)?.allowed).toBe(true);
    for (const id of NON_OWNERS) {
      expect(find(withOwner, "run_golden_suite")!.parameterAuthorizer?.({}, id)).toEqual({ allowed: false, reason: "control_center_owner_only" });
      expect(find(withOwner, "revoke_autonomy_binding")!.parameterAuthorizer?.({ domain: "pipeline" }, id)).toMatchObject({ allowed: false });
    }
    for (const auth_strength of ["passive", "active"] as const) {
      expect(find(withOwner, "run_golden_suite")!.parameterAuthorizer?.({}, { ...owner, auth_strength })).toEqual({ allowed: false, reason: "control_center_requires_signed_device_session" });
    }
    expect(find(bare, "run_golden_suite")!.parameterAuthorizer?.({}, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
    expect(find(bare, "revoke_autonomy_binding")!.parameterAuthorizer?.({ domain: "pipeline" }, owner)).toEqual({ allowed: false, reason: "control_center_owner_check_not_configured" });
    void golden; void revoke;
  });
});

describe("kontrakten: ruten, allowlisten og step-up", () => {
  it("de to nye handlingene står i den FLAGGSTYRTE listen (ikke i main sin allowliste på 13), og kontraktens allowlist speiler rutens kjente navn NØYAKTIG (13 + 2 = 15)", () => {
    expect(EXECUTIVE_MUTATE_ACTIONS).toHaveLength(13);
    expect([...EXECUTIVE_MUTATE_FLAGGED_ACTIONS].sort()).toEqual(["revoke_autonomy_binding", "run_golden_suite"]);
    expect([...EXECUTIVE_MUTATE_ACTIONS, ...EXECUTIVE_MUTATE_FLAGGED_ACTIONS].sort()).toEqual([...(CONTROL_ACTION_ALLOWED["/executive/mutate"] ?? [])].sort());
    for (const a of EXECUTIVE_MUTATE_FLAGGED_ACTIONS) expect(EXECUTIVE_MUTATE_ACTIONS as readonly string[]).not.toContain(a);
  });

  it("begge KREVER step-up (signert enhet fra en eier-kanal): ikke unntatt, og passiv/Telegram/tale nektes av ruten", () => {
    for (const a of ["revoke_autonomy_binding", "run_golden_suite"]) {
      expect(STEP_UP_EXEMPT_ACTIONS.has(a), a).toBe(false);
      expect(actionRequiresStepUp(a), a).toBe(true);
      expect(stepUpDenial({ auth_strength: "signed", channel: "web" }, a), a).toBeUndefined();
      for (const channel of ["telegram", "voice", "system"] as const) expect(stepUpDenial({ auth_strength: "signed", channel }, a), `${a}/${channel}`).toBeDefined();
      for (const auth_strength of ["passive", "active"] as const) expect(stepUpDenial({ auth_strength, channel: "web" }, a), `${a}/${auth_strength}`).toBeDefined();
    }
  });

  it("run_golden_suite er den ENESTE lesende (klasse A) handlingen i mutasjonslisten; alle andre er B, C eller D", () => {
    const classOf = (action: string): string => find(defsOn, action)!.capability_class;
    const readOnes = [...EXECUTIVE_MUTATE_ACTIONS, ...EXECUTIVE_MUTATE_FLAGGED_ACTIONS].filter((a) => classOf(a) === "A");
    expect(readOnes).toEqual(["run_golden_suite"]);
    expect(classOf("revoke_autonomy_binding")).toBe("C");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Transportens oppførsel
// ---------------------------------------------------------------------------------------------------------------------
const result = (over: Partial<GoldenSuiteRunResult> = {}): GoldenSuiteRunResult => ({
  ran_at: "2026-11-14T10:00:00.000Z", duration_ms: 50, suite_id: "jarvis-golden", suite_version: 1, suite_digest: "a".repeat(64), result_digest: "b".repeat(64), total: 40, ran: 40, passed: 40, failed: [],
  skipped: [], red_team: [], hard_stop: false, uncovered: [], surface_available: true, model_calls: 0, ...over
});

function transportWith(opts: {
  golden?: GoldenSuiteControl; centers?: ControlCenterDefinition[]; servedLocally?: (model: { provider: string; model: string }) => boolean; noAudit?: boolean;
  execute?: (req: { tool_id: string; action: string; parameters: Record<string, unknown>; identity: IdentityContext }) => Promise<ToolResult>;
} = {}) {
  const registry = createControlCenterRegistry({ authority: { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] } });
  for (const c of opts.centers ?? []) registry.register(c);
  const calls: Array<{ tool_id: string; action: string; parameters: Record<string, unknown>; identity: IdentityContext }> = [];
  const audits: Array<{ type: string; tool_id: string; action: string; payload: Record<string, unknown> }> = [];
  const gw = {
    list: () => [], health: new Map(), hasSecret: async () => true,
    execute: async (req: { tool_id: string; action: string; parameters: Record<string, unknown>; identity: IdentityContext }) => {
      calls.push(req);
      if (opts.execute) return opts.execute(req);
      // L1: tilbakekallet leser FØRST før-bildet (`list_autonomy_policies`), skriver revisjonsraden og sletter så (`clear_autonomy_policy`)
      return (req.action === "list_autonomy_policies" ? { ok: true, data: [] } : { ok: true, data: { removed: true } }) as unknown as ToolResult;
    }
  } as unknown as ToolGateway;
  const autonomyAudit = async (_identity: IdentityContext, entry: { type: string; tool_id: string; action: string; payload: Record<string, unknown> }): Promise<void> => { audits.push(entry); };
  const service = new ExecutiveService(gw, {
    controlCenters: registry, ...(opts.golden ? { goldenSuite: opts.golden } : {}), ...(opts.servedLocally ? { servedLocally: opts.servedLocally } : {}), ...(opts.noAudit === true ? {} : { autonomyAudit })
  });
  return { transport: new ExecutiveTransport(service), calls, audits };
}
const run = (t: ExecutiveTransport, action: string, params: Record<string, string> = {}) => t.invoke(action, params, "cred", { identity: owner } as never);

describe("transporten: run_golden_suite", () => {
  it("kjører kjøreren og svarer med en kort norsk oppsummering først og hele resultatet (digester, ingen modellkall)", async () => {
    let runs = 0;
    const { transport } = transportWith({ golden: { run: async () => { runs += 1; return result({ passed: 39, failed: ["radar-merge-deploy"] }); }, last: () => null } });
    const out = (await run(transport, "run_golden_suite")).data as unknown as { summary_no: string; result: GoldenSuiteRunResult };
    expect(runs).toBe(1);
    expect(Object.keys(out)).toEqual(["summary_no", "result"]);
    expect(out.summary_no).toContain("39 av 40");
    expect(out.summary_no).toContain("1 IKKE bestått");
    expect(out.summary_no).toContain("Ingen modellkall");
    expect(out.result).toMatchObject({ suite_digest: "a".repeat(64), result_digest: "b".repeat(64), model_calls: 0 });
  });

  it("uten kjører (flagget AV) avvises handlingen lukket - selv om verktøyet skulle bli registrert", async () => {
    await expect(run(transportWith().transport, "run_golden_suite")).rejects.toThrow("golden_suite_not_configured");
  });

  it("uten invocation-context feiler transporten lukket (som alle executive-handlinger)", async () => {
    await expect(transportWith({ golden: { run: async () => result(), last: () => null } }).transport.invoke("run_golden_suite", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});

describe("transporten: revoke_autonomy_binding", () => {
  it("sletter via situations.clear_autonomy_policy med UENDRET identitet og kun domenet som parameter (aldri tenant/rom/aktør) - etter at før-bildet er lest (L1)", async () => {
    const { transport, calls, audits } = transportWith();
    const out = await run(transport, "revoke_autonomy_binding", { domain: "pipeline" });
    expect(calls).toEqual([
      { identity: owner, tool_id: "situations", action: "list_autonomy_policies", parameters: {} },
      { identity: owner, tool_id: "situations", action: "clear_autonomy_policy", parameters: { domain: "pipeline" } }
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ type: "autonomy_binding.revoke_requested", tool_id: "executive", action: "revoke_autonomy_binding" });
    expect(out.external_id).toBe("tenant-owner:personal:pipeline");
    expect(out.data).toEqual({ removed: true, domain: "pipeline", memory_space: "personal" });
  });

  it("ingen binding å fjerne er ikke en feil, men svaret sier removed:false (idempotent: domenet er allerede på strengeste nivå)", async () => {
    const { transport } = transportWith({ execute: async (req) => (req.action === "list_autonomy_policies" ? { ok: true, data: [] } : { ok: true, data: { removed: false } }) as unknown as ToolResult });
    expect((await run(transport, "revoke_autonomy_binding", { domain: "pipeline" })).data).toMatchObject({ removed: false });
  });

  it("et avslag fra det nøstede kallet (policy/sovereign-port/kill switch) forplanter seg som en feil med SAMME årsak - aldri en stille ok", async () => {
    const { transport } = transportWith({ execute: async (req) => (req.action === "list_autonomy_policies" ? { ok: true, data: [] } : { ok: false, reason: "situation_autonomy_unauthorized" }) as unknown as ToolResult });
    await expect(run(transport, "revoke_autonomy_binding", { domain: "pipeline" })).rejects.toThrow("situation_autonomy_unauthorized");
  });

  it("uten revisjonsskriver (ikke koblet inn) feiler tilbakekallet lukket: ingenting leses eller slettes", async () => {
    const { transport, calls } = transportWith({ noAudit: true });
    await expect(run(transport, "revoke_autonomy_binding", { domain: "pipeline" })).rejects.toThrow("autonomy_audit_not_configured");
    expect(calls).toEqual([]);
  });

  it("manglende domene avvises før noe kalles", async () => {
    const { transport, calls } = transportWith();
    await expect(run(transport, "revoke_autonomy_binding", {})).rejects.toThrow("missing_parameter:domain");
    expect(calls).toEqual([]);
  });
});

describe("transporten: de fire nye senterverktøyene", () => {
  const center = (id: ControlCenterId): ControlCenterDefinition => ({
    id, title_no: id, description_no: "test",
    build: async () => ({ sections: [controlSection({ id: "s1", title_no: "Seksjon", source: "test", summary_no: "1 rad", items: [controlItem({ id: "i1", label: "Rad", status: "OK", facts: { count: 1, amount_ore: 5 } })] })], actions: [] })
  });
  type Data = { found: boolean; center?: string; summary_no: string; report?: ControlCenterReport };

  it("ikke koblet inn (flagget er av): `found: false` med en ærlig forklaring - aldri en tom «i orden»", async () => {
    const t = transportWith().transport;
    for (const a of H2_ACTIONS) {
      const data = (await run(t, a)).data as unknown as Data;
      expect(data).toMatchObject({ found: false, center: controlCenterForReadAction(a) });
      expect(data.summary_no).toContain("ikke koblet inn");
    }
  });

  it("koblet inn: samme rapport som get_control_center {center}; med en SKYmodell i løkka holdes Verdi tilbake HELT (gjennomgang M2: AI-kostnad i øre) mens Drift, Personvern og Sikkerhet er uendret; en LOKAL modell og siden får alt", async () => {
    const t = transportWith({ centers: [center("operations"), center("value"), center("privacy"), center("security")], servedLocally: (m) => m.provider === "gemma_local" }).transport;
    for (const a of H2_ACTIONS) {
      const id = controlCenterForReadAction(a) as ControlCenterId;
      const viaTool = (await run(t, a)).data as unknown as Data;
      const viaCenter = (await run(t, "get_control_center", { center: id })).data as unknown as Data;
      expect(viaTool.found).toBe(true);
      expect(viaTool.report?.sections).toEqual(viaCenter.report?.sections);
      const cloud = (await t.invoke(a, {}, "cred", { identity: owner, servingModel: { provider: "anthropic", model: "x" } } as never)).data as unknown as Data & { withheld?: boolean };
      const local = (await t.invoke(a, {}, "cred", { identity: owner, servingModel: { provider: "gemma_local", model: "x" } } as never)).data as unknown as Data;
      expect(local.report?.sections[0]?.items[0]?.facts, `${a} lokal`).toMatchObject({ amount_ore: 5 });
      if (id === "value") {
        expect(cloud, `${a} sky`).toMatchObject({ found: true, withheld: true, center: "value" });
        expect(cloud.report, a).toBeUndefined();
        expect(JSON.stringify(cloud)).not.toContain("amount_ore");
        expect(cloud.summary_no).toContain("AI-kostnad i øre");
      } else {
        expect(cloud.report?.sections[0]?.items[0]?.facts, `${a} sky`).toMatchObject({ amount_ore: 5 });
      }
    }
  });
});

describe("gjennomgang L5 (H2): Verdi-senterets ord holder også en DELEGERT jobb lokal (paritet med chatten) - kun når Verdi-flagget er på", () => {
  const ALL_H2_FLAGS = { [CONTROL_CENTER_FLAGS.operations]: "on", [CONTROL_CENTER_FLAGS.privacy]: "on", [CONTROL_CENTER_FLAGS.security]: "on" };

  it("activeRestrictedControlTools: Verdi (restricted) kommer med når flagget er på; Drift, Personvern og Sikkerhet aldri; ingen flagg = tom liste (main)", () => {
    expect(activeRestrictedControlTools({})).toEqual([]);
    expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.value]: "on" })).toEqual(["executive.get_value_center"]);
    expect(activeRestrictedControlTools(ALL_H2_FLAGS)).toEqual([]);
    expect(activeRestrictedControlTools({ ...ALL_H2_FLAGS, [CONTROL_CENTER_FLAGS.finance]: "on", [CONTROL_CENTER_FLAGS.value]: "on" }).sort()).toEqual(["executive.get_finance_center", "executive.get_value_center"]);
    for (const value of ["true", "1", "ON", "yes", " on", "on "]) expect(activeRestrictedControlTools({ [CONTROL_CENTER_FLAGS.value]: value }), JSON.stringify(value)).toEqual([]);
  });

  it("financeToolIntent: «vis verdisenteret», «spart tid» og «bruksfrekvens» låser en delegert jobb lokalt med Verdi PÅ - og er identisk med main (false) med flagget AV; de tre andre sentrenes ord gjør det aldri", () => {
    for (const text of ["vis verdisenteret", "hvor mye spart tid har jeg", "hva er bruksfrekvens"]) {
      expect(financeToolIntent(text, financeIntentOptions({ [CONTROL_CENTER_FLAGS.value]: "on" })), text).toBe(true);
      expect(financeToolIntent(text, financeIntentOptions({})), `${text} (flagg AV = main)`).toBe(false);
      expect(financeToolIntent(text), `${text} (uten valg = main)`).toBe(false);
    }
    for (const text of ["vis driftssenteret", "vis personvernsenteret", "vis sikkerhetssenteret", "hva er golden-suite"]) {
      expect(financeToolIntent(text, financeIntentOptions({ ...ALL_H2_FLAGS, [CONTROL_CENTER_FLAGS.value]: "on" })), text).toBe(false);
    }
  });
});
