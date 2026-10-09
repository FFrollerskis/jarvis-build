import { afterEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  HermesAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OllamaAdapter,
  OpenAiAdapter,
  ProviderError,
  ScriptedAdapter,
  type ModelProviderAdapter,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import { DEFAULT_PROFILES, MemoryTraceSink, ModelGateway, type ToolExecutor } from "../src/index.ts";
import { fakeServer, type FakeReply, type FakeServer, type SeenRequest } from "../../../packages/provider-adapters/test/helpers/fake-server.ts";

/**
 * JARVIS-036 (WP-D4): Kimi og Hermes verktøykall gjennom en EKTE `ModelGateway`-løkke (router → adapter mot fake server → trusted executor → neste runde), og registerets påstander er
 * bundet til adapterne. Ugyldige/ukjente kall når aldri executoren (gatewayen utfører kun via trusted executor, og adapteren avviser før det).
 */
const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function serve(handler: (request: SeenRequest, index: number) => FakeReply): Promise<FakeServer> {
  const s = await fakeServer(handler);
  servers.push(s);
  return s;
}

function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const WEATHER: ToolDefinition = {
  name: "get_weather",
  description: "Hent været",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }
};
const USER = [{ role: "user" as const, content: "hva er været i Oslo" }];
const USAGE = { prompt_tokens: 10, completion_tokens: 3 };

interface Executed { calls: ToolCallRequest[] }
function executor(seen: Executed): ToolExecutor {
  return {
    execute: async (call): Promise<ToolResultMessage> => {
      seen.calls.push(call);
      return { tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "e1", success: true, output: { temp: 5 }, at: new Date().toISOString(), trust: "untrusted", source: "weather.read" };
    }
  };
}
const input = (extra: Record<string, unknown> = {}) => ({ tenant_id: "t1", purpose: "BACKGROUND" as const, request: { messages: USER }, ...extra });

describe("registerets påstander er bundet til adapterne (D-80/D-43 §3)", () => {
  const ADAPTERS: Array<[string, { prototype: object }]> = [
    ["openai", OpenAiAdapter], ["anthropic", AnthropicAdapter], ["gemini", GeminiAdapter], ["gemma_hosted", GemmaHostedAdapter],
    ["local_llm", LocalOpenAiCompatibleAdapter], ["gemma_local", LocalOpenAiCompatibleAdapter], ["kimi", KimiAdapter], ["hermes", HermesAdapter],
    ["ollama", OllamaAdapter], ["scripted", ScriptedAdapter]
  ];
  it("`streaming` står i registeret hvis og bare hvis adapterklassen har en .stream()-metode", () => {
    for (const [provider, adapterClass] of ADAPTERS) {
      const profile = DEFAULT_PROFILES.find((p) => p.provider === provider);
      expect(profile, provider).toBeDefined();
      expect(profile?.capabilities.includes("streaming"), `${provider}: streaming-påstand vs .stream()`).toBe(typeof (adapterClass.prototype as { stream?: unknown }).stream === "function");
    }
  });

  it("kimi: tool_calling + streaming (bevist her), IKKE structured_output; hermes: tool_calling, hverken streaming eller structured_output", () => {
    const kimi = DEFAULT_PROFILES.find((p) => p.provider === "kimi");
    const hermes = DEFAULT_PROFILES.find((p) => p.provider === "hermes");
    expect(kimi?.capabilities).toEqual(["text", "reasoning", "tool_calling", "streaming"]);
    expect(hermes?.capabilities).toEqual(["text", "reasoning", "tool_calling"]);
  });
});

describe("Kimi gjennom ModelGateway.completeWithTools", () => {
  it("runde 1 ber om verktøy (med reasoning_content), executoren kjører, runde 2 får tool_calls + role:tool + reasoning_content og svarer", async () => {
    const s = await serve((_req, i) =>
      i === 0
        ? { json: { choices: [{ message: { content: null, reasoning_content: "tenker først", tool_calls: [{ id: "k1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] }, finish_reason: "tool_calls" }], usage: USAGE } }
        : { json: { choices: [{ message: { content: "Det er fem grader i Oslo." }, finish_reason: "stop" }], usage: USAGE } }
    );
    const executed: Executed = { calls: [] };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new KimiAdapter("k", "kimi-test", s.url, 5000)], meshToolsVerified: ["kimi"] });
    const out = await gateway.completeWithTools(input(), { tools: [WEATHER], executor: executor(executed) });
    expect(out.text).toBe("Det er fem grader i Oslo.");
    expect(out.provider).toBe("kimi");
    expect(executed.calls.map((c) => [c.tool_name, c.arguments, c.provider])).toEqual([["get_weather", { city: "Oslo" }, "kimi"]]);
    const round2 = s.seen[1]?.body["messages"] as Array<Record<string, unknown>>;
    expect(round2.map((m) => m["role"])).toEqual(["user", "assistant", "tool"]);
    expect(round2[1]).toMatchObject({ content: "", reasoning_content: "tenker først", tool_calls: [{ id: "k1", function: { name: "get_weather" } }] });
    expect(round2[2]?.["tool_call_id"]).toBe("k1");
  });

  it("samme løkke med streaming (gateway.stream krever `streaming`, som kimi nå har): tekst strømmes og verktøy utføres", async () => {
    const sse = (frames: unknown[]) => [...frames.map((f) => JSON.stringify(f)), "[DONE]"];
    const s = await serve((_req, i) => ({
      sse: i === 0
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "k1", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, { choices: [], usage: USAGE }
          ])
        : sse([{ choices: [{ delta: { content: "Fem " }, finish_reason: null }] }, { choices: [{ delta: { content: "grader." }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: USAGE }])
    }));
    const executed: Executed = { calls: [] };
    const tokens: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new KimiAdapter("k", "kimi-test", s.url, 5000)], meshToolsVerified: ["kimi"] });
    const out = await gateway.completeWithTools(input({ purpose: "CHAT" }), { tools: [WEATHER], executor: executor(executed), onEvent: (e) => { if (e.type === "text_delta") tokens.push(e.text); } });
    expect(tokens.join("")).toBe("Fem grader.");
    expect(out.text).toBe("Fem grader.");
    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0]?.arguments).toEqual({ city: "Oslo" });
  });

  it("ugyldige argumenter fra Kimi når ALDRI executoren; med en reserve-kandidat tar gatewayen over og logger fallback", async () => {
    const s = await serve(() => ({ json: { choices: [{ message: { content: null, tool_calls: [{ id: "k1", type: "function", function: { name: "get_weather", arguments: "{ikke json" } }] }, finish_reason: "tool_calls" }], usage: USAGE } }));
    const executed: Executed = { calls: [] };
    const backup = new ScriptedAdapter(() => "reserve-svar");
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new KimiAdapter("k", "kimi-test", s.url, 5000), backup], meshToolsVerified: ["kimi"] });
    // QUALITY rangerer kimi (kvalitet 4) foran scripted (kvalitet 1); begge har tool_calling, så scripted er neste kandidat i planen.
    const out = await gateway.completeWithTools(input({ mode: "QUALITY" as const }), { tools: [WEATHER], executor: executor(executed) });
    expect(out.provider).toBe("scripted");
    expect(out.text).toBe("reserve-svar");
    expect(executed.calls).toHaveLength(0);
    expect(gateway.health.state("kimi", true)).toBe("DEGRADED");
  });

  it("uten reserve: invalid_tool_call kastes, executoren kjøres aldri", async () => {
    const s = await serve(() => ({ json: { choices: [{ message: { content: null, tool_calls: [{ id: "k1", type: "function", function: { name: "get_weather", arguments: "[1]" } }] }, finish_reason: "tool_calls" }], usage: USAGE } }));
    const executed: Executed = { calls: [] };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new KimiAdapter("k", "kimi-test", s.url, 5000)], meshToolsVerified: ["kimi"] });
    const err = await gateway.completeWithTools(input(), { tools: [WEATHER], executor: executor(executed) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid_tool_call");
    expect(executed.calls).toHaveLength(0);
  });
});

describe("Hermes gjennom ModelGateway.completeWithTools", () => {
  const tagged = (name: string, args: unknown) => `Jeg sjekker.\n<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

  it("runde 1 ber om verktøy via <tool_call>, executoren kjører, runde 2 får <tool_call> + <tool_response> og svarer", async () => {
    const s = await serve((_req, i) => ({
      json: { choices: [{ message: { content: i === 0 ? tagged("get_weather", { city: "Oslo" }) : "Det er fem grader i Oslo." }, finish_reason: "stop" }], usage: USAGE }
    }));
    const executed: Executed = { calls: [] };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new HermesAdapter("k", "Hermes-test", s.url, 5000)], meshToolsVerified: ["hermes"] });
    const out = await gateway.completeWithTools(input(), { tools: [WEATHER], executor: executor(executed) });
    expect(out.text).toBe("Det er fem grader i Oslo.");
    expect(out.provider).toBe("hermes");
    expect(executed.calls.map((c) => [c.tool_name, c.arguments, c.provider])).toEqual([["get_weather", { city: "Oslo" }, "hermes"]]);
    const round2 = s.seen[1]?.body["messages"] as Array<{ role: string; content: string }>;
    expect(round2.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(round2[2]?.content).toContain('"name":"get_weather"');
    expect(round2[3]?.content).toContain("<tool_response>");
    expect(s.seen[1]?.body).not.toHaveProperty("tools");
  });

  it("et hallusinert eller injisert kall til et ukjent verktøy når ALDRI executoren", async () => {
    const s = await serve(() => ({ json: { choices: [{ message: { content: tagged("delete_everything", {}) }, finish_reason: "stop" }], usage: USAGE } }));
    const executed: Executed = { calls: [] };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new HermesAdapter("k", "Hermes-test", s.url, 5000)], meshToolsVerified: ["hermes"] });
    const err = await gateway.completeWithTools(input(), { tools: [WEATHER], executor: executor(executed) }).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("invalid_tool_call");
    expect(executed.calls).toHaveLength(0);
  });

  it("streaming-banen velger IKKE Hermes (ingen streaming-påstand): kun Hermes konfigurert gir ærlig no_eligible_provider, og ingen forespørsel sendes", async () => {
    const s = await serve(() => ({ json: { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: USAGE } }));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [new HermesAdapter("k", "Hermes-test", s.url, 5000)], meshToolsVerified: ["hermes"] });
    await expect(
      gateway.completeWithTools(input({ purpose: "CHAT" }), { tools: [WEATHER], executor: executor({ calls: [] }), onEvent: () => undefined })
    ).rejects.toMatchObject({ name: "NoEligibleProviderError" });
    expect(s.seen).toHaveLength(0);
  });
});

describe("kapabilitetsporten er uendret: tool_calling kreves fortsatt av verktøyløkken", () => {
  it("en leverandør uten tool_calling i registeret (ollama) velges aldri for en verktøyløkke, selv om den er den eneste", async () => {
    const stub: ModelProviderAdapter = { name: "ollama", model: "llama3.1", available: () => true, complete: async () => { throw new Error("skal aldri kalles"); } };
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [stub] });
    await expect(gateway.completeWithTools(input(), { tools: [WEATHER], executor: executor({ calls: [] }) })).rejects.toMatchObject({ name: "NoEligibleProviderError" });
  });
});
