import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, NoEligibleProviderError, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ProviderError } from "@jarvis/provider-adapters";
import { ConversationEngine } from "../src/conversation.ts";
import { DEFAULT_TOOL_TURN_ROUTE, parseToolTurnRoute } from "../src/tool-turn-route.ts";

/**
 * D-431: ren prat går til den lokale modellen, verktøyturer til skymodellen fra `toolTurnRoute` (standard Sonnet 5.5). Aldri for
 * SECRET_RESTRICTED, aldri over en eksplisitt eier-override, og en fallback til lokal arver aldri skymodellens navn.
 */
const fakePool = (): pg.Pool => {
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
};
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };
const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });
const route = { provider: "anthropic", model: "claude-sonnet-5-5" };

function build(opts: {
  tools: string[];
  /** Q-53 A: `tool_id` for hver verktøydefinisjon (som `select()` i main.ts); udefinert = eldre oppsett som avgjør «reserven» av navnet. */
  toolIds?: string[];
  toolTurnRoute?: { provider: string; model?: string } | null;
  minSensitivity?: "SECRET_RESTRICTED";
  onTools?: (input: CompleteInput) => Promise<{ text: string }>;
  captured: CompleteInput[];
}): ConversationEngine {
  const gateway = {
    complete: async () => ({ text: "uten verktøy", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    stream: async () => ({ text: "uten verktøy", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    completeWithTools: async (input: CompleteInput) => {
      opts.captured.push(input);
      const r = opts.onTools ? await opts.onTools(input) : { text: "ok" };
      return { ...r, usage: { input_tokens: 1, output_tokens: 1 }, provider: "x", model: "m" };
    }
  } as unknown as ModelGateway;
  return new ConversationEngine({
    messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    ...(opts.toolTurnRoute !== undefined ? { toolTurnRoute: opts.toolTurnRoute } : {}),
    tools: {
      definitions: opts.tools.map(def),
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      select: () => ({ definitions: opts.tools.map(def), limits: LIMITS, ...(opts.toolIds ? { tool_ids: opts.toolIds } : {}), ...(opts.minSensitivity ? { min_sensitivity: opts.minSensitivity } : {}) })
    }
  });
}
const ASK = "hva er neste punkt i planen min?";

describe("D-431: verktøyturer til skymodell, ren prat lokalt", () => {
  it("ekte verktøy valgt → providerPreference [anthropic] og modellen settes per kall", async () => {
    const captured: CompleteInput[] = [];
    await build({ tools: ["calendar__read_events"], toolTurnRoute: route, captured }).handle(identity, ASK);
    expect(captured[0]?.providerPreference).toEqual(["anthropic"]);
    expect(captured[0]?.request.model).toBe("claude-sonnet-5-5");
  });

  it("kun minne-reserven (memory__*) valgt → forblir lokal, ingen modell satt", async () => {
    const captured: CompleteInput[] = [];
    await build({ tools: ["memory__search"], toolTurnRoute: route, captured }).handle(identity, ASK);
    expect(captured[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(captured[0]?.request.model).toBeUndefined();
  });

  it("Q-53 A (D-450): produksjonens minneverktøy (search_my_memory/suggest_memory, tjeneste memory) er reserven → forblir lokal; sammen med et ekte verktøy går turen til sky", async () => {
    const memoryOnly: CompleteInput[] = [];
    await build({ tools: ["search_my_memory", "suggest_memory"], toolIds: ["memory", "memory"], toolTurnRoute: route, captured: memoryOnly }).handle(identity, ASK);
    expect(memoryOnly[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(memoryOnly[0]?.request.model).toBeUndefined();
    // Uten tool_ids (eldre oppsett) brukes de kjente navnene.
    const byName: CompleteInput[] = [];
    await build({ tools: ["search_my_memory"], toolTurnRoute: route, captured: byName }).handle(identity, ASK);
    expect(byName[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    const mixed: CompleteInput[] = [];
    await build({ tools: ["search_my_memory", "read_calendar"], toolIds: ["memory", "calendar"], toolTurnRoute: route, captured: mixed }).handle(identity, ASK);
    expect(mixed[0]?.providerPreference).toEqual(["anthropic"]);
    expect(mixed[0]?.request.model).toBe("claude-sonnet-5-5");
    // tool_ids vinner over navnet: et verktøy som HETER som minneverktøyet men tilhører en annen tjeneste er ikke reserven.
    const spoofed: CompleteInput[] = [];
    await build({ tools: ["search_my_memory"], toolIds: ["email"], toolTurnRoute: route, captured: spoofed }).handle(identity, ASK);
    expect(spoofed[0]?.providerPreference).toEqual(["anthropic"]);
  });

  it("uten toolTurnRoute (av) → alt lokalt som før", async () => {
    const captured: CompleteInput[] = [];
    await build({ tools: ["calendar__read_events"], toolTurnRoute: null, captured }).handle(identity, ASK);
    await build({ tools: ["calendar__read_events"], captured }).handle(identity, ASK);
    for (const c of captured) expect(c.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
  });

  it("SECRET_RESTRICTED (helse/finans) går ALDRI til sky, selv med verktøy", async () => {
    const captured: CompleteInput[] = [];
    await build({ tools: ["finance_neonomics__list_balances"], toolTurnRoute: route, minSensitivity: "SECRET_RESTRICTED", captured }).handle(identity, ASK);
    expect(captured[0]?.sensitivity).toBe("SECRET_RESTRICTED");
    expect(captured[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(captured[0]?.request.model).toBeUndefined();
  });

  it("eksplisitt eier-override («bruk bare lokale modeller») respekteres - ingen sky-rute", async () => {
    const captured: CompleteInput[] = [];
    await build({ tools: ["calendar__read_events"], toolTurnRoute: route, captured }).handle(identity, "bruk bare lokale modeller");
    expect(captured[0]?.mode).toBe("LOCAL");
    expect(captured[0]?.providerPreference).toBeUndefined();
    expect(captured[0]?.request.model).toBeUndefined();
  });

  it("skymodellen er nede (tidsavbrudd) før noe er utført → svar fra lokal modell, uten skymodellens navn", async () => {
    const captured: CompleteInput[] = [];
    const engine = build({
      tools: ["calendar__read_events"], toolTurnRoute: route, captured,
      onTools: async (input) => {
        if (input.providerPreference?.[0] === "anthropic") throw new ProviderError("anthropic", "timeout", "anthropic_timeout");
        return { text: "lokalt svar" };
      }
    });
    const result = await engine.handle(identity, ASK);
    expect(result.reply).toBe("lokalt svar");
    expect(captured).toHaveLength(2);
    expect(captured[1]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(captured[1]?.request.model).toBeUndefined();
  });

  it("skyleverandøren er ikke konfigurert (preference_exhausted) → normal ruting, uten skymodellens navn", async () => {
    const captured: CompleteInput[] = [];
    const engine = build({
      tools: ["calendar__read_events"], toolTurnRoute: route, captured,
      onTools: async (input) => {
        if (input.providerPreference) throw new NoEligibleProviderError("provider_preference_exhausted: ingen av [anthropic] er konfigurert/kvalifisert");
        return { text: "reserve" };
      }
    });
    const result = await engine.handle(identity, ASK);
    expect(result.reply).toBe("reserve");
    expect(captured[1]?.providerPreference).toBeUndefined();
    expect(captured[1]?.request.model).toBeUndefined();
  });
});

describe("D-431: parseToolTurnRoute (JARVIS_TOOL_TURN_MODEL)", () => {
  it("standard er Sonnet 5.5; provider:model parses; off/local/none slår av; ugyldig feiler lukket til av", () => {
    expect(parseToolTurnRoute(undefined)).toEqual(DEFAULT_TOOL_TURN_ROUTE);
    expect(parseToolTurnRoute("  ")).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(parseToolTurnRoute("anthropic:claude-haiku-4-5-20251001")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(parseToolTurnRoute("gemini:gemini-3.8-flash")).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
    for (const off of ["off", "OFF", "local", "none", "false"]) expect(parseToolTurnRoute(off)).toBeNull();
    for (const bad of ["claude-sonnet-5-5", ":x", "a b:c", "Anthropic:../x", "x:"]) expect(parseToolTurnRoute(bad)).toBeNull();
  });
});
