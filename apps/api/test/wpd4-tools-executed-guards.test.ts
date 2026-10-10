import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelResult, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { parseChatCandidates } from "../src/chat-candidates.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M5 i): `!toolsExecuted` i samtalemotorens tre reserveveier (D-404 siste reserve, D-431 skyrute → lokal, D-380 «lokal modell avviste verktøy → uten verktøy») er en
 * sikkerhetsvakt: har et verktøy ALLEREDE blitt utført i turen, kjøres turen aldri om fra begynnelsen (da utføres verktøyet to ganger - reviewerens mutant ga `executed=2` med alle 74 tester grønne). Her mot den
 * EKTE samtalemotoren og en EKTE `ModelGateway` med en eksekutor som teller utførelser. Hver vakt har en kontroll som viser at SAMME feil FØR noe er utført faktisk gir reserven (så testen når grenen).
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5" };
type Step = "ok" | "tool" | ProviderError["kind"];
const toolCall = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "read_calendar", arguments: {}, provider, model: MODELS[provider] ?? "m" });

function adapter(name: string, steps: Step[], calls: string[]): ModelProviderAdapter {
  let i = 0;
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async (req): Promise<ModelResult> => {
      calls.push(name);
      const step = steps[Math.min(i++, steps.length - 1)] as Step;
      const base = { usage: { input_tokens: 5, output_tokens: 5 }, provider: name, model: MODELS[name] ?? "m" };
      if (step === "ok") return { ...base, text: `svar fra ${name}`, finish_reason: "stop" };
      if (step === "tool") return req.tool_exchanges !== undefined ? { ...base, text: `ferdig fra ${name}`, finish_reason: "stop" } : { ...base, text: "", finish_reason: "tool_calls", tool_calls: [toolCall(name)] };
      throw new ProviderError(name, step, `${name}_${step}`);
    }
  };
}

function pool(): pg.Pool {
  const query = async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 });
  return { connect: async () => ({ query, release: () => undefined }), query } as unknown as pg.Pool;
}

const definitions = [{ name: "read_calendar", description: "Les kalenderen", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
const LIMITS = { max_tools_per_round: 4, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 8 };

function world(scripts: Record<string, Step[]>, opts: { cloudRoute?: boolean } = {}) {
  const calls: string[] = [];
  const executed: string[] = [];
  const executor: ToolExecutor = {
    execute: async (c): Promise<ToolResultMessage> => {
      executed.push(c.tool_name);
      return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: `e${executed.length}`, success: true, at: new Date().toISOString(), output: { events: [] } };
    }
  };
  const p = pool();
  const gateway = new ModelGateway({ pool: p, trace: new MemoryTraceSink(), providers: Object.entries(scripts).map(([name, steps]) => adapter(name, steps, calls)) });
  const engine = new ConversationEngine({
    messages: new MessageStore(p), context: new ContextBuilder(p), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    chatCandidates: parseChatCandidates(undefined, undefined),
    ...(opts.cloudRoute ? { toolTurnRoute: { provider: "anthropic", model: "claude-sonnet-5-5" } } : {}),
    tools: { definitions, executorFor: () => executor, select: () => ({ definitions, limits: LIMITS, tool_ids: ["calendar"] }) }
  });
  return { engine, calls, executed };
}

const identity: IdentityContext = { person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" };
const ASK = "hva står i kalenderen min?";
afterEach(() => { vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); };

describe("D-404: siste reserve (vanlig ruting) kjøres aldri om etter at et verktøy er utført", () => {
  it("runde 1 utfører verktøyet lokalt, runde 2 feiler lokalt (nett): feilen kommer tilbake, verktøyet er utført NØYAKTIG én gang, og skyen får ikke et eneste kall", async () => {
    quiet();
    // anthropic ville bedt om det samme verktøyet igjen i en omkjøring (executed=2 uten vakten)
    const w = world({ gemma_local: ["tool", "network", "network"], anthropic: ["tool"] });
    await expect(w.engine.handle(identity, ASK)).rejects.toMatchObject({ provider: "gemma_local", kind: "network" });
    expect(w.executed).toEqual(["read_calendar"]);
    expect(w.calls).toEqual(["gemma_local", "gemma_local", "gemma_local"]);
    expect(w.calls).not.toContain("anthropic");
  });

  it("kontroll: samme feil FØR noe er utført gir reserven - verktøyet utføres én gang (hos reserven), og svaret sier det", async () => {
    quiet();
    const w = world({ gemma_local: ["network", "network"], anthropic: ["tool"] });
    const reply = await w.engine.handle(identity, ASK);
    expect(w.executed).toEqual(["read_calendar"]);
    expect(reply.reply).toContain("ferdig fra anthropic");
    expect(reply.reply).toContain("Reservemodell brukt");
  });
});

describe("D-431: skyrute → lokal reserve kjøres aldri om etter at et verktøy er utført", () => {
  it("skyen utfører verktøyet i runde 1 og tidsavbryter i runde 2: feilen kommer tilbake, verktøyet er utført ÉN gang, og den lokale modellen får ikke et kall", async () => {
    quiet();
    const w = world({ anthropic: ["tool", "timeout", "timeout"], gemma_local: ["tool"] }, { cloudRoute: true });
    await expect(w.engine.handle(identity, ASK)).rejects.toMatchObject({ provider: "anthropic", kind: "timeout" });
    expect(w.executed).toEqual(["read_calendar"]);
    expect(w.calls).not.toContain("gemma_local");
  });

  it("kontroll: skyen nede FØR noe er utført gir den lokale reserven, og verktøyet utføres én gang", async () => {
    quiet();
    const w = world({ anthropic: ["timeout", "timeout"], gemma_local: ["tool"] }, { cloudRoute: true });
    const reply = await w.engine.handle(identity, ASK);
    expect(w.executed).toEqual(["read_calendar"]);
    expect(reply.reply).toContain("ferdig fra gemma_local");
  });
});

describe("D-380: «lokal modell avviste verktøy → svar uten verktøy» gjøres aldri etter at et verktøy er utført", () => {
  it("runde 2 gir bad_request fra den lokale modellen etter en utført lesing: feilen kommer tilbake i stedet for et svar som later som om verktøyresultatet ikke fantes", async () => {
    quiet();
    const w = world({ gemma_local: ["tool", "bad_request", "ok"] });
    await expect(w.engine.handle(identity, ASK)).rejects.toMatchObject({ provider: "gemma_local", kind: "bad_request" });
    expect(w.executed).toEqual(["read_calendar"]);
    expect(w.calls).toEqual(["gemma_local", "gemma_local"]); // ingen tredje (verktøyløs) omkjøring
  });

  it("kontroll: bad_request FØR noe er utført gir svar uten verktøy fra samme modell", async () => {
    quiet();
    const w = world({ gemma_local: ["bad_request", "ok"] });
    const reply = await w.engine.handle(identity, ASK);
    expect(reply.reply).toBe("svar fra gemma_local");
    expect(w.executed).toEqual([]);
  });
});
