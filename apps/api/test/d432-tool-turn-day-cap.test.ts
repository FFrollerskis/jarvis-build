import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, type CompleteInput, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { DEFAULT_TOOL_TURN_DAILY_CAP_ORE, parseDailyCapOre } from "../src/tool-turn-route.ts";

/**
 * D-432: dagstak for verktøyturer til sky. Over taket (eller når kostnaden ikke kan leses) går verktøyturen lokalt, og svaret SIER det.
 * Kostnaden leses kun når turen faktisk ville gått til sky, og aldri for vanlig prat.
 */
const fakePool = (): pg.Pool => ({ connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }) }) as unknown as pg.Pool;
const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const LIMITS = { max_tools_per_round: 8, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 16 };
const def = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });
const route = { provider: "anthropic", model: "claude-sonnet-5-5" };

function build(opts: { tools: string[]; captured: CompleteInput[]; tokens?: string[]; dayCap?: { cap_ore: number; spentToday(t: string): Promise<number> } | null }): ConversationEngine {
  const gateway = {
    complete: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    stream: async () => ({ text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: "gemma_local", model: "m" }),
    completeWithTools: async (input: CompleteInput) => {
      opts.captured.push(input);
      return { text: "svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: "x", model: "m" };
    }
  } as unknown as ModelGateway;
  return new ConversationEngine({
    messages: new MessageStore(fakePool()), context: new ContextBuilder(fakePool()), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    toolTurnRoute: route,
    ...(opts.dayCap !== undefined ? { toolTurnDayCap: opts.dayCap } : {}),
    tools: {
      definitions: opts.tools.map(def),
      executorFor: () => ({ execute: async () => { throw new Error("ikke brukt"); } }) as unknown as ToolExecutor,
      select: () => ({ definitions: opts.tools.map(def), limits: LIMITS })
    }
  });
}
const ASK = "hva er neste punkt i planen min?";

describe("D-432: dagstak for verktøyturer til sky", () => {
  it("under taket → sky som før, og kostnaden leses for riktig tenant", async () => {
    const captured: CompleteInput[] = [];
    const seen: string[] = [];
    const engine = build({ tools: ["calendar__read_events"], captured, dayCap: { cap_ore: 3000, spentToday: async (t) => { seen.push(t); return 1200; } } });
    const result = await engine.handle(identity, ASK);
    expect(captured[0]?.providerPreference).toEqual(["anthropic"]);
    expect(result.reply).toBe("svar");
    expect(seen).toEqual(["t1"]);
  });

  it("taket nådd → lokal modell, uten skymodellens navn, og svaret og lagret melding SIER det", async () => {
    const captured: CompleteInput[] = [];
    const tokens: string[] = [];
    const engine = build({ tools: ["calendar__read_events"], captured, dayCap: { cap_ore: 3000, spentToday: async () => 3000 } });
    const result = await engine.handle(identity, ASK, (t: string) => { tokens.push(t); });
    expect(captured[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(captured[0]?.request.model).toBeUndefined();
    expect(result.reply).toContain("svar");
    expect(result.reply).toContain("Dagstaket for sky på 30 kr er nådd i dag");
    expect(tokens.join("")).toContain("Dagstaket for sky");
  });

  it("kostnaden kan ikke leses → feiler lukket (lokalt) med merknad, aldri ubegrenset sky", async () => {
    const captured: CompleteInput[] = [];
    const engine = build({ tools: ["calendar__read_events"], captured, dayCap: { cap_ore: 3000, spentToday: async () => { throw new Error("db nede"); } } });
    const result = await engine.handle(identity, ASK);
    expect(captured[0]?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
    expect(result.reply).toContain("Dagstaket");
  });

  it("vanlig prat (kun minne-reserven) leser ALDRI kostnaden og får ingen merknad", async () => {
    const captured: CompleteInput[] = [];
    let reads = 0;
    const engine = build({ tools: ["memory__search"], captured, dayCap: { cap_ore: 1, spentToday: async () => { reads += 1; return 999_999; } } });
    const result = await engine.handle(identity, ASK);
    expect(reads).toBe(0);
    expect(result.reply).toBe("svar");
  });

  it("uten dagstak (null/udefinert) → ingen begrensning og ingen kostnadsspørring", async () => {
    for (const dayCap of [null, undefined]) {
      const captured: CompleteInput[] = [];
      await build({ tools: ["calendar__read_events"], captured, ...(dayCap === null ? { dayCap: null } : {}) }).handle(identity, ASK);
      expect(captured[0]?.providerPreference).toEqual(["anthropic"]);
    }
  });
});

describe("D-432: parseDailyCapOre (JARVIS_TOOL_TURN_DAILY_CAP_ORE)", () => {
  it("tom = 3000 øre, 0 = ingen tak, tall parses, ugyldig faller til standard (aldri ubegrenset)", () => {
    expect(parseDailyCapOre(undefined)).toBe(DEFAULT_TOOL_TURN_DAILY_CAP_ORE);
    expect(parseDailyCapOre("  ")).toBe(3000);
    expect(parseDailyCapOre("0")).toBe(0);
    expect(parseDailyCapOre("1500")).toBe(1500);
    for (const bad of ["-5", "30 kr", "1e3", "abc", "12.5"]) expect(parseDailyCapOre(bad)).toBe(3000);
  });
});
