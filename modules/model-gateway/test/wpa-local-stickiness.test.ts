import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type ToolCallRequest,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "../src/index.ts";

/**
 * Gjennomgang av WP-A (D-451, funn 4, bekreftet med ekte gateway): hver verktøyrunde planlegges på nytt. Når skyen har tidsavbrudd i runde 1 og en lokal modell tar runden (og ber om verktøy), kan
 * skyen overta runde 2 og får da `tool_exchanges` med det den lokale runden så og ba om. Med `localStickiness` blir resten av løkken lokal så snart en lokal modell har betjent en runde.
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hva husker du om hytta vår" }] };
const TOOLS = [{ name: "search_my_memory", description: "Søk i minnet", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } }];
const SECRET = "SPECIAL-HEMMELIG psykiater onsdag";

const memoryCall = (provider: string, model: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "search_my_memory", arguments: {}, provider, model });
const result = (provider: string, model: string, extra: Partial<ModelResult> = {}): ModelResult => ({ text: "", usage: { input_tokens: 1, output_tokens: 1 }, provider, model, finish_reason: "stop", ...extra });

interface Seen { anthropicRequests: ModelRequest[]; localRequests: ModelRequest[]; executions: ToolCallRequest[] }

function build(opts: { cloudFirstFails?: boolean; cloudRound2?: "answer" | "throw" } = {}): { gateway: ModelGateway; seen: Seen; executor: ToolExecutor } {
  const seen: Seen = { anthropicRequests: [], localRequests: [], executions: [] };
  const anthropic: ModelProviderAdapter = {
    name: "anthropic", model: "claude-x", available: () => true,
    complete: async (req) => {
      seen.anthropicRequests.push(req);
      if (req.tool_exchanges === undefined && opts.cloudFirstFails !== false) throw new ProviderError("anthropic", "timeout", "tidsavbrudd");
      if (opts.cloudRound2 === "throw") throw new ProviderError("anthropic", "server", "nede");
      return result("anthropic", "claude-x", { text: "skyens svar" });
    }
  };
  const local: ModelProviderAdapter = {
    name: "gemma_local", model: "gemma3", available: () => true,
    complete: async (req) => {
      seen.localRequests.push(req);
      if (req.tool_exchanges === undefined) return result("gemma_local", "gemma3", { finish_reason: "tool_calls", tool_calls: [memoryCall("gemma_local", "gemma3")] });
      return result("gemma_local", "gemma3", { text: "lokalt svar" });
    }
  };
  const executor: ToolExecutor = {
    execute: async (call): Promise<ToolResultMessage> => {
      seen.executions.push(call);
      return { tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), source: "memory.search", output: [{ content: SECRET, sensitivity: "special" }] };
    }
  };
  // QUALITY foretrekker skymodellen først; gemma_local er neste kandidat. Bakgrunnsformål: et tidsavbrudd straffer ikke helsetilstanden, så skyen er fortsatt kandidat i runde 2.
  const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, local] });
  return { gateway, seen, executor };
}

const baseInput = { tenant_id: "t1", purpose: "BACKGROUND" as const, mode: "QUALITY" as const, request: REQUEST };

describe("WP-A: localStickiness i verktøyløkken", () => {
  it("UTEN localStickiness (som før): skyen overtar runde 2 og får det den lokale runden så (faren gjennomgangen påviste)", async () => {
    const { gateway, seen, executor } = build();
    const out = await gateway.completeWithTools(baseInput, { tools: TOOLS, executor });
    expect(out.provider).toBe("anthropic");
    const cloudRound2 = seen.anthropicRequests.find((r) => r.tool_exchanges !== undefined);
    expect(JSON.stringify(cloudRound2?.tool_exchanges ?? [])).toContain("SPECIAL-HEMMELIG");
  });

  it("MED localStickiness: etter en lokal runde forblir resten av løkken lokal - skyen får aldri se verktøykall eller -resultater fra den lokale runden", async () => {
    const { gateway, seen, executor } = build();
    const out = await gateway.completeWithTools(baseInput, { tools: TOOLS, executor, localStickiness: true });
    expect(out.provider).toBe("gemma_local");
    expect(out.text).toBe("lokalt svar");
    expect(seen.anthropicRequests.every((r) => r.tool_exchanges === undefined)).toBe(true);
    expect(JSON.stringify(seen.anthropicRequests)).not.toContain("SPECIAL-HEMMELIG");
    expect(seen.localRequests.some((r) => r.tool_exchanges !== undefined)).toBe(true);
  });

  it("MED localStickiness feiler den lokale modellen i runde 2, feiler løkken ærlig i stedet for å eskalere til skyen", async () => {
    const seen: string[] = [];
    const anthropic: ModelProviderAdapter = {
      name: "anthropic", model: "claude-x", available: () => true,
      complete: async (req) => {
        seen.push(JSON.stringify(req.tool_exchanges ?? null));
        if (req.tool_exchanges === undefined) throw new ProviderError("anthropic", "timeout", "tidsavbrudd");
        return result("anthropic", "claude-x", { text: "skyens svar" });
      }
    };
    let localCalls = 0;
    const local: ModelProviderAdapter = {
      name: "gemma_local", model: "gemma3", available: () => true,
      complete: async (req) => {
        localCalls += 1;
        if (req.tool_exchanges === undefined) return result("gemma_local", "gemma3", { finish_reason: "tool_calls", tool_calls: [memoryCall("gemma_local", "gemma3")] });
        throw new ProviderError("gemma_local", "server", "lokal modell døde");
      }
    };
    const executor: ToolExecutor = {
      execute: async (call) => ({ tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: [{ content: SECRET }] })
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, local] });
    await expect(gateway.completeWithTools(baseInput, { tools: TOOLS, executor, localStickiness: true })).rejects.toThrow();
    expect(localCalls).toBeGreaterThanOrEqual(2);
    expect(seen.join("")).not.toContain("SPECIAL-HEMMELIG");
  });

  it("en løkke som er skybetjent hele veien påvirkes ikke (ingen låsing når ingen lokal runde har skjedd)", async () => {
    const rounds: ModelRequest[] = [];
    const cloud: ModelProviderAdapter = {
      name: "anthropic", model: "claude-x", available: () => true,
      complete: async (req) => {
        rounds.push(req);
        if (req.tool_exchanges === undefined) return result("anthropic", "claude-x", { finish_reason: "tool_calls", tool_calls: [memoryCall("anthropic", "claude-x")] });
        return result("anthropic", "claude-x", { text: "ferdig på skyen" });
      }
    };
    const executor: ToolExecutor = {
      execute: async (call) => ({ tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: [] })
    };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [cloud] });
    const out = await gateway.completeWithTools(baseInput, { tools: TOOLS, executor, localStickiness: true });
    expect(out.text).toBe("ferdig på skyen");
    expect(rounds).toHaveLength(2);
  });

  it("en preferanseliste snevres inn til lokale leverandører etter en lokal runde (ingen ny sky via preferansen)", async () => {
    const { gateway, seen, executor } = build();
    // En preferanseliste gir EN kandidat per runde (første kvalifiserte). Lokal først gir en lokal runde 1; etter den skal «anthropic» i listen ikke lenger være mulig.
    const out = await gateway.completeWithTools(
      { ...baseInput, mode: undefined as never, providerPreference: ["gemma_local", "anthropic"] },
      { tools: TOOLS, executor, localStickiness: true }
    );
    expect(out.provider).toBe("gemma_local");
    expect(seen.anthropicRequests).toHaveLength(0);
  });
  it("stickiness SNEVRER INN preferanselisten til lokale oppføringer: faller den lokale modellen bort etter runde 1, får skyen (neste i listen) IKKE verktøyresultatene - løkken feiler lukket (mutasjonsfunn m54)", async () => {
    const run = async (localStickiness: boolean) => {
      const anthropicSeen: ModelRequest[] = [];
      let localDown = false;
      const anthropic: ModelProviderAdapter = {
        name: "anthropic", model: "claude-x", available: () => true,
        complete: async (req) => { anthropicSeen.push(req); return result("anthropic", "claude-x", { text: "skyens svar" }); }
      };
      const local: ModelProviderAdapter = {
        name: "gemma_local", model: "gemma3", available: () => !localDown,
        complete: async () => { localDown = true; return result("gemma_local", "gemma3", { finish_reason: "tool_calls", tool_calls: [memoryCall("gemma_local", "gemma3")] }); }
      };
      const executor: ToolExecutor = {
        execute: async (call): Promise<ToolResultMessage> => ({ tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), source: "memory.search", output: [{ content: SECRET, sensitivity: "special" }] })
      };
      const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, local] });
      const outcome = await gateway.completeWithTools({ ...baseInput, providerPreference: ["gemma_local", "anthropic"] }, { tools: TOOLS, executor, ...(localStickiness ? { localStickiness: true } : {}) }).then((r) => ({ ok: r }), (e: unknown) => ({ error: e }));
      return { outcome, anthropicSeen };
    };
    // Kontroll: uten stickiness overtar skyen (neste i listen) runde 2 og får det den lokale runden så.
    const control = await run(false);
    expect("ok" in control.outcome && control.outcome.ok.provider).toBe("anthropic");
    expect(JSON.stringify(control.anthropicSeen)).toContain("SPECIAL-HEMMELIG");
    // Med stickiness er listen snevret inn til [gemma_local]: ingen kandidat er igjen, og skyen ser aldri noe.
    const sticky = await run(true);
    expect("error" in sticky.outcome).toBe(true);
    expect(String((sticky.outcome as { error: Error }).error)).toMatch(/provider_preference_exhausted|ikke konfigurert|NoEligible/i);
    expect(sticky.anthropicSeen).toEqual([]);
  });
});
