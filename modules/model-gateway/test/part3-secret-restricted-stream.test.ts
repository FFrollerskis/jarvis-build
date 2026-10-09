import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult, StreamEvent } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, NoEligibleProviderError } from "../src/index.ts";

/**
 * D-379 (funnet i drift på NAS 2026-10-03): selv «hei» feilet med `no_eligible_provider ... [tool_calling,streaming]
 * (sensitivity=SECRET_RESTRICTED)` fordi `stream()` krever native `streaming`, og den lokale OpenAI-kompatible Gemma-en
 * (`gemma_local`) ikke har det (ærlig registry, D-80). For SECRET_RESTRICTED skal streaming-banen i stedet normalisere til én
 * text_delta - aldri feile lukket når en lokal provider finnes, og aldri gå til sky når den ikke finnes.
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }),
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

function adapter(name: string, calls: string[]): ModelProviderAdapter {
  return {
    name,
    available: () => true,
    async complete(_request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
      calls.push(name);
      onToken?.("lokalt svar");
      return { text: "lokalt svar", usage: { input_tokens: 1, output_tokens: 1 }, provider: name, model: "m", latency_ms: 1 } as unknown as ModelResult;
    }
  };
}

const REQUEST: ModelRequest = { messages: [{ role: "user", content: "hei" }] };

describe("stream(): SECRET_RESTRICTED uten native streaming (D-379)", () => {
  it("lokal gemma_local uten .stream() svarer som én text_delta", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_local", calls)] });
    const events: StreamEvent[] = [];
    const result = await gateway.stream(
      { tenant_id: "t", purpose: "CHAT", sensitivity: "SECRET_RESTRICTED", providerPreference: ["gemma_local", "gemma_hosted"], request: REQUEST },
      (e) => events.push(e)
    );
    expect(result.text).toBe("lokalt svar");
    expect(calls).toEqual(["gemma_local"]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("lokalt svar");
  });

  it("uten lokal provider feiler SECRET_RESTRICTED fortsatt lukket - en skyprovider får ALDRI svare", async () => {
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("gemma_hosted", calls), adapter("openai", calls)] });
    await expect(
      gateway.stream({ tenant_id: "t", purpose: "CHAT", sensitivity: "SECRET_RESTRICTED", request: REQUEST }, () => undefined)
    ).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect(calls).toEqual([]);
  });

  it("andre sensitiviteter krever fortsatt native streaming (uendret): en provider uten streaming i registeret (hermes) er ikke kvalifisert", async () => {
    // D-404: gemma_local har nå ekte .stream() og `streaming` i registeret; WP-D4: det har kimi også (ekte SSE) - hermes er en provider som fortsatt mangler det.
    const calls: string[] = [];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [adapter("hermes", calls)] });
    await expect(
      gateway.stream({ tenant_id: "t", purpose: "CHAT", sensitivity: "PRIVATE", request: REQUEST }, () => undefined)
    ).rejects.toBeInstanceOf(NoEligibleProviderError);
    expect(calls).toEqual([]);
  });
});
