import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import { AiRouter, CapabilityRegistry, LocalModelUnavailableError, MemoryTraceSink, ModelGateway, NoEligibleProviderError, ProviderHealthTracker, type RouteInput, type ToolExecutor } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M5 v): `localOnlyRouting` (verktøyløkkens `localStickiness`) har TO uavhengige lag: (1) `mode: "LOCAL"` og (2) preferanselisten filtrert til lokale leverandører. Hver for seg stenger skyen
 * for en preferanseliste med en skyreserve - og derfor overlevde mutanten som fjernet ett av dem, fordi det andre dekket for det. Her testes hvert lag ALENE: laget i ruteren (1) med en ufiltrert liste, og filteret (2)
 * ved å lese hva gatewayen faktisk ber ruteren om i hver runde.
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", local_llm: "local-model", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5" };
const runtimes = (configured: string[]) => new Map(Object.keys(MODELS).map((n) => [n, { configured: configured.includes(n), model: MODELS[n] as string }]));
const router = () => new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
const ALL = Object.keys(MODELS);

describe("lag 1 ALENE: mode LOCAL i ruteren stenger en skyreserve i en UFILTRERT preferanseliste", () => {
  it("blandet liste: kun de lokale medlemmene blir kandidater, i listerekkefølge", () => {
    const plan = router().plan({ mode: "LOCAL", providerPreference: ["anthropic", "gemma_local", "openai", "local_llm"], preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL));
    expect(plan.candidates.map((c) => c.provider)).toEqual(["gemma_local", "local_llm"]);
  });
  it("kun skymedlemmer: feiler lukket med årsaken (not_local) - ingen stille skyvei", () => {
    expect(() => router().plan({ mode: "LOCAL", providerPreference: ["anthropic", "openai"], preferenceFailover: true }, runtimes(ALL))).toThrow(/provider_preference_exhausted.*anthropic:not_local.*openai:not_local/);
    expect(() => router().plan({ mode: "LOCAL", providerPreference: ["anthropic"] }, runtimes(ALL))).toThrow(NoEligibleProviderError);
  });
  it("uten mode LOCAL (kontroll) ville den samme listen sluppet skyen til", () => {
    expect(router().plan({ providerPreference: ["anthropic", "gemma_local"], preferenceFailover: true }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(["anthropic", "gemma_local"]);
  });
  it("tom liste (alle skymedlemmer filtrert bort) faller til skårede ruter MED mode LOCAL: kun lokale, ellers LocalModelUnavailableError", () => {
    expect(router().plan({ mode: "LOCAL", providerPreference: [] }, runtimes(["gemma_local", "anthropic"])).candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
    expect(() => router().plan({ mode: "LOCAL", providerPreference: [] }, runtimes(["anthropic", "openai"]))).toThrow(LocalModelUnavailableError);
  });
});

// --- gjennom en EKTE ModelGateway --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hva husker du om hytta vår" }] };
const TOOLS = [{ name: "search_my_memory", description: "Søk i minnet", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }];
const memoryCall = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "search_my_memory", arguments: {}, provider, model: MODELS[provider] ?? "m" });
const reply = (provider: string, extra: Partial<ModelResult> = {}): ModelResult => ({ text: "", usage: { input_tokens: 1, output_tokens: 1 }, provider, model: MODELS[provider] ?? "m", finish_reason: "stop", ...extra });
const executor: ToolExecutor = {
  execute: async (call): Promise<ToolResultMessage> => ({ tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), source: "memory.search", output: [{ content: "SPECIAL-HEMMELIG", sensitivity: "special" }] })
};

function build(opts: { localRound2: "ok" | "fail"; cloudRound1Fails?: boolean }) {
  const calls: string[] = [];
  const local: ModelProviderAdapter = {
    name: "gemma_local", model: MODELS["gemma_local"] as string, available: () => true,
    complete: async (req) => {
      calls.push(`gemma_local:${req.tool_exchanges === undefined ? "r1" : "r2"}`);
      if (req.tool_exchanges === undefined) return reply("gemma_local", { finish_reason: "tool_calls", tool_calls: [memoryCall("gemma_local")] });
      if (opts.localRound2 === "fail") throw new ProviderError("gemma_local", "server", "nede");
      return reply("gemma_local", { text: "lokalt svar" });
    }
  };
  const cloud: ModelProviderAdapter = {
    name: "anthropic", model: MODELS["anthropic"] as string, available: () => true,
    complete: async (req) => {
      calls.push(`anthropic:${req.tool_exchanges === undefined ? "r1" : "r2"}`);
      if (opts.cloudRound1Fails && req.tool_exchanges === undefined) throw new ProviderError("anthropic", "timeout", "tidsavbrudd");
      return reply("anthropic", { text: "skyens svar" });
    }
  };
  const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [local, cloud] });
  return { gateway, calls };
}
const base = { tenant_id: "t1", purpose: "CHAT" as const, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" as const, request: REQUEST };
afterEach(() => { vi.restoreAllMocks(); });

describe("lag 2 ALENE (og begge): hva gatewayen ber ruteren om i hver runde med localStickiness og en preferanseliste med skyreserve", () => {
  it("runde 1 bruker den hele listen uten mode; så snart en lokal modell har betjent en runde er runde 2 FILTRERT til lokale OG mode LOCAL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planSpy = vi.spyOn(AiRouter.prototype, "plan");
    const { gateway, calls } = build({ localRound2: "ok" });
    const out = await gateway.completeWithTools({ ...base, providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true }, { tools: TOOLS, executor, localStickiness: true });
    expect(out.provider).toBe("gemma_local");
    expect(calls).toEqual(["gemma_local:r1", "gemma_local:r2"]);
    const inputs = planSpy.mock.calls.map((c) => c[0] as RouteInput);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.providerPreference).toEqual(["gemma_local", "anthropic"]);
    expect(inputs[0]?.mode).toBeUndefined();
    // lag 2: filteret - skyreserven er borte fra listen. Mutanten som fjerner filteret gir ["gemma_local", "anthropic"] her.
    expect(inputs[1]?.providerPreference).toEqual(["gemma_local"]);
    // lag 1: mode LOCAL. Mutanten som fjerner mode gir undefined her.
    expect(inputs[1]?.mode).toBe("LOCAL");
  });

  it("uten localStickiness (som før) er runde 2 ufiltrert og uten mode - lagene er et resultat av stickiness, ikke noe som alltid skjer", async () => {
    const planSpy = vi.spyOn(AiRouter.prototype, "plan");
    const { gateway } = build({ localRound2: "ok" });
    await gateway.completeWithTools({ ...base, providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true }, { tools: TOOLS, executor });
    const inputs = planSpy.mock.calls.map((c) => c[0] as RouteInput);
    expect(inputs[1]?.providerPreference).toEqual(["gemma_local", "anthropic"]);
    expect(inputs[1]?.mode).toBeUndefined();
  });

  it("lokal modell feiler i runde 2: løkken feiler ærlig og skyen får ALDRI et kall (verken runde 1 eller 2), med preferanseliste", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { gateway, calls } = build({ localRound2: "fail" });
    await expect(gateway.completeWithTools({ ...base, providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true }, { tools: TOOLS, executor, localStickiness: true })).rejects.toMatchObject({ provider: "gemma_local" });
    expect(calls.filter((c) => c.startsWith("anthropic"))).toEqual([]);
  });

  it("uten preferanseliste (AUTO) er mode LOCAL det eneste laget: runde 2 har mode LOCAL og ingen liste, og skyen får aldri et kall", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planSpy = vi.spyOn(AiRouter.prototype, "plan");
    // QUALITY foretrekker skyen; den får tidsavbrudd i runde 1, så den lokale modellen tar runden - og er dermed «klistret» i runde 2.
    const { gateway, calls } = build({ localRound2: "fail", cloudRound1Fails: true });
    await expect(gateway.completeWithTools({ ...base, mode: "QUALITY" }, { tools: TOOLS, executor, localStickiness: true })).rejects.toMatchObject({ provider: "gemma_local" });
    const inputs = planSpy.mock.calls.map((c) => c[0] as RouteInput);
    expect(inputs.at(-1)?.mode).toBe("LOCAL");
    expect(inputs.at(-1)?.providerPreference).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("anthropic") && c.endsWith("r2"))).toEqual([]);
    expect(calls).toContain("gemma_local:r1");
  });
});
