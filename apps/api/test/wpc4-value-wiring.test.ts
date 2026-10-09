import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore, fastRoute } from "@jarvis/core";
import { MemoryTraceSink, type ModelGateway } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ExecutiveService, ExecutiveTransport, deriveChangeFreeze, executiveToolDefinitions, parseDeclaredValueGates, type FollowUpPushPolicy } from "@jarvis/executive";
import { GovernanceTransport, governanceToolDefinitions } from "@jarvis/governance";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { SituationsTransport, situationsToolDefinitions } from "@jarvis/situations";
import { changeFreeze } from "@jarvis/self-modification";
import {
  CHAT_READ_TIER, KnowledgeSearchTransport, MemorySearchTransport, ModelSurfaceViolationError, SURFACE_TOOL_GRANTS, assertChatReadTier, assertManifestInvariants, buildToolManifest, firstWaveTools, homeAssistantTools,
  knowledgeToolDefinitions, memoryToolDefinitions, selectSurfaceTools, type ToolDefinition, type ToolGateway
} from "@jarvis/tool-gateway";
import { TasksDelegateTransport, tasksDelegateToolDefinitions } from "../src/chat-jobs.ts";
import { ConversationEngine } from "../src/conversation.ts";
import { RunRateTransport, runRateToolDefinitions } from "../src/run-rate.ts";
import { buildValueRuntimeFacts, v5ProposalsEnabled } from "../src/value-facts.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";

/**
 * WP-C4: komposisjonen rundt Value Center. Beviser at verktøyet er ren lesing på chat-flaten (og ikke på andre), at hurtigbanen går via Tool Gateway og aldri via modellen, at main.ts kobler V2-push KUN bak flagget
 * og KUN i API-prosessen, at kjøretidsfaktaene er fail-closed, og at den dupliserte change freeze-regelen er lik EV-8 sin for alle kombinasjoner.
 * main.ts/worker-main.ts starter en server idet de importeres, så de låses med tekstvakter (samme mønster som `executive-wiring.test.ts`).
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
/** Kildekode uten kommentarer (blokk- og linjekommentarer), så en vakt mot f.eks. `process.env` bare treffer faktisk bruk - ikke omtale i dokumentasjonen. */
const code = (relative: string): string => read(relative).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const mainSource = read("../src/main.ts");
const workerSource = read("../src/worker-main.ts");
const serverSource = read("../src/server.ts");

function productionDefinitions(): ToolDefinition[] {
  const fakeGw = { list: () => [], health: new Map(), hasSecret: async () => true } as unknown as ToolGateway;
  return firstWaveTools({}, {
    additionalTools: [
      ...homeAssistantTools({ invoke: async () => ({}) } as never),
      ...executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGw))),
      ...ownerControlsToolDefinitions(new OwnerControlsTransport({} as never, fakeGw)),
      ...governanceToolDefinitions(new GovernanceTransport({} as never)),
      ...situationsToolDefinitions(new SituationsTransport({} as never, {} as never)),
      ...memoryToolDefinitions(new MemorySearchTransport({} as never, {} as never)),
      // WP-D1 (UA-2): kunnskapssøket og påstandsstatusen er på chattens lese-nivå og må være registrert for at nivået skal bestå.
      ...knowledgeToolDefinitions(new KnowledgeSearchTransport({} as never)),
      ...tasksDelegateToolDefinitions(new TasksDelegateTransport({} as never, {} as never)),
      ...runRateToolDefinitions(new RunRateTransport({} as never))
    ]
  });
}
const defs = productionDefinitions();
const gw = { list: () => defs } as unknown as ToolGateway;
const KEY = "executive.get_value_report";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("A: executive.get_value_report er ren lesing på chat-flaten - og ingen andre steder", () => {
  it("står i chattens lese-nivå, og nivå-, manifest- og klasse-invariantene holder (klasse A, effekt read)", () => {
    expect(CHAT_READ_TIER.filter((g) => `${g.tool_id}.${g.action}` === KEY)).toHaveLength(1);
    expect(() => assertChatReadTier(gw)).not.toThrow();
    expect(() => assertManifestInvariants(buildToolManifest(defs))).not.toThrow();
    const entry = buildToolManifest(defs).get(KEY);
    expect(entry, "manifest-oppføring").toBeDefined();
    expect(entry).toMatchObject({ tool_id: "executive", effect: "read", risk: "A" });
  });

  it("har nøyaktig samme flater som søsterverktøyet get_slo_report (ikke flere)", () => {
    const manifest = buildToolManifest(defs);
    const value = manifest.get(KEY);
    const slo = manifest.get("executive.get_slo_report");
    expect(slo).toBeDefined();
    expect(value?.surfaces).toEqual(slo?.surfaces);
    expect(value?.surfaces.length).toBeGreaterThan(0);
    for (const s of ["background", "coding"] as const) expect(SURFACE_TOOL_GRANTS[s].some((g) => `${g.tool_id}.${g.action}` === KEY), s).toBe(false);
  });

  it("endres definisjonen til skriving (klasse B), stopper oppstarten lukket", () => {
    const mutated = defs.map((d) => (d.tool_id === "executive" && d.action === "get_value_report" ? { ...d, capability_class: "B" as const } : d));
    expect(() => assertChatReadTier({ list: () => mutated } as unknown as ToolGateway)).toThrow(ModelSurfaceViolationError);
  });

  it("definisjonen har strengt, tomt skjema: ingen parameter (heller ikke tenant/person/rom) kan sendes inn", () => {
    const def = defs.find((d) => d.tool_id === "executive" && d.action === "get_value_report");
    expect(def?.capability_class).toBe("A");
    expect(def?.input_schema.safeParse({}).success).toBe(true);
    for (const evil of [{ tenant_id: "annen" }, { person_id: "x" }, { memory_space: "health" }, { anything: 1 }]) expect(def?.input_schema.safeParse(evil).success, JSON.stringify(evil)).toBe(false);
  });

  it("er med i produksjonsflaten for chat, og utvalget tar det med kun når eieren spør om verdi/bruk", () => {
    expect(PRODUCTION_SURFACE.some((m) => `${m.tool_id}.${m.action}` === KEY)).toBe(true);
    const picked = (text: string): string[] => selectSurfaceTools("web_chat", text, PRODUCTION_SURFACE).selected.map((m) => `${m.tool_id}.${m.action}`);
    for (const text of ["lag en verdirapport for meg", "oppsummer hva du har hjulpet meg med og hva det kostet", "vis value center", "hvor mye bruker jeg deg", "gi meg bruksstatistikk", "hvor nyttig har du vært denne måneden?"]) {
      expect(picked(text), text).toContain(KEY);
    }
    for (const text of ["hei", "hva er været i morgen", "send en e-post til Ola om møtet", "sjekk kalenderen min", "hva koster du"]) {
      expect(picked(text), text).not.toContain(KEY);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("B: hurtigbanen «hva har du hjulpet meg med» går via Tool Gateway-verktøyet og aldri via modellen", () => {
  const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
  const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };

  function engine(valueReport: { run(identity: IdentityContext): Promise<string | null> } | undefined): { engine: ConversationEngine; modelCalls: string[]; trace: MemoryTraceSink } {
    const modelCalls: string[] = [];
    const never = (name: string) => async () => { modelCalls.push(name); throw new Error("modellen skal ikke kalles på hurtigbanen"); };
    const gateway = { complete: never("complete"), stream: never("stream"), completeWithTools: never("completeWithTools") } as unknown as ModelGateway;
    const trace = new MemoryTraceSink();
    return {
      engine: new ConversationEngine({
        messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
        tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace,
        ...(valueReport !== undefined ? { valueReport } : {})
      }),
      modelCalls, trace
    };
  }

  it("svaret er nøyaktig tekstene verktøyet leverte; modellen kalles aldri; sporet merker hurtigbanen uten LLM", async () => {
    const seen: IdentityContext[] = [];
    const summary = "Verdi og bruk\nV1 Daglig brief: 7 sendt siste 7 dager";
    const { engine: e, modelCalls, trace } = engine({ run: async (id) => { seen.push(id); return summary; } });
    const tokens: string[] = [];
    const reply = await e.handle(identity, "hva har du hjulpet meg med?", (t) => { tokens.push(t); });
    expect(reply).toMatchObject({ reply: summary, routed: "fast" });
    expect(tokens.join("")).toBe(summary);
    expect(modelCalls).toEqual([]);
    expect(seen).toEqual([identity]);
    expect(trace.spans.find((s) => s.kind === "fast_route")).toMatchObject({ name: "value_report", metadata: { llm_used: false } });
  });

  it("ærlig fallback uten tall når verktøyet mangler, kaster eller ikke svarer - aldri en hardkodet «jeg har hjulpet deg masse»", async () => {
    for (const dep of [undefined, { run: async () => null }, { run: async () => { throw new Error("tool_denied"); } }]) {
      const { engine: e, modelCalls } = engine(dep);
      const reply = await e.handle(identity, "verdi");
      expect(reply.routed).toBe("fast");
      expect(reply.reply).toContain("Jeg kan ikke lese verdi- og bruksrapporten akkurat nå");
      expect(reply.reply).not.toMatch(/\d/);
      expect(modelCalls).toEqual([]);
    }
  });

  it("kun den eksakte formuleringen tas av hurtigbanen: en vanlig setning om verdi går videre til den intelligente banen", () => {
    expect(fastRoute("hva er verdien av tomten vår")).toBeNull();
    expect(fastRoute("hva har du hjulpet meg med")).toEqual({ kind: "value_report" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("C: main.ts kobler Value Center og V2-push - kun bak flagget, kun i API-prosessen, kun via de eksisterende veiene", () => {
  it("Value Center: kilden bygges på app-poolen, faktaene leses lat, og samme ExecutiveService-instans bærer dem", () => {
    expect(mainSource).toContain("const valueSource = createValueMeasurementSource(pool, { schedulerTenantId: owner.tenant_id });");
    expect(mainSource).toMatch(/value: \{\s*source: valueSource,\s*facts: \(\) => buildValueRuntimeFacts\(\{/);
    expect(mainSource).toContain("killSwitchActive: async () => (await selfModelControls.getControlState()).kill_switch.active");
    expect(mainSource).toContain("ev0Status: () => getLastEv0BootStatus()");
    expect(mainSource.match(/new ExecutiveService\(/g)).toHaveLength(1);
    expect(mainSource.match(/createValueMeasurementSource\(/g)).toHaveLength(1);
  });

  it("hurtigbanen går via toolGateway.execute (Policy Gateway + revisjon) - aldri direkte mot kilden", () => {
    const start = mainSource.indexOf("valueReport: {");
    expect(start).toBeGreaterThan(-1);
    const block = mainSource.slice(start, mainSource.indexOf("costReport: {", start));
    expect(block).toContain('toolGateway.execute({ identity, tool_id: "executive", action: "get_value_report", parameters: {} })');
    expect(block).not.toContain("valueSource");
    expect(block).not.toContain("pool");
  });

  it("V2-push: policyen leses én gang fra miljøet, og starteren kalles nøyaktig ÉN gang - inne i Telegram-blokken og bak policy.enabled", () => {
    expect(mainSource.match(/parseFollowUpPushPolicy\(process\.env\)/g)).toHaveLength(1);
    expect(mainSource.match(/startFollowUpPush\(/g)).toHaveLength(1);
    const telegramBlock = mainSource.indexOf("if (telegramToken && telegramChatId) {");
    const call = mainSource.indexOf("startFollowUpPush(");
    const guard = mainSource.lastIndexOf("if (v2PushPolicy.enabled) {", call);
    const warn = mainSource.indexOf("if (v2PushPolicy.enabled && !telegramDeliveryConfigured)");
    expect(telegramBlock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(telegramBlock);
    expect(call).toBeGreaterThan(guard);
    expect(warn).toBeGreaterThan(call);
    // ingenting mellom vakten og kallet kan hoppe over den (ingen `else if`/tidlig return som gjør kallet betinget av annet enn flagget)
    expect(mainSource.slice(guard, call)).toBe("if (v2PushPolicy.enabled) {\n      ");
    expect(mainSource).toContain("startFollowUpPush({ pool, graph: conversationGraphService, gateway: toolGateway, ownerIdentity, policy: v2PushPolicy });");
    expect(mainSource).toContain("telegramDeliveryConfigured = Boolean(telegramToken && telegramChatId);");
  });

  it("V2-push og kilden finnes IKKE i worker-prosessen (ellers kunne to prosesser varsle) og ingen annen fil starter løperen", () => {
    for (const forbidden of ["follow-up-push", "startFollowUpPush", "value-source", "createValueMeasurementSource", "value-facts"]) expect(workerSource, forbidden).not.toContain(forbidden);
    expect(serverSource).not.toContain("startFollowUpPush");
    expect(serverSource).not.toContain("follow-up-push");
  });

  it("V3/V5 er sovende i koden: ingen oppstartssti i main.ts kan aktivere selvendring eller utføre driftsforslag", () => {
    for (const forbidden of ["evaluateBuilderLoopReadiness", "proposeOpsActions", "activation_decision"]) expect(mainSource, forbidden).not.toContain(forbidden);
    expect(mainSource).not.toMatch(/new SelfModificationService\(/);
  });

  it("miljøet leses kun i main.ts/value-facts.ts - ikke i tjenesten eller de rene modulene", () => {
    expect(code("../../../modules/executive/src/service.ts")).not.toContain("process.env");
    for (const file of ["types", "catalog", "text", "compose", "render", "loops", "builder-loop", "ops-proposals", "follow-up-push", "index"]) {
      expect(code(`../../../modules/executive/src/value/${file}.ts`), file).not.toContain("process.env");
    }
    for (const file of ["value-facts", "value-source", "follow-up-push"]) expect(code(`../src/${file}.ts`), file).not.toContain("process.env");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("D: /value/query og dashbordet", () => {
  it("ruten har sitt eget, hardkodede lese-allowlist og videresender aldri body-parametre", () => {
    expect(serverSource).toContain('const VALUE_QUERY_ACTIONS = ["get_value_report"] as const;');
    const start = serverSource.indexOf('url.pathname === "/value/query"');
    expect(start).toBeGreaterThan(-1);
    const block = serverSource.slice(start, serverSource.indexOf('url.pathname === "/owner-controls/connector-credentials"', start));
    expect(block).toContain("parameters: {}");
    expect(block).not.toContain('parsedBody["parameters"]');
    expect(block).toContain("resolveFromGrant(");
    expect(block).toContain('tool_id: "executive"');
  });

  it("det finnes ingen skrive-/mutasjonsvariant av ruten", () => {
    expect(serverSource).not.toContain("/value/mutate");
    expect(serverSource.match(/"\/value\//g)).toHaveLength(1);
  });

  it("dashbordet viser rapporten som ren tekst (textContent), aldri innerHTML med data, og laster den sammen med resten", () => {
    const html = read("../../web/dashboard.html");
    expect(html).toContain('<a href="#sec-value">Verdi</a>');
    expect(html).toContain('<section id="sec-value" data-section="value">');
    expect(html).toContain('id="value-summary"');
    const start = html.indexOf("async function loadValue()");
    expect(start).toBeGreaterThan(-1);
    const fn = html.slice(start, html.indexOf("document.getElementById(\"maintenance-form\")", start));
    expect(fn).toContain('postRunRate("/value/query", "get_value_report")');
    expect(fn).toContain("pre.textContent =");
    expect(fn).not.toContain("innerHTML");
    expect(html).toContain("void loadValue();");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("E: kjøretidsfakta er flagg og tilstand - fail-closed og aldri innhold", () => {
  const policy: FollowUpPushPolicy = { enabled: false, max_messages_per_day: 3, max_items_per_message: 5, min_gap_minutes: 60, quiet_start_hour: 22, quiet_end_hour: 7, time_zone: "Europe/Oslo", stale_overdue_days: 14 };
  const base = { env: {}, push: policy, deliveryConfigured: () => true, ev0Status: () => null, killSwitchActive: async () => false };

  it("kun den eksakte verdien «true» slår V5-forslag på", () => {
    expect(v5ProposalsEnabled({ JARVIS_V5_PROPOSALS_ENABLED: "true" })).toBe(true);
    expect(v5ProposalsEnabled({ JARVIS_V5_PROPOSALS_ENABLED: " true " })).toBe(true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", "on", "tru"]) expect(v5ProposalsEnabled({ JARVIS_V5_PROPOSALS_ENABLED: v }), String(v)).toBe(false);
    expect(v5ProposalsEnabled({})).toBe(false);
  });

  it("flagg, kanal og rolig tid kommer fra policy og konfigurasjon; ukjent EV-0 og kill switch gir null (aldri en gjetning)", async () => {
    const facts = await buildValueRuntimeFacts({ ...base, push: { ...policy, enabled: true, max_messages_per_day: 5, quiet_start_hour: 9, quiet_end_hour: 17 }, deliveryConfigured: () => false, killSwitchActive: async () => { throw new Error("db nede"); } });
    expect(facts).toMatchObject({
      v1_delivery_configured: false, v2_push: { enabled: true, channel_configured: false, max_per_day: 5, quiet_hours: "09-17" },
      v5_proposals_enabled: false, ev0: { constitution_verified: null, ledger_ok: null }, kill_switch_active: null, declared_gates: []
    });
  });

  it("EV-0-status avledes eksakt: verifisert/ok = true, ikke verifisert/brutt = false, utilgjengelig register = null", async () => {
    const f = (status: unknown) => buildValueRuntimeFacts({ ...base, ev0Status: () => status as never });
    expect((await f({ constitution: { status: "verified", version: 1, digest: "d" }, ledger: { status: "ok", count: 3, head_hash: "h" } })).ev0).toEqual({ constitution_verified: true, ledger_ok: true });
    expect((await f({ constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "broken", broken_seq: "2", count: 3 } })).ev0).toEqual({ constitution_verified: false, ledger_ok: false });
    expect((await f({ constitution: { status: "verified", version: 1, digest: "d" }, ledger: { status: "unavailable", error: "x" } })).ev0).toEqual({ constitution_verified: true, ledger_ok: null });
  });

  it("kill switch leses fra eierkontrollene, og erklærte porter kommer kun fra eierens miljø (ukjente navn forkastes)", async () => {
    expect((await buildValueRuntimeFacts({ ...base, killSwitchActive: async () => true })).kill_switch_active).toBe(true);
    expect((await buildValueRuntimeFacts({ ...base, killSwitchActive: async () => false })).kill_switch_active).toBe(false);
    const env = { JARVIS_VALUE_VERIFIED_GATES: "D-32, WORKER_ISOLATION, D-32, BYPASS_ALL, , owner_decision:V3", JARVIS_V5_PROPOSALS_ENABLED: "true" };
    const facts = await buildValueRuntimeFacts({ ...base, env });
    expect(facts.declared_gates).toEqual(["D-32", "WORKER_ISOLATION"]);
    expect(facts.declared_gates).toEqual(parseDeclaredValueGates(env.JARVIS_VALUE_VERIFIED_GATES));
    expect(facts.v5_proposals_enabled).toBe(true);
  });

  it("faktaene inneholder bare flagg, tall og porter - ingen hemmeligheter eller miljøverdier følger med", async () => {
    const marker = ["lekkasje", "markor", "42"].join("-");
    const secretEnv = { JARVIS_TELEGRAM_TOKEN: marker, JARVIS_DB_PASSWORD: marker, JARVIS_VALUE_VERIFIED_GATES: "D-32" };
    const json = JSON.stringify(await buildValueRuntimeFacts({ ...base, env: secretEnv }));
    expect(json).not.toContain(marker);
    expect(json).not.toContain("JARVIS_");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("F: den dupliserte change freeze-regelen er LIK EV-8 sin for alle kombinasjoner", () => {
  it("deriveChangeFreeze === changeFreeze (frosset og årsaker, i samme rekkefølge) over alle kombinasjoner av de fire signalene (SLO-brudd 0, 1 og 3)", () => {
    let n = 0;
    for (const incident_open of [false, true]) for (const observability_ok of [false, true]) for (const kill_switch_active of [false, true]) for (const slo_breaches of [0, 1, 3]) {
      const s = { incident_open, observability_ok, kill_switch_active, slo_breaches };
      expect(deriveChangeFreeze(s), JSON.stringify(s)).toEqual(changeFreeze(s));
      n += 1;
    }
    expect(n).toBe(24);
  });
});
