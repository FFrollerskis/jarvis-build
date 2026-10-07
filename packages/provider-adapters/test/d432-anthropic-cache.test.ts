import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter, anthropicUsage, type ModelRequest } from "../src/index.ts";

/**
 * D-432: prompt-caching hos Anthropic. Prefikset (verktøy → system → siste melding) får cache-punkter, og bruken normaliseres til «totalt inn»
 * + cache-treff + cache-skriving, så kostnadsregnskapet stemmer (Anthropic rapporterer `input_tokens` KUN for det etter siste cache-punkt).
 */
let captured: Record<string, unknown> | undefined;
function stub(usage: Record<string, number>): void {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const body = { content: [{ type: "text", text: "ok" }], usage, stop_reason: "end_turn" };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
  });
}
afterEach(() => vi.unstubAllGlobals());

const tool = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {}, additionalProperties: false } });
const base: ModelRequest = { system: "Du er Jarvis.", messages: [{ role: "user", content: "hei" }], tools: [tool("a"), tool("b")] };

describe("D-432: cache-punkter i forespørselen", () => {
  it("system som blokk, SISTE verktøy og siste melding får cache_control (3 av maks 4); øvrig innhold uendret", async () => {
    stub({ input_tokens: 10, output_tokens: 5 });
    await new AnthropicAdapter("k").complete(base);
    const body = captured as { system: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.system).toEqual([{ type: "text", text: "Du er Jarvis.", cache_control: { type: "ephemeral" } }]);
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1]).toMatchObject({ name: "b", cache_control: { type: "ephemeral" } });
    expect(body.messages[0]?.content).toEqual([{ type: "text", text: "hei", cache_control: { type: "ephemeral" } }]);
    const markers = JSON.stringify(captured).split("cache_control").length - 1;
    expect(markers).toBe(3);
  });

  it("uten system/verktøy: ingen tomme blokker; tom siste melding får ikke markør", async () => {
    stub({ input_tokens: 1, output_tokens: 1 });
    await new AnthropicAdapter("k").complete({ messages: [{ role: "user", content: "" }] });
    expect(captured).not.toHaveProperty("system");
    expect(captured).not.toHaveProperty("tools");
    expect(JSON.stringify(captured)).not.toContain("cache_control");
  });

  it("tool_result som siste blokk i en verktøyrunde får markøren (runde 2 leser prefikset fra cachen)", async () => {
    stub({ input_tokens: 1, output_tokens: 1 });
    const withExchange: ModelRequest = {
      ...base,
      tool_exchanges: [{
        calls: [{ tool_call_id: "c1", tool_name: "a", arguments: {}, provider: "anthropic", model: "m" }],
        results: [{ tool_call_id: "c1", tool_name: "a", execution_id: "e", success: true, output: { x: 1 }, at: "2026-10-07T00:00:00Z" }]
      }]
    };
    await new AnthropicAdapter("k").complete(withExchange);
    const body = captured as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    const last = body.messages[body.messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content[last.content.length - 1]).toMatchObject({ type: "tool_result", cache_control: { type: "ephemeral" } });
  });
});

describe("D-432: bruk normaliseres (totalt inn + treff + skriving)", () => {
  it("anthropicUsage legger cache-treff og -skriving til input_tokens og skiller dem ut", () => {
    expect(anthropicUsage({ input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }))
      .toEqual({ input_tokens: 1050, output_tokens: 7, cached_tokens: 900, cache_write_tokens: 100 });
    expect(anthropicUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(anthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 })).toEqual({ input_tokens: 10, output_tokens: 5, cached_tokens: 0 });
  });

  it("complete() returnerer normalisert bruk", async () => {
    stub({ input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 500, cache_creation_input_tokens: 80 });
    const r = await new AnthropicAdapter("k").complete(base);
    expect(r.usage).toEqual({ input_tokens: 600, output_tokens: 4, cached_tokens: 500, cache_write_tokens: 80 });
  });
});
