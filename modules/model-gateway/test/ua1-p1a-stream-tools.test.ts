import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ProviderError,
  ScriptedAdapter,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamEvent,
  type ToolCallRequest,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import {
  AiRouter,
  CapabilityRegistry,
  MemoryTraceSink,
  ModelGateway,
  NoEligibleProviderError,
  ProviderHealthTracker,
  validateToolArgs,
  type ToolExecutor
} from "../src/index.ts";

function fakePool(): { pool: pg.Pool; costInserts: unknown[][] } {
  const costInserts: unknown[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) costInserts.push(params ?? []);
      return { rows: [] };
    },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, costInserts };
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "test" }] };
const TOOLS = [
  {
    name: "read_calendar_today",
    description: "Les kalender",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
  },
  {
    name: "read_tasks",
    description: "Les oppgaver",
    input_schema: { type: "object", properties: { limit: { type: "number" } }, required: ["limit"], additionalProperties: false }
  }
];

function countingExecutor(): { executor: ToolExecutor; executions: ToolCallRequest[] } {
  const executions: ToolCallRequest[] = [];
  return {
    executions,
    executor: {
      async execute(call, ctx): Promise<ToolResultMessage> {
        executions.push(call);
        return {
          tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: ctx.idempotency_key,
          success: true, output: { data: `resultat-${call.tool_name}` }, at: new Date().toISOString()
        };
      }
    }
  };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  tool_call_id: id, tool_name: name, arguments: args, provider: "scripted", model: "scripted-1"
});

describe("P1A normalized streaming (§3-§9)", () => {
  it("streamer normaliserte events (start→text_delta→usage→finish) med ttft og kostrad", async () => {
    const { pool, costInserts } = fakePool();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "hei på deg")] });
    const events: StreamEvent[] = [];
    const result = await gateway.stream({ tenant_id: "tenant-a", purpose: "CHAT", request: REQUEST }, (e) => events.push(e));
    expect(events[0]?.type).toBe("start");
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("hei på deg");
    expect(result.text).toBe("hei på deg");
    expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)?.type).toBe("finish");
    expect(costInserts.some((p) => p[3] === "model:scripted")).toBe(true);
  });

  it("fallback FØR første output: fallback-event + sekundær provider fullfører (§10)", async () => {
    const { pool } = fakePool();
    const failing: ModelProviderAdapter = {
      name: "openai", model: "gpt-x", available: () => true,
      complete: async () => { throw new ProviderError("openai", "timeout", "sim"); },
      stream: async () => { throw new ProviderError("openai", "timeout", "sim"); }
    };
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [failing, new ScriptedAdapter(() => "reserve")] });
    const events: StreamEvent[] = [];
    const result = await gateway.stream({ tenant_id: "tenant-a", request: REQUEST }, (e) => events.push(e));
    expect(result.provider).toBe("scripted");
    const fb = events.find((e) => e.type === "fallback") as { from: string; to: string; reason: string };
    expect(fb.from).toBe("openai");
    expect(fb.to).toBe("scripted");
    expect(fb.reason).toBe("timeout");
  });

  it("ETTER output-start: stream markeres interrupted - aldri stille provider-bytte (§11)", async () => {
    const { pool } = fakePool();
    const dying: ModelProviderAdapter = {
      name: "openai", model: "gpt-x", available: () => true,
      complete: async () => { throw new Error("ubrukt"); },
      stream: async (_req, onEvent) => {
        onEvent({ type: "start", provider: "openai", model: "gpt-x", generation_id: "g1" });
        onEvent({ type: "text_delta", text: "delvis " });
        throw new ProviderError("openai", "stream_interrupted", "mistet forbindelsen");
      }
    };
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [dying, new ScriptedAdapter(() => "reserve")] });
    const events: StreamEvent[] = [];
    const err = await gateway.stream({ tenant_id: "tenant-a", request: REQUEST }, (e) => events.push(e)).then(() => null).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("stream_interrupted");
    expect(events.some((e) => e.type === "error" && e.category === "stream_interrupted")).toBe(true);
    expect(events.some((e) => e.type === "fallback")).toBe(false); // ingen skjult bytte
  });

  it("cancellation: ren avslutning, ingen health-straff, neste request fungerer (§9/§28/§35)", async () => {
    const { pool } = fakePool();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "en to tre fire fem")] });
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const err = await gateway
      .stream({ tenant_id: "tenant-a", request: REQUEST }, (e) => {
        events.push(e);
        if (e.type === "text_delta") controller.abort();
      }, controller.signal)
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("cancelled");
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    expect(gateway.meshStatus().providers.find((p) => p.provider === "scripted")?.failures).toBe(0);
    const next = await gateway.stream({ tenant_id: "tenant-a", request: REQUEST }, () => undefined);
    expect(next.text.length).toBeGreaterThan(0); // ingen zombie-state
  });
});

describe("P1A tool-løkke (§16, §19-§26, §30)", () => {
  it("tool call → trusted executor → resultat → modellen fortsetter med tool_exchanges (§16)", async () => {
    const { pool } = fakePool();
    const adapter = new ScriptedAdapter(
      () => "ferdig svar",
      (req) => (req.tool_exchanges ? [] : [call("c1", "read_calendar_today")])
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.completeWithTools({ tenant_id: "tenant-a", task_id: "t1", request: REQUEST }, { tools: TOOLS, executor });
    expect(result.text).toBe("ferdig svar");
    expect(executions.length).toBe(1);
    expect(result.metadata?.["tool_rounds"]).toBe(1);
    const secondRound = adapter.calls.find((r) => r.tool_exchanges);
    expect(secondRound?.tool_exchanges?.[0]?.results[0]?.success).toBe(true);
  });

  it("provider-feil ETTER utført verktøy: fallback-provider fortsetter fra persistert resultat - aldri dobbel utførelse (§21)", async () => {
    const { pool } = fakePool();
    let round2Attempts = 0;
    const flaky: ModelProviderAdapter = {
      name: "openai", model: "gpt-x", available: () => true,
      complete: async (req): Promise<ModelResult> => {
        if (!req.tool_exchanges) {
          return { text: "", usage: { input_tokens: 10, output_tokens: 2 }, provider: "openai", model: "gpt-x", finish_reason: "tool_calls",
            tool_calls: [{ tool_call_id: "c1", tool_name: "read_calendar_today", arguments: {}, provider: "openai", model: "gpt-x" }] };
        }
        round2Attempts += 1;
        throw new ProviderError("openai", "server", "dør etter verktøy");
      }
    };
    const { executor, executions } = countingExecutor();
    const fallbackAdapter = new ScriptedAdapter(() => "fullført av reserve");
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [flaky, fallbackAdapter] });
    const result = await gateway.completeWithTools({ tenant_id: "tenant-a", task_id: "t2", request: REQUEST }, { tools: TOOLS, executor });
    expect(result.text).toBe("fullført av reserve");
    expect(result.provider).toBe("scripted");
    expect(executions.length).toBe(1); // verktøyet kjørte NØYAKTIG én gang
    expect(round2Attempts).toBe(2); // 1 + én transient retry, deretter fallback
    const resumeReq = fallbackAdapter.calls.find((r) => r.tool_exchanges);
    expect(resumeReq?.tool_exchanges?.[0]?.results[0]?.output).toEqual({ data: "resultat-read_calendar_today" });
  });

  it("idempotency: samme kall i ny runde gjenbruker resultat uten ny utførelse (§19)", async () => {
    const { pool } = fakePool();
    let rounds = 0;
    const repeating = new ScriptedAdapter(
      () => "ferdig",
      () => {
        rounds += 1;
        return rounds <= 2 ? [call(`c${rounds}`, "read_calendar_today")] : [];
      }
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [repeating] });
    await gateway.completeWithTools({ tenant_id: "tenant-a", task_id: "t3", request: REQUEST }, { tools: TOOLS, executor });
    expect(executions.length).toBe(1); // runde 2 ba om identisk kall → cache, ikke re-utførelse
  });

  it("ugyldige argumenter: schema-feil, INGEN utførelse, normalisert feil tilbake (§25)", async () => {
    const { pool } = fakePool();
    let asked = false;
    const adapter = new ScriptedAdapter(
      () => "reparert svar",
      (req) => {
        if (req.tool_exchanges || asked) return [];
        asked = true;
        return [call("c1", "read_tasks", { bogus: 1 })]; // mangler required 'limit' + ukjent felt
      }
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const result = await gateway.completeWithTools({ tenant_id: "tenant-a", request: REQUEST }, { tools: TOOLS, executor });
    expect(executions.length).toBe(0);
    const exchange = adapter.calls.find((r) => r.tool_exchanges)?.tool_exchanges?.[0];
    expect(exchange?.results[0]?.success).toBe(false);
    expect(exchange?.results[0]?.error_category).toContain("INVALID_ARGUMENTS");
    // D-430: modellen svarte med tekst uten at noe kall lyktes («reparert svar» uten data) - teksten erstattes av en fast, ærlig melding.
    expect(result.text).not.toBe("reparert svar");
    expect(result.text).toContain("ugyldige eller manglende felt");
  });

  it("ukjent verktøy: TOOL_NOT_FOUND uten utførelse (§26)", async () => {
    const { pool } = fakePool();
    const adapter = new ScriptedAdapter(
      () => "ok",
      (req) => (req.tool_exchanges ? [] : [call("c1", "run_shell_command", { cmd: "rm -rf" })])
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.completeWithTools({ tenant_id: "tenant-a", request: REQUEST }, { tools: TOOLS, executor });
    expect(executions.length).toBe(0);
    const exchange = adapter.calls.find((r) => r.tool_exchanges)?.tool_exchanges?.[0];
    expect(exchange?.results[0]?.error_category).toBe("TOOL_NOT_FOUND");
  });

  it("flere verktøy i én runde: begge utføres, resultater assosieres per tool_call_id (§23)", async () => {
    const { pool } = fakePool();
    const adapter = new ScriptedAdapter(
      () => "syntese",
      (req) => (req.tool_exchanges ? [] : [call("c1", "read_calendar_today"), call("c2", "read_tasks", { limit: 5 })])
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.completeWithTools({ tenant_id: "tenant-a", request: REQUEST }, { tools: TOOLS, executor });
    expect(executions.map((e) => e.tool_name)).toEqual(["read_calendar_today", "read_tasks"]);
    const results = adapter.calls.find((r) => r.tool_exchanges)?.tool_exchanges?.[0]?.results;
    expect(results?.map((r) => r.tool_call_id)).toEqual(["c1", "c2"]);
  });

  it("critic får ALDRI tools (§30)", async () => {
    const { pool } = fakePool();
    const adapter = new ScriptedAdapter(() => "CONFIDENCE: 80 - ok", (req) => (req.tool_exchanges ? [] : []));
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.completeWithTools({ tenant_id: "tenant-a", critic: true, request: REQUEST }, { tools: TOOLS, executor: countingExecutor().executor });
    const criticReq = adapter.calls.find((r) => r.system?.startsWith("Du er en kritisk"));
    expect(criticReq).toBeDefined();
    expect(criticReq?.tools).toBeUndefined();
  });

  it("streaming + tools: execution først etter komplett, validert payload (§24)", async () => {
    const { pool } = fakePool();
    const adapter = new ScriptedAdapter(
      () => "streamet svar",
      (req) => (req.tool_exchanges ? [] : [call("c1", "read_calendar_today")])
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    const events: StreamEvent[] = [];
    const result = await gateway.completeWithTools(
      { tenant_id: "tenant-a", request: REQUEST },
      { tools: TOOLS, executor, onEvent: (e) => events.push(e) }
    );
    const deltaIdx = events.findIndex((e) => e.type === "tool_call_delta");
    const completeIdx = events.findIndex((e) => e.type === "tool_call_complete");
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(deltaIdx);
    expect(executions.length).toBe(1);
    expect(result.text).toBe("streamet svar");
  });
});

describe("P1A capability-routing + override (§36-§38)", () => {
  it("tool-request krever tool_calling-capability", () => {
    const router = new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
    const providers = new Map([
      ["openai", { configured: true, model: "gpt-5" }],
      ["ollama", { configured: true, model: "llama3.1" }]
    ]);
    const plan = router.plan({ required_capabilities: ["tool_calling"] }, providers);
    expect(plan.candidates.map((c) => c.provider)).not.toContain("ollama");
  });

  it("owner override som mangler påkrevd capability gir tydelig feil - aldri stille ignorering (§38)", () => {
    const router = new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
    const providers = new Map([["ollama", { configured: true, model: "llama3.1" }]]);
    expect(() => router.plan({ provider: "ollama", required_capabilities: ["tool_calling"] }, providers)).toThrow(
      NoEligibleProviderError
    );
  });

  it("validateToolArgs: required + additionalProperties håndheves deterministisk", () => {
    const schema = { type: "object", properties: { a: {} }, required: ["a"], additionalProperties: false };
    expect(validateToolArgs(schema, { a: 1 })).toBeNull();
    expect(validateToolArgs(schema, {})).toContain("missing_required");
    expect(validateToolArgs(schema, { a: 1, b: 2 })).toContain("unknown_field");
  });
});

describe("Del 3 (JARVIS-028): maxCallsPerRound begrenser verktøy-fan-out", () => {
  it("overskytende kall i en runde utføres ikke", async () => {
    const { pool } = fakePool();
    let asked = false;
    const adapter = new ScriptedAdapter(
      () => "ferdig",
      (req) => {
        if (req.tool_exchanges || asked) return [];
        asked = true;
        return [1, 2, 3, 4, 5].map((i) => call(`c${i}`, "read_tasks", { limit: i }));
      }
    );
    const { executor, executions } = countingExecutor();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.completeWithTools({ tenant_id: "tenant-a", request: REQUEST }, { tools: TOOLS, executor, maxCallsPerRound: 2 });
    expect(executions.map((e) => e.tool_call_id)).toEqual(["c1", "c2"]);
  });
});
