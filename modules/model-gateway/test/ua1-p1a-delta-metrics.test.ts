import { describe, expect, it } from "vitest";
import type pg from "pg";
import { ScriptedAdapter, type ToolCallRequest, type ToolResultMessage } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, type ToolExecutor } from "../src/index.ts";

/**
 * BO-11.1 §4: write-path for SQL-spørrbare streaming-/tool-metrics
 * (migrasjon 016: ttft_ms/stream/tool_calls i cost_events). Én kostrad per
 * modellkall som før - aldri dobbeltregistrering.
 * Kolonneposisjoner i INSERT: [14]=ttft_ms, [15]=stream, [16]=tool_calls.
 */

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

const REQUEST = { messages: [{ role: "user" as const, content: "test" }] };
const TOOLS = [
  {
    name: "read_calendar_today",
    description: "Les kalender",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
  }
];

const executor: ToolExecutor = {
  async execute(call: ToolCallRequest, ctx): Promise<ToolResultMessage> {
    return {
      tool_call_id: call.tool_call_id,
      tool_name: call.tool_name,
      execution_id: ctx.idempotency_key,
      success: true,
      output: { ok: true },
      at: new Date().toISOString()
    };
  }
};

describe("BO-11.1 §4: cost_events får ttft/stream/tool_calls", () => {
  it("streaming-kall: stream=true og ttft_ms satt; én kostrad", async () => {
    const { pool, costInserts } = fakePool();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "hei på deg")] });
    await gateway.stream({ tenant_id: "tenant-a", purpose: "CHAT", request: REQUEST }, () => undefined);
    const rows = costInserts.filter((p) => p[3] === "model:scripted");
    expect(rows).toHaveLength(1);
    const row = rows[0] as unknown[];
    expect(row[15]).toBe(true); // stream
    expect(row[14]).toBeGreaterThanOrEqual(0); // ttft_ms
    expect(row[16]).toBe(0); // tool_calls
  });

  it("non-streaming-kall: stream=false, ttft null - eksisterende semantikk uendret", async () => {
    const { pool, costInserts } = fakePool();
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter(() => "hei")] });
    await gateway.complete({ tenant_id: "tenant-a", purpose: "CHAT", request: REQUEST });
    const row = costInserts.find((p) => p[3] === "model:scripted") as unknown[];
    expect(row[15]).toBe(false);
    expect(row[14]).toBeNull();
    expect(row[16]).toBe(0);
  });

  it("tool-runde: kostraden for runden teller antall normaliserte tool-kall", async () => {
    const { pool, costInserts } = fakePool();
    const adapter = new ScriptedAdapter(
      () => "ferdig",
      (req) => (req.tool_exchanges ? [] : [
        { tool_call_id: "c1", tool_name: "read_calendar_today", arguments: {}, provider: "scripted", model: "scripted-1" }
      ])
    );
    const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers: [adapter] });
    await gateway.completeWithTools(
      { tenant_id: "tenant-a", task_id: "t-metrics", request: REQUEST },
      { tools: TOOLS, executor }
    );
    const rows = costInserts.filter((p) => p[3] === "model:scripted");
    expect(rows).toHaveLength(2); // runde 1 (tool-kall) + runde 2 (syntese) - én rad per modellkall
    expect((rows[0] as unknown[])[16]).toBe(1); // runden som ba om verktøy
    expect((rows[1] as unknown[])[16]).toBe(0); // syntese-runden
  });

  it("feilforsøk-rader beholder gammel kolonneliste (defaults dekker nye kolonner)", async () => {
    const { pool, costInserts } = fakePool();
    const failing = {
      name: "failing", model: "f-1", available: () => true,
      complete: async () => { throw new Error("provider_unavailable"); }
    };
    const gateway = new ModelGateway({
      pool, trace: new MemoryTraceSink(),
      providers: [failing as never, new ScriptedAdapter(() => "reserve")]
    });
    await gateway.complete({ tenant_id: "tenant-a", request: REQUEST });
    const failed = costInserts.find((p) => typeof p[3] === "string" && (p[3] as string).startsWith("model:failed"));
    expect(failed).toBeDefined();
    expect(failed).toHaveLength(8); // uendret feilforsøk-insert; DB-defaults fyller nye kolonner
  });
});
