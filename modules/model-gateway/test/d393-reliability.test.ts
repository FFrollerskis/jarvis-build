import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { AnthropicAdapter, GemmaHostedAdapter, OpenAiAdapter, type ModelProviderAdapter, type ModelResult } from "@jarvis/provider-adapters";
import { MemoryTraceSink, ModelGateway, ProviderHealthTracker, unavailableCooldownMs, DEFAULT_PROFILES } from "../src/index.ts";

/**
 * D-393 (JARVIS-033/034/036/038): leverandørhelse med gjenoppretting, bokføringsfeil ≠ leverandørfeil, ærlig registry og
 * strømmer som tar slutt uten avslutning er AVBRUTT (ikke «stop»).
 */
afterEach(() => vi.unstubAllGlobals());

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const sse = (frames: string[]): Response =>
  new Response(new Blob([frames.join("")]).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
const REQUEST = { messages: [{ role: "user" as const, content: "hei" }] };

describe("JARVIS-038: strøm uten avslutning er avbrutt", () => {
  it("OpenAI: strøm som slutter uten finish_reason og uten [DONE] gir stream_interrupted (ikke «stop»)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([data({ choices: [{ delta: { content: "Hei " } }] })])));
    await expect(new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined)).rejects.toMatchObject({ kind: "stream_interrupted" });
  });

  it("OpenAI: [DONE] uten eksplisitt finish_reason er en normal avslutning", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([data({ choices: [{ delta: { content: "Hei" } }] }), "data: [DONE]\n\n"])));
    const result = await new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined);
    expect(result.text).toBe("Hei");
  });

  it("Anthropic: strøm uten stop_reason gir stream_interrupted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      data({ type: "message_start", message: { usage: { input_tokens: 1 } } }),
      data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hei" } })
    ])));
    await expect(new AnthropicAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined)).rejects.toMatchObject({ kind: "stream_interrupted" });
  });

  it("Gemini/Gemma: en feil-chunk midt i strømmen klassifiseres som leverandørfeil (rate_limit for 429), ikke ignorert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      data({ candidates: [{ content: { parts: [{ text: "Hei " }] } }] }),
      data({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } })
    ])));
    await expect(new GemmaHostedAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined)).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("Gemini/Gemma: strøm uten finishReason er avbrutt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse([data({ candidates: [{ content: { parts: [{ text: "Hei" }] } }] })])));
    await expect(new GemmaHostedAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined)).rejects.toMatchObject({ kind: "stream_interrupted" });
  });
});

describe("JARVIS-033: UNAVAILABLE er en begrenset pause, ikke en dom til omstart", () => {
  it("etter 3 feil er leverandøren UNAVAILABLE, etter pausen slippes ETT prøvekall gjennom, og suksess nullstiller", () => {
    let now = 1_000_000;
    const health = new ProviderHealthTracker(() => now);
    for (let i = 0; i < 3; i += 1) health.recordFailure("gemma_hosted", "server", "boom");
    expect(health.state("gemma_hosted", true)).toBe("UNAVAILABLE");
    now += unavailableCooldownMs(3) - 1;
    expect(health.state("gemma_hosted", true)).toBe("UNAVAILABLE");
    now += 2;
    expect(health.state("gemma_hosted", true)).toBe("DEGRADED"); // prøvekall
    health.recordSuccess("gemma_hosted", 100);
    expect(health.state("gemma_hosted", true)).toBe("LIVE");
  });

  it("et mislykket prøvekall gir lengre pause (eksponentiell, maks 5 min)", () => {
    expect(unavailableCooldownMs(3)).toBe(30_000);
    expect(unavailableCooldownMs(4)).toBe(60_000);
    expect(unavailableCooldownMs(5)).toBe(120_000);
    expect(unavailableCooldownMs(40)).toBe(300_000);
  });
});

function okProvider(name: string): { adapter: ModelProviderAdapter; calls: () => number } {
  let calls = 0;
  const adapter: ModelProviderAdapter = {
    name, model: "m", available: () => true,
    complete: async () => { calls += 1; return { text: "svar", provider: name, model: "m", usage: { input_tokens: 5, output_tokens: 5 }, latency_ms: 1, finish_reason: "stop" } as unknown as ModelResult; }
  };
  return { adapter, calls: () => calls };
}

describe("JARVIS-034: bokføringsfeil etter et vellykket kall er ikke en leverandørfeil", () => {
  it("cost_events-INSERT som feiler gir fortsatt svaret, ÉN leverandørkall, ingen helse-straff og ingen fallback", async () => {
    const failingPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) throw new Error("db_down");
          return typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as pg.Pool;
    const a = okProvider("scripted");
    const gateway = new ModelGateway({ pool: failingPool, trace: new MemoryTraceSink(), providers: [a.adapter] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await gateway.complete({ tenant_id: "t", purpose: "CHAT", request: REQUEST });
    expect(result.text).toBe("svar");
    expect(a.calls()).toBe(1);
    expect(gateway.bookkeepingFailures).toBe(1);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("model_cost_bookkeeping_failed"))).toBe(true);
    spy.mockRestore();
  });

  it("trace-sink som kaster gir fortsatt svaret og ÉN leverandørkall", async () => {
    const pool = { connect: async () => ({ query: async (sql: string) => (typeof sql === "string" && sql.includes("FROM cost_events") ? { rows: [{ spent: 0 }] } : { rows: [] }), release: () => undefined }) } as unknown as pg.Pool;
    const a = okProvider("scripted");
    const gateway = new ModelGateway({ pool, trace: { record: async () => { throw new Error("disk_full"); } } as never, providers: [a.adapter] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await gateway.complete({ tenant_id: "t", purpose: "CHAT", request: REQUEST });
    expect(result.text).toBe("svar");
    expect(a.calls()).toBe(1);
    spy.mockRestore();
  });
});

describe("JARVIS-036: ærlig capability-registry", () => {
  it("kimi og hermes påstår ikke strukturert utdata som adapterne ikke støtter (verktøykall: se under og wpd4-kimi-hermes-tools.test.ts)", () => {
    const kimi = DEFAULT_PROFILES.find((p) => p.provider === "kimi")!;
    const hermes = DEFAULT_PROFILES.find((p) => p.provider === "hermes")!;
    expect(kimi.capabilities).not.toContain("structured_output");
    expect(hermes.capabilities).not.toContain("structured_output");
    expect(hermes.capabilities).not.toContain("streaming");
  });

  it("WP-D4: tool_calling for kimi/hermes er først påstått etter at adapterne beviselig støtter det - testene som beviser det må finnes", async () => {
    // Låser koblingen: påstanden i registeret og beviset (adaptertestene + gateway-løkken) hører sammen. Fjernes beviset, må påstanden fjernes med det.
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    for (const proof of ["packages/provider-adapters/test/kimi-tools.test.ts", "packages/provider-adapters/test/hermes-tools.test.ts", "modules/model-gateway/test/wpd4-kimi-hermes-tools.test.ts"]) {
      expect(existsSync(`${root}${proof}`), proof).toBe(true);
    }
    for (const provider of ["kimi", "hermes"]) {
      expect(DEFAULT_PROFILES.find((p) => p.provider === provider)!.capabilities).toContain("tool_calling");
    }
  });
});
