import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelResult } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, L10): adapteren nuller ugyldige tokentall og merker svaret (`usage_problems`); gatewayen logger KATEGORIENE (aldri verdiene) og kostberegningen får bare gyldige tall.
 */
function fakePool(inserted: unknown[][]): pg.Pool {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events") && params) inserted.push(params);
      return { rows: [] };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const adapter = (metadata?: Record<string, unknown>): ModelProviderAdapter => ({
  name: "kimi", model: "kimi-k3", available: () => true,
  complete: async (): Promise<ModelResult> => ({ text: "hei", usage: { input_tokens: 0, output_tokens: 0 }, provider: "kimi", model: "kimi-k3", finish_reason: "stop", ...(metadata ? { metadata } : {}) })
});
afterEach(() => { vi.restoreAllMocks(); });

describe("L10: gatewayen logger ugyldig usage uten å lekke verdier", () => {
  it("usage_problems i metadata gir én logglinje med kategorier; svaret leveres uendret", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const gateway = new ModelGateway({ pool: fakePool([]), trace: new MemoryTraceSink(), providers: [adapter({ usage_missing: true, usage_invalid: true, usage_problems: ["prompt_tokens:string", "completion_tokens:negative"] })] });
    const out = await gateway.complete({ tenant_id: "t1", purpose: "CHAT", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", provider: "kimi", request: { messages: [{ role: "user", content: "hei" }] } });
    expect(out.text).toBe("hei");
    const logged = errors.map((e) => { try { return JSON.parse(e) as Record<string, unknown>; } catch { return {}; } }).filter((l) => l["msg"] === "provider_usage_invalid");
    expect(logged).toEqual([{ msg: "provider_usage_invalid", provider: "kimi", problems: ["prompt_tokens:string", "completion_tokens:negative"] }]);
  });

  it("uten usage_problems logges ingenting (ingen falske alarmer)", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const gateway = new ModelGateway({ pool: fakePool([]), trace: new MemoryTraceSink(), providers: [adapter()] });
    await gateway.complete({ tenant_id: "t1", purpose: "CHAT", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", provider: "kimi", request: { messages: [{ role: "user", content: "hei" }] } });
    expect(errors.filter((e) => e.includes("provider_usage_invalid"))).toEqual([]);
  });
});
