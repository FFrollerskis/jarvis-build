import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelResult, StreamEvent, ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, summarizeToolOutcomes, type ToolExecutor } from "../src/index.ts";

/**
 * D-430: ærlighet ved verktøyfeil. Når INGEN verktøykall i turen lyktes, erstattes modellens tekst av en fast melding (modellen ville
 * oppfunnet et svar - observert: «du har 123,45 kr» etter et avvist bankkall). Når noen lyktes og andre feilet, legges en fast merknad til.
 */
function fakePool(): pg.Pool {
  const client = { query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined };
  return { connect: async () => client } as unknown as pg.Pool;
}
const TOOL = { name: "finance_neonomics__list_balances", description: "x", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } };
const call = (id: string, name = TOOL.name, q = id): ToolCallRequest => ({ tool_call_id: id, tool_name: name, arguments: { q }, provider: "scripted", model: "m" });
const usage = { input_tokens: 1, output_tokens: 1 };

/** Runde 1: ber om gitte kall. Runde 2+: svarer med `finalText` (modellens eget, potensielt oppdiktede svar). */
function provider(calls: ToolCallRequest[], finalText: string): ModelProviderAdapter & { streamed: number } {
  let round = 0;
  const next = (): ModelResult => {
    round += 1;
    return round === 1
      ? ({ text: "", provider: "scripted", model: "m", tool_calls: calls, usage, latency_ms: 1 } as unknown as ModelResult)
      : ({ text: finalText, provider: "scripted", model: "m", usage, latency_ms: 1 } as unknown as ModelResult);
  };
  const p = {
    name: "scripted", model: "m", available: () => true, streamed: 0,
    complete: async () => next(),
    stream: async (_req: unknown, onEvent: (e: StreamEvent) => void) => { p.streamed += 1; const r = next(); if (r.text) onEvent({ type: "text_delta", text: r.text }); return r; }
  };
  return p as unknown as ModelProviderAdapter & { streamed: number };
}
const executorWith = (fn: (c: ToolCallRequest) => Partial<ToolResultMessage>): ToolExecutor => ({
  async execute(c): Promise<ToolResultMessage> {
    return { tool_call_id: c.tool_call_id, tool_name: c.tool_name, execution_id: "e", success: true, output: { ok: true }, at: new Date().toISOString(), ...fn(c) } as ToolResultMessage;
  }
});
const input = { tenant_id: "t", purpose: "CHAT" as const, request: { messages: [{ role: "user" as const, content: "hvor mye har jeg på kontoen" }] } };

describe("D-430: verktøyfeil gir aldri oppdiktet svar", () => {
  it("alle kall feilet → modellens tekst («123,45 kr») erstattes av fast melding, også i strømmen", async () => {
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [provider([call("c1")], "Du har bare 123,45 kr på kontoen.")] });
    const events: string[] = [];
    const result = await gw.completeWithTools(input, {
      tools: [TOOL], maxRounds: 4,
      executor: executorWith(() => ({ success: false, output: { message: "til modellen" }, error_category: "tool_failed:neonomics_http_401", source: "finance_neonomics.list_balances" })),
      onEvent: (e) => { if (e.type === "text_delta") events.push(e.text); }
    });
    expect(result.text).not.toContain("123,45");
    expect(result.text).toContain("jeg gjetter ikke");
    expect(result.text).toContain("finance_neonomics.list_balances: tjenesten svarte med feil (kode 401)");
    expect(events.join("")).toBe(result.text);
    expect(result.metadata).toMatchObject({ tool_honesty: "all_failed" });
  });

  it("ugyldige argumenter (avvist før utførelse) gir også fast melding", async () => {
    const bad: ToolCallRequest = { tool_call_id: "c1", tool_name: TOOL.name, arguments: {}, provider: "scripted", model: "m" };
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [provider([bad], "Ingen åpne pull requests.")] });
    const result = await gw.completeWithTools(input, { tools: [TOOL], executor: executorWith(() => ({})), maxRounds: 4 });
    expect(result.text).not.toContain("Ingen åpne");
    expect(result.text).toContain("ugyldige eller manglende felt");
  });

  it("noen lyktes og andre feilet → modellens svar beholdes, fast merknad legges til", async () => {
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [provider([call("c1"), call("c2")], "Du har 3 møter i dag.")] });
    const result = await gw.completeWithTools(input, {
      tools: [TOOL], maxRounds: 4,
      executor: executorWith((c) => (c.tool_call_id === "c2" ? { success: false, output: null, error_category: "timeout", source: "calendar.read_events" } : {}))
    });
    expect(result.text.startsWith("Du har 3 møter i dag.")).toBe(true);
    expect(result.text).toContain("Merk: dette feilet og er ikke med i svaret:");
    expect(result.text).toContain("calendar.read_events: tjenesten svarte ikke");
  });

  it("alt lyktes → uendret tekst, ingen merknad", async () => {
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [provider([call("c1")], "ferdig")] });
    const result = await gw.completeWithTools(input, { tools: [TOOL], executor: executorWith(() => ({})), maxRounds: 4 });
    expect(result.text).toBe("ferdig");
    expect(result.metadata).not.toHaveProperty("tool_honesty");
  });

  it("ventende bekreftelse regnes ikke som feil (modellens forklaring beholdes)", async () => {
    const gw = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [provider([call("c1")], "Godkjenn i chatten.")] });
    const result = await gw.completeWithTools(input, {
      tools: [TOOL],
      executor: executorWith(() => ({ success: false, output: { confirmation_required: true, confirmation_id: "x" }, error_category: "CONFIRMATION_REQUIRED" })),
      maxRounds: 4
    });
    expect(result.text).toBe("Godkjenn i chatten.");
  });

  it("summarizeToolOutcomes dedupliserer like feil og skiller bekreftelse fra feil", () => {
    const r = (id: string, extra: Partial<ToolResultMessage>): ToolResultMessage => ({ tool_call_id: id, tool_name: "a__b", execution_id: "e", success: false, output: null, at: "", ...extra }) as ToolResultMessage;
    const s = summarizeToolOutcomes([{ calls: [], results: [r("1", { error_category: "credential_unavailable" }), r("2", { error_category: "credential_unavailable" }), r("3", { output: { confirmation_required: true } })] }]);
    expect(s.failures).toEqual([{ label: "a.b", reason: "tjenesten er ikke koblet til (nøkkel mangler eller er tilbakekalt)" }]);
    expect(s.confirmationPending).toBe(true);
    expect(s.successes).toBe(0);
  });
});
