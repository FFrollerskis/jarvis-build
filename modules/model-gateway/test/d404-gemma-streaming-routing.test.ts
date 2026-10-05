import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult, StreamEvent, StreamHandler } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, NoEligibleProviderError } from "../src/index.ts";

/** D-404: gemma_local (med .stream()) er nå kvalifisert for streamet chat; avvisningen forklarer HVILKEN port som stoppet leverandøren. */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}
const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };
function streamingAdapter(name: string, calls: string[]): ModelProviderAdapter {
  return {
    name,
    available: () => true,
    async complete(): Promise<ModelResult> { calls.push(`${name}:complete`); return { text: "x", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 } as unknown as ModelResult; },
    async stream(_r: ModelRequest, onEvent: StreamHandler): Promise<ModelResult> {
      calls.push(`${name}:stream`);
      onEvent({ type: "text_delta", text: "lokalt" } as StreamEvent);
      return { text: "lokalt", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 } as unknown as ModelResult;
    }
  };
}

describe("D-404: streamet chat med «Gemma først»", () => {
  it("gemma_local velges for vanlig (ikke-hemmelig) streamet chat når den er konfigurert", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [streamingAdapter("gemma_local", calls), streamingAdapter("anthropic", calls)] });
    for (const sensitivity of ["PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE"] as const) {
      calls.length = 0;
      const r = await gateway.stream({ tenant_id: "t", purpose: "CHAT", sensitivity, providerPreference: ["gemma_local", "gemma_hosted"], request: REQUEST }, () => undefined);
      expect(r.provider).toBe("gemma_local");
      expect(calls).toEqual(["gemma_local:stream"]);
    }
  });

  it("avvisningen navngir porten per leverandør (ikke bare «ikke konfigurert/kvalifisert»)", async () => {
    const calls: string[] = [];
    // gemma_hosted er ikke konfigurert (ikke registrert), gemma_local er helt fraværende => not_configured for begge.
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [streamingAdapter("anthropic", calls)] });
    const err = await gateway
      .stream({ tenant_id: "t", purpose: "CHAT", providerPreference: ["gemma_local", "gemma_hosted"], request: REQUEST }, () => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoEligibleProviderError);
    const msg = (err as Error).message;
    expect(msg).toContain("provider_preference_exhausted");
    expect(msg).toContain("gemma_local:not_configured");
    expect(msg).toContain("gemma_hosted:not_configured");
    expect(calls).toEqual([]);
  });

  it("manglende evne, sensitivitet og paid_models_disabled får hver sin årsak", async () => {
    const calls: string[] = [];
    // kimi mangler `streaming` i registeret => missing_capabilities
    const gw1 = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [streamingAdapter("kimi", calls)] });
    const e1 = await gw1.stream({ tenant_id: "t", purpose: "CHAT", providerPreference: ["kimi"], request: REQUEST }, () => undefined).catch((e: unknown) => e);
    expect((e1 as Error).message).toContain("kimi:missing_capabilities=streaming");
    // betalt sky-leverandør med paid_models_allowed=false
    const gw2 = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [streamingAdapter("anthropic", calls)] });
    const e2 = await gw2.stream({ tenant_id: "t", purpose: "CHAT", paid_models_allowed: false, providerPreference: ["anthropic"], request: REQUEST }, () => undefined).catch((e: unknown) => e);
    expect((e2 as Error).message).toContain("anthropic:paid_models_disabled");
  });
});
