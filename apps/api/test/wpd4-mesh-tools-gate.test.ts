import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { ContextBuilder, MessageStore } from "@jarvis/core";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError, type ModelProviderAdapter, type ModelResult, type StreamEvent, type ToolResultMessage } from "@jarvis/provider-adapters";
import type { InProcessWorker, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { parseChatCandidates } from "../src/chat-candidates.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M3) mot den EKTE samtalemotoren og en EKTE `ModelGateway`: D-404-omkjøringen (siste reserve gjennom vanlig AUTO-ruting) skal ikke velge Kimi/Hermes til verktøyløkker, og Kimi
 * ikke til streaming-reserve, før eieren har erklært dem live-verifisert (`meshToolsVerified` = `JARVIS_MESH_TOOLS_VERIFIED`). Porten selv er testet i `modules/model-gateway/test/wpd4-mesh-tools-gate.test.ts`.
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5", kimi: "kimi-k3", hermes: "Hermes-4-70B" };
type Step = "ok" | ProviderError["kind"];

function adapter(name: string, step: Step, calls: string[]): ModelProviderAdapter {
  const run = (): ModelResult => {
    calls.push(name);
    if (step !== "ok") throw new ProviderError(name, step, `${name}_${step}`);
    return { text: `svar fra ${name}`, usage: { input_tokens: 5, output_tokens: 5 }, provider: name, model: MODELS[name] ?? "m", finish_reason: "stop" };
  };
  return {
    name, model: MODELS[name] ?? "m", available: () => true,
    complete: async () => run(),
    stream: async (_req, onEvent: (e: StreamEvent) => void) => {
      const r = run();
      onEvent({ type: "start", provider: name, model: r.model, generation_id: "g" });
      onEvent({ type: "text_delta", text: r.text });
      onEvent({ type: "usage", usage: r.usage });
      onEvent({ type: "finish", finish_reason: "stop" });
      return r;
    }
  };
}

function pool(): pg.Pool {
  const query = async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 });
  return { connect: async () => ({ query, release: () => undefined }), query } as unknown as pg.Pool;
}

const definitions = [{ name: "read_calendar", description: "Les kalenderen", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
const LIMITS = { max_tools_per_round: 4, max_schema_tokens: 1500, max_rounds: 4, max_calls_per_round: 4, max_total_calls: 8 };
const calendarExecutor: ToolExecutor = {
  execute: async (c): Promise<ToolResultMessage> => ({ tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e1", success: true, at: new Date().toISOString(), output: { events: [] } })
};

function world(steps: Record<string, Step>, opts: { verified?: string[]; tools?: boolean } = {}) {
  const calls: string[] = [];
  const p = pool();
  const gateway = new ModelGateway({
    pool: p, trace: new MemoryTraceSink(), providers: Object.entries(steps).map(([name, step]) => adapter(name, step, calls)),
    ...(opts.verified !== undefined ? { meshToolsVerified: opts.verified } : {})
  });
  const engine = new ConversationEngine({
    messages: new MessageStore(p), context: new ContextBuilder(p), gateway,
    tasks: {} as unknown as TaskService, worker: {} as unknown as InProcessWorker, trace: new MemoryTraceSink(),
    chatCandidates: parseChatCandidates(undefined, undefined),
    ...(opts.tools ? { tools: { definitions, executorFor: () => calendarExecutor, select: () => ({ definitions, limits: LIMITS, tool_ids: ["calendar"] }) } } : {})
  });
  return { engine, calls };
}

const identity = (): IdentityContext => ({ person_id: "p1", tenant_id: "t1", memory_space_id: "personal", session_id: "s1", device_id: "d1", channel: "web", auth_strength: "active" });
const CALENDAR = "hva står i kalenderen min?";
const PLAIN = "fortell meg en kort vits om katter";
const NEVER = (calls: string[]) => calls.filter((c) => c === "kimi" || c === "hermes");
afterEach(() => { vi.restoreAllMocks(); });
const quiet = () => { vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); };
const ALL_DOWN_LOCAL: Record<string, Step> = { gemma_local: "network", gemma_hosted: "network", kimi: "ok", hermes: "ok", openai: "ok", anthropic: "ok" };

describe("M3: D-404-omkjøringen for en verktøytur", () => {
  it("kjeden (gemma_local, gemma_hosted) er nede: omkjøringen velger openai/anthropic - kimi og hermes får ikke et eneste kall uten erklæring", async () => {
    quiet();
    const w = world(ALL_DOWN_LOCAL, { tools: true });
    const reply = await w.engine.handle(identity(), CALENDAR);
    expect(NEVER(w.calls)).toEqual([]);
    expect(reply.reply).toMatch(/^svar fra (openai|anthropic)\n\n\(Reservemodell brukt: .*skymodellen (openai|anthropic)\.\)$/);
  });

  it("med JARVIS_MESH_TOOLS_VERIFIED=hermes,kimi (meshToolsVerified) er de tilbake på sine etablerte plasser: hermes tar omkjøringen", async () => {
    quiet();
    const w = world(ALL_DOWN_LOCAL, { tools: true, verified: ["hermes", "kimi"] });
    const reply = await w.engine.handle(identity(), CALENDAR);
    expect(w.calls.filter((c) => !c.startsWith("gemma_"))[0]).toBe("hermes");
    expect(reply.reply).toMatch(/^svar fra hermes/);
  });

  it("kun kimi/hermes igjen (resten er forsøkt eller ikke konfigurert) og uten erklæring: den OPPRINNELIGE feilen kastes - aldri et stille kall til en uverifisert leverandør", async () => {
    quiet();
    const w = world({ gemma_local: "network", gemma_hosted: "network", kimi: "ok", hermes: "ok" }, { tools: true });
    await expect(w.engine.handle(identity(), CALENDAR)).rejects.toMatchObject({ kind: "network" });
    expect(NEVER(w.calls)).toEqual([]);
  });
});

describe("M3: Kimi som siste reserve for streaming-chat", () => {
  it("streamet vanlig prat, kjeden nede, kun kimi igjen: uten erklæring kastes den opprinnelige feilen (kimi påstår streaming, men er ikke live-verifisert)", async () => {
    quiet();
    const w = world({ gemma_local: "network", gemma_hosted: "network", kimi: "ok" });
    const tokens: string[] = [];
    await expect(w.engine.handle(identity(), PLAIN, (t) => tokens.push(t))).rejects.toMatchObject({ kind: "network" });
    expect(NEVER(w.calls)).toEqual([]);
    expect(tokens).toEqual([]);
  });

  it("med erklæring for kimi er den siste reserve for streaming-chat igjen, og reservebruken er synlig", async () => {
    quiet();
    const w = world({ gemma_local: "network", gemma_hosted: "network", kimi: "ok" }, { verified: ["kimi"] });
    const tokens: string[] = [];
    const reply = await w.engine.handle(identity(), PLAIN, (t) => tokens.push(t));
    expect(reply.reply).toContain("svar fra kimi");
    expect(reply.reply).toContain("Reservemodell brukt");
    expect(reply.reply).toContain("skymodellen kimi");
  });

  it("ikke-streamet vanlig tekst (ingen påstått-men-uverifisert capability kreves): kimi er fortsatt kvalifisert som før - porten gjelder kun verktøykall og streaming", async () => {
    quiet();
    const w = world({ gemma_local: "network", gemma_hosted: "network", kimi: "ok" });
    const reply = await w.engine.handle(identity(), PLAIN);
    expect(reply.reply).toContain("svar fra kimi");
  });
});
