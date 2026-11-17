import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import {
  ClaudeBudgetBlockedError, DEFAULT_ALERT_PCTS, DEFAULT_PACING_PARAMS, MemoryTraceSink, NoEligibleProviderError, claudeBudgetNoteNo, classifyContentSensitivity,
  type CompleteInput, type ModelGateway, type ToolExecutor
} from "@jarvis/model-gateway";
import type { ClaimedTask, InProcessWorker, JobContext, TaskService } from "@jarvis/tasks";
import type { MeshToolMapping } from "@jarvis/tool-gateway";
import { ConversationEngine } from "../src/conversation.ts";
import { executiveHandler } from "../src/executive.ts";
import { claudeBudgetRouteNote, stripSystemNotes } from "../src/tool-turn-route.ts";
// @ts-expect-error - ren .mjs uten typer (genererer compose-blokkene)
import { NEVER_IN_RUNTIME, SERVICE_ENV } from "../../../infra/local/service-env.mjs";

/**
 * WP-B4 (D-476): kobling og flater utenfor gatewayen. (1) Variablene når containerne (manifest → compose → .env.example, og standardene i dokumentasjonen er de samme som i koden). (2) api og worker lager samme
 * enforcer fra samme miljø og gir den til gatewayen KUN når flagget er på. (3) Chatten og jobbene sier fra når svaret kom fra lokal modell fordi kreditten stengte Anthropic - og er byte-identiske uten kreditten.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const FLAGS = [
  "JARVIS_CLAUDE_BUDGET_USD", "JARVIS_CLAUDE_BUDGET_RESET_DAY", "JARVIS_CLAUDE_BUDGET_HARD_STOP", "JARVIS_CLAUDE_BUDGET_RESERVE_PCT", "JARVIS_CLAUDE_BUDGET_MARGIN_PCT",
  "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO", "JARVIS_CLAUDE_BUDGET_ALERT_PCTS", "JARVIS_CLAUDE_BUDGET_TIERS"
];
const WINDOW_END = Date.UTC(2026, 11, 14, 23, 0, 0); // 15. des 2026 00:00 Oslo

describe("variablene når api- OG worker-containeren (manifest, compose, .env.example)", () => {
  const compose = read("infra/local/docker-compose.yml");
  const block = (service: string): string => {
    const start = compose.indexOf(`(SERVICE_ENV.${service})`);
    const next = compose.indexOf("# GENERERT fra", start + 10);
    return compose.slice(start, next === -1 ? undefined : next);
  };

  it("alle åtte står i SERVICE_ENV.api og SERVICE_ENV.worker (begge kaller modellen) - og ikke i voice, browser eller migrate", () => {
    for (const name of FLAGS) {
      expect(SERVICE_ENV.api, `api:${name}`).toContain(name);
      expect(SERVICE_ENV.worker, `worker:${name}`).toContain(name);
      for (const service of ["voice", "browser", "migrate"] as const) expect(SERVICE_ENV[service], `${service}:${name}`).not.toContain(name);
    }
  });

  it("compose er generert fra manifestet: nøyaktig én videresendingslinje per variabel i api-blokken og i worker-blokken, tom standard = AV", () => {
    for (const name of FLAGS) {
      for (const service of ["api", "worker"] as const) {
        const lines = block(service).split("\n").filter((l) => l.trim().startsWith(`${name}:`));
        expect(lines, `${service}:${name}`).toHaveLength(1);
        expect(lines[0]!.trim(), `${service}:${name}`).toBe(`${name}: "\${${name}:-}"`);
      }
    }
  });

  it("variablene er ikke hemmeligheter (kun tall, flagg og tabeller)", () => {
    for (const name of FLAGS) expect(NEVER_IN_RUNTIME, name).not.toContain(name);
  });

  it(".env.example dokumenterer alle åtte; flagget er AV i eksempelet (kommentert), og standardene i dokumentasjonen er de samme som i koden", () => {
    const example = read(".env.example");
    for (const name of FLAGS) expect(example, name).toMatch(new RegExp(`^# ${name}=`, "m"));
    // ingen av dem er aktive i eksempelfilen (en kopi av filen skal aldri slå på kreditten)
    for (const name of FLAGS) expect(example, `aktiv ${name}`).not.toMatch(new RegExp(`^${name}=`, "m"));
    const documented = (name: string): string => new RegExp(`^# ${name}=(.*)$`, "m").exec(example)?.[1]?.trim() ?? "";
    expect(documented("JARVIS_CLAUDE_BUDGET_USD")).toBe("100");
    expect(Number(documented("JARVIS_CLAUDE_BUDGET_RESET_DAY"))).toBe(DEFAULT_PACING_PARAMS.reset_day); // 15 (Q-67)
    expect(documented("JARVIS_CLAUDE_BUDGET_RESET_DAY")).toBe("15");
    expect(documented("JARVIS_CLAUDE_BUDGET_HARD_STOP")).toBe(DEFAULT_PACING_PARAMS.hard_stop ? "on" : "off");
    expect(Number(documented("JARVIS_CLAUDE_BUDGET_RESERVE_PCT"))).toBe(DEFAULT_PACING_PARAMS.reserve_pct);
    expect(Number(documented("JARVIS_CLAUDE_BUDGET_MARGIN_PCT"))).toBe(DEFAULT_PACING_PARAMS.margin_pct);
    expect(Number(documented("JARVIS_CLAUDE_BUDGET_TIGHT_RATIO"))).toBe(DEFAULT_PACING_PARAMS.tight_ratio);
    expect(documented("JARVIS_CLAUDE_BUDGET_ALERT_PCTS").split(",").map(Number)).toEqual([...DEFAULT_ALERT_PCTS]);
    expect(example).toContain("fornyes den 15.");
  });
});

describe("api og worker lager samme enforcer fra samme miljø - kun når flagget er på", () => {
  const main = read("apps/api/src/main.ts");
  const worker = read("apps/api/src/worker-main.ts");

  it("api: konfig parses fra miljøet, enforcer lages kun når den finnes, og gis til gatewayen via betinget spread (uendret options-objekt uten flagget)", () => {
    expect(main).toMatch(/const claudeBudgetConfig = claudeBudgetConfigFromEnv\(process\.env\);/);
    expect(main).toMatch(/const claudeBudget = claudeBudgetConfig === null \? undefined : new ClaudeBudgetEnforcer\(\{ config: claudeBudgetConfig, pool, trace, actor_person_id: owner\.owner_person_id \}\);/);
    const gatewayCall = main.slice(main.indexOf("const gateway = new ModelGateway({"), main.indexOf("assertProvidersHaveExplicitPricing(pricingFromEnv(), gateway.listProviderNames());"));
    expect(gatewayCall).toContain("...(claudeBudget !== undefined ? { claudeBudget } : {})");
    expect(main.indexOf("const claudeBudgetConfig")).toBeLessThan(main.indexOf("const gateway = new ModelGateway({"));
  });

  it("worker: samme parsing (ugyldig verdi stopper oppstarten via failStartup), samme sporsink til enforceren og gatewayen, samme betingede spread", () => {
    expect(worker).toMatch(/claudeBudgetConfig = claudeBudgetConfigFromEnv\(process\.env\);\s*\} catch \(err\) \{\s*failStartup\(err\);\s*\}/);
    expect(worker).toMatch(/const workerTrace = traceSinkFromEnv\("var\/worker-traces\.jsonl"\);/);
    expect(worker).toMatch(/new ClaudeBudgetEnforcer\(\{ config: claudeBudgetConfig, pool, trace: workerTrace, actor_person_id: owner\.owner_person_id \}\)/);
    const gatewayCall = worker.slice(worker.indexOf("const gateway = new ModelGateway({"), worker.indexOf("assertProvidersHaveExplicitPricing(pricingFromEnv(), gateway.listProviderNames());"));
    expect(gatewayCall).toContain("trace: workerTrace,");
    expect(gatewayCall).toContain("...(claudeBudget !== undefined ? { claudeBudget } : {})");
  });

  it("kreditten er ikke noe annet sted enn bak parsingen: ingen annen kodevei lager en enforcer eller slår flagget på", () => {
    for (const [name, src] of [["main", main], ["worker", worker]] as const) {
      expect((src.match(/new ClaudeBudgetEnforcer\(/g) ?? []).length, name).toBe(1);
      expect(src, name).not.toMatch(/JARVIS_CLAUDE_BUDGET_USD["']?\]?\s*=[^=]/);
    }
  });
});

describe("flatene (brief, varsler, kontrollsenter) lages kun når flagget er på", () => {
  const main = read("apps/api/src/main.ts");
  const worker = read("apps/api/src/worker-main.ts");
  const register = read("apps/api/src/control-center/register.ts");
  const aiCenter = read("apps/api/src/control-center/ai.ts");

  it("daglig brief: kilden legges til via betinget spread bak samme konfig - uten flagget er kildelisten uendret, og kilden finnes kun ett sted", () => {
    expect(main).toContain("...(claudeBudgetConfig !== null ? [claudeBudgetBriefSource({ pool, config: claudeBudgetConfig })] : [])");
    expect((main.match(/claudeBudgetBriefSource\(/g) ?? []).length).toBe(1);
    const brief = main.slice(main.indexOf("const dailyBrief = new DailyBrief(["), main.indexOf("], pool);", main.indexOf("const dailyBrief = new DailyBrief([")));
    // de eksisterende fem kildene står først og uendret
    expect(brief).toMatch(/tasksSource\(pool\),[\s\S]*schedulerSource\([\s\S]*buildStatusSource\(toolGateway\),[\s\S]*emailSource\(toolGateway\), calendarSource\(toolGateway\),/);
  });

  it("varsler: kun i worker-prosessen, kun når konfigen finnes, for eierens tenant og person, og via vakthundens EKSISTERENDE sink (samme Telegram-vei som costWarningCheck) - ingen ny sink, ingen ny transport", () => {
    const start = worker.indexOf("if (claudeBudgetConfig !== null) {\n  startClaudeBudgetAlerts(");
    expect(start).toBeGreaterThan(-1);
    const call = worker.slice(start, worker.indexOf("}\n", start) + 2);
    expect(call).toContain("new ClaudeBudgetAlerter({ pool, config: claudeBudgetConfig, tenantId: owner.tenant_id, ownerPersonId: owner.owner_person_id, sink: watchdogAlertSink })");
    expect(worker.indexOf("const watchdogAlertSink")).toBeLessThan(start);
    expect((worker.match(/startClaudeBudgetAlerts\(/g) ?? []).length).toBe(1);
    expect(main).not.toContain("startClaudeBudgetAlerts");
    expect(main).not.toContain("ClaudeBudgetAlerter");
    expect((worker.match(/new WatchdogEmergencyAlertSink\(/g) ?? []).length).toBe(1);
  });

  it("kontrollsenteret: konfigen kommer fra miljøet via den ene parseren, gis til AI-senteret kun når den finnes, og elementene bygges bare uten `restrictFinance`", () => {
    expect(register).toContain("claudeBudgetConfigFromEnv(env) ?? undefined");
    expect(register).toContain("...(claudeBudget !== undefined ? { claudeBudget } : {})");
    expect(aiCenter).toMatch(/const claudeBudgetRows = deps\.claudeBudget !== undefined && ctx\.restrictFinance !== true\s*\?\s*await claudeBudgetItems\(/);
    expect((aiCenter.match(/claudeBudgetItems\(/g) ?? []).length).toBe(1);
  });

  it("kreditten innfører INGET verktøy (status leses via den eksisterende `executive.get_control_center` med senteret `ai`): flatene definerer ingen ToolDefinition og lager ingen handlinger", () => {
    for (const path of ["apps/api/src/claude-budget-surfaces.ts", "apps/api/src/control-center/ai-claude-budget.ts"]) {
      const src = read(path);
      expect(src, path).not.toMatch(/ToolDefinition|toolDefinitions|controlAction\(|risk_class|riskClass/);
    }
  });
});

describe("merknaden bak svar og jobber når kreditten stengte Anthropic", () => {
  const closed = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    claude_budget: { action: "deny", level: "exhausted", tier: "essential", reason: "exhausted_closed", constraint: "closed", window_end_ms: WINDOW_END, ...extra }
  });

  it("deny og defer gir en norsk merknad (svar: to linjeskift + parenteser; jobb: kun parenteser) som starter med prefikset og sier når kreditten fornyes", () => {
    // L1: «lokale modellen» står kun når en lokal modell svarte (leverandøren som svarte oppgis) - se wpb4-review-fixes.test.ts for annen/ukjent leverandør
    const local = { provider: "gemma_local" };
    expect(claudeBudgetRouteNote(closed(), "svaret", local)).toBe("\n\n(Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
    expect(claudeBudgetRouteNote(closed(), "jobben", local)).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
    expect(claudeBudgetRouteNote(closed({ action: "defer", reason: "reserve_kept_for_essential" }), "svaret", local)).toContain("resten er forbeholdt det aller viktigste");
    expect(claudeBudgetRouteNote(closed({ action: "defer", reason: "tight_background_deferred" }), "svaret", local)).toContain("bruken ligger foran periodens tempo");
  });

  it("tom streng for alt annet: ingen metadata (flagg AV), tillatt, nedgradert til billigere modell, åpen, og ugyldige/ukjente former", () => {
    expect(claudeBudgetRouteNote(undefined)).toBe("");
    expect(claudeBudgetRouteNote({})).toBe("");
    expect(claudeBudgetRouteNote({ tool_rounds: 2, router: {} })).toBe("");
    expect(claudeBudgetRouteNote(closed({ action: "allow", constraint: "open" }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ action: "downgrade", constraint: "cheaper_model" }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ constraint: "open" }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ action: "banan" }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ reason: 5 }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ window_end_ms: "snart" }))).toBe("");
    expect(claudeBudgetRouteNote(closed({ window_end_ms: Number.NaN }))).toBe("");
    expect(claudeBudgetRouteNote({ claude_budget: "tekst" })).toBe("");
    expect(claudeBudgetRouteNote({ claude_budget: null })).toBe("");
  });

  it("merknaden fjernes fra historikken før klassifisering (står i SYSTEM_NOTE_PREFIXES), og kan aldri selv låse samtalen til lokal modell", () => {
    for (const meta of [closed(), closed({ action: "defer", reason: "reserve_kept_for_essential" }), closed({ action: "defer", reason: "tight_background_deferred" })]) {
      const note = claudeBudgetRouteNote(meta);
      expect(stripSystemNotes(`svar${note}`)).toBe("svar");
      expect(classifyContentSensitivity({ texts: [note] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(classifyContentSensitivity({ texts: [stripSystemNotes(`svar${note}`)] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    }
    expect(stripSystemNotes(`svar${claudeBudgetRouteNote(closed())}${claudeBudgetRouteNote(closed())}`)).toBe("svar"); // også flere på rad
  });

  it("merknaden og feilteksten har samme ordlyd som motoren produserer (ingen kopi som kan drive fra hverandre)", () => {
    expect(claudeBudgetRouteNote(closed(), "svaret", { provider: "gemma_local" })).toContain(claudeBudgetNoteNo("deny", "exhausted_closed", WINDOW_END));
  });
});

const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };
const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });
const NEUTRAL_ASK = "hva er neste punkt i kalenderen min i morgen?";
const BUDGET_META = { claude_budget: { action: "deny", level: "exhausted", tier: "essential", reason: "exhausted_closed", constraint: "closed", window_end_ms: WINDOW_END } };
const PREFERENCE_EXHAUSTED = "provider_preference_exhausted: ingen av [anthropic] er konfigurert/kvalifisert (anthropic:budget_blocked)";

function engine(gateway: Record<string, unknown>): ConversationEngine {
  return new ConversationEngine({
    messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway: gateway as unknown as ModelGateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" },
    tools: {
      definitions: [def("calendar__read_events")],
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      select: () => ({ definitions: [def("calendar__read_events")], limits: LIMITS })
    }
  });
}
const usage = { input_tokens: 1, output_tokens: 1 };
/** Skyruten (hard preferanse for Anthropic) er stengt av kreditten, og den lokale omkjøringen svarer. `metadata` er det gatewayen legger på det lokale svaret. */
const cloudClosedThenLocal = (metadata?: Record<string, unknown>) => ({
  completeWithTools: async (input: CompleteInput) => {
    if (input.providerPreference?.[0] === "anthropic") throw new NoEligibleProviderError(PREFERENCE_EXHAUSTED);
    return { text: "svar", usage, provider: "gemma_local", model: "m", ...(metadata !== undefined ? { metadata } : {}) };
  }
});

let errSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => { errSpy?.mockRestore(); errSpy = undefined; });

describe("chatten (ConversationEngine) - kreditten stengte skyruten for verktøyturen", () => {
  it("lokal omkjøring etter at Anthropic er stengt: svaret får ÉN merknad om kreditten (i svaret og i strømmen), og den misvisende «Reservemodell brukt: anthropic var ikke tilgjengelig» droppes", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tokens: string[] = [];
    const result = await engine(cloudClosedThenLocal(BUDGET_META)).handle(identity, NEUTRAL_ASK, (t: string) => { tokens.push(t); });
    expect(result.reply).toBe("svar\n\n(Claude-kreditten: perioden er brukt opp, så dette svaret kom fra den lokale modellen. Kreditten fornyes 15. desember.)");
    expect(result.reply).not.toContain("Reservemodell");
    expect(tokens.join("")).toContain("Claude-kreditten:");
  });

  it("tale: samme rute, men ingen merknad i det som leses opp", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await engine(cloudClosedThenLocal(BUDGET_META)).handle({ ...identity, channel: "voice" }, NEUTRAL_ASK);
    expect(result.reply).toBe("svar");
  });

  it("UTEN kreditten (ingen `claude_budget` i metadata) er svaret byte-identisk med main: den vanlige reservemerknaden, ingen kreditt-merknad", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await engine(cloudClosedThenLocal()).handle(identity, NEUTRAL_ASK);
    expect(result.reply).toContain("(Reservemodell brukt: anthropic var ikke tilgjengelig");
    expect(result.reply).not.toContain("Claude-kreditten");
  });

  it("en NEDGRADERT eller tillatt tur (ikke stengt) gir ingen merknad", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gw = { completeWithTools: async () => ({ text: "svar", usage, provider: "anthropic", model: "claude-haiku-4-5-20251001", metadata: { claude_budget: { ...BUDGET_META.claude_budget, action: "downgrade", constraint: "cheaper_model" } } }) };
    expect((await engine(gw).handle(identity, NEUTRAL_ASK)).reply).toBe("svar");
  });

  it("ingen lokal modell: ClaudeBudgetBlockedError gir den tydelige norske teksten som svar (routed: blocked), ikke en kastet feil", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocked = new ClaudeBudgetBlockedError("exhausted", "exhausted", "essential", "exhausted_closed", WINDOW_END, WINDOW_END);
    const gw = { completeWithTools: async (input: CompleteInput) => { if (input.providerPreference?.[0] === "anthropic") throw new NoEligibleProviderError(PREFERENCE_EXHAUSTED); throw blocked; } };
    const tokens: string[] = [];
    const result = await engine(gw).handle(identity, NEUTRAL_ASK, (t: string) => { tokens.push(t); });
    expect(result.routed).toBe("blocked");
    expect(result.reply).toBe(blocked.message);
    expect(result.reply).toContain("Claude-kreditten for perioden er brukt opp");
    expect(result.reply).toContain("fornyes 15. desember");
    expect(tokens.join("")).toContain("brukt opp");
    expect(classifyContentSensitivity({ texts: [result.reply] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
  });
});

describe("delegerte jobber (executive-handler) - opphav og merknad", () => {
  const route = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const TOOLS: MeshToolMapping[] = [{
    def: { name: "read_github_prs", description: "Les PR-er", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }, tool_id: "github", action: "list_pull_requests"
  } as unknown as MeshToolMapping];
  const jobCtx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };
  const task = (data: Record<string, unknown>): ClaimedTask => ({
    task_id: "task-b4-1", tenant_id: "tenant-personal", attempts: 1, checkpoint: null,
    contract: { goal: "list PR-er", owner_person_id: "person-tobias", tenant_id: "tenant-personal", allowed_memory_spaces: ["personal"], input: { data, trust_level: "internal", provenance: "chat:s1" }, allowed_tools: ["github"] } as unknown as JobContract
  });
  const delegated = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    prompt: "list åpne PR-er i repoet", purpose: "BACKGROUND", sensitivity: "PRIVATE", paid_models_allowed: false, delegated_from_chat: true, tools: true, cloud_tool_turns_allowed: true, ...extra
  });
  function handler(gatewayExtra: Record<string, unknown>, metadata?: Record<string, unknown>) {
    const seen: CompleteInput[] = [];
    const gateway = {
      ...gatewayExtra,
      completeWithTools: async (input: CompleteInput) => { seen.push(input); return { text: "Det er én åpen PR.", usage, provider: "gemma_local", model: "m", metadata: { tool_rounds: 0, ...(metadata ?? {}) } }; },
      complete: async (input: CompleteInput) => { seen.push(input); return { text: "Det er én åpen PR.", usage, provider: "gemma_local", model: "m", ...(metadata !== undefined ? { metadata } : {}) }; }
    } as unknown as ModelGateway;
    const run = executiveHandler({ gateway, tools: { all: TOOLS, executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor }, toolTurnRoute: route });
    return { run, seen };
  }

  it("UTEN kreditten (gatewayen mangler egenskapen, eller den er false) bærer innputtet ikke `budget_origin` - nøkkelen finnes ikke engang", async () => {
    for (const extra of [{}, { claudeBudgetActive: false }]) {
      const { run, seen } = handler(extra);
      await run(task(delegated()), jobCtx);
      await run(task(delegated({ tools: false, cloud_tool_turns_allowed: false })), jobCtx);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const input of seen) expect("budget_origin" in input, JSON.stringify(Object.keys(input))).toBe(false);
    }
  });

  it("MED kreditten: en jobb delegert fra chat OG attestert av trusted kode (`cloud_tool_turns_allowed`) er en bestilt oppgave (owner_task) - på skyruten og uten verktøy; uten attesteringen, uten markør eller planlagt får den ikke hintet (M2, se wpb4-review-fixes.test.ts)", async () => {
    const { run, seen } = handler({ claudeBudgetActive: true });
    await run(task(delegated()), jobCtx); // skyrute
    await run(task(delegated({ tools: false })), jobCtx); // uten verktøy
    expect(seen).toHaveLength(2);
    for (const input of seen) expect(input.budget_origin).toBe("owner_task");
    const other = handler({ claudeBudgetActive: true });
    await other.run(task(delegated({ cloud_tool_turns_allowed: false })), jobCtx); // markør uten attestering (lokalt betjent tur eller forfalsket)
    await other.run(task(delegated({ delegated_from_chat: false })), jobCtx);
    await other.run(task({ prompt: "planlagt jobb", purpose: "BACKGROUND" }), jobCtx);
    expect(other.seen).toHaveLength(3);
    for (const input of other.seen) expect("budget_origin" in input).toBe(false);
  });

  it("jobbens svar får merknaden FORAN teksten når kreditten stengte Anthropic - og ingenting uten kreditten", async () => {
    const withBudget = handler({ claudeBudgetActive: true }, BUDGET_META);
    const result = await withBudget.run(task(delegated()), jobCtx);
    expect(result["text"]).toBe("(Claude-kreditten: perioden er brukt opp, så jobben kom fra den lokale modellen. Kreditten fornyes 15. desember.)\n\nDet er én åpen PR.");
    const plain = handler({});
    expect((await plain.run(task(delegated()), jobCtx))["text"]).toBe("Det er én åpen PR.");
  });
});
