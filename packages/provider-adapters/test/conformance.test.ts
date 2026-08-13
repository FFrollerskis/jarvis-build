import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiAdapter,
  OllamaAdapter,
  OpenAiAdapter,
  ProviderError,
  type ModelProviderAdapter
} from "../src/index.ts";

/**
 * UA-1 §28: alle adaptere testes mot SAMME interface med samme feilmatrise.
 * fetch mockes - ingen nettverk, ingen ekte nøkler.
 */

interface Case {
  name: string;
  make: () => ModelProviderAdapter;
  successBody: unknown;
  successHeaders?: Record<string, string>;
  expectRequestId?: boolean;
}

const CASES: Case[] = [
  {
    name: "openai",
    make: () => new OpenAiAdapter("test-key", "test-model", "http://mock"),
    successBody: {
      choices: [{ message: { content: "hei" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } }
    },
    successHeaders: { "x-request-id": "req-1" },
    expectRequestId: true
  },
  {
    name: "anthropic",
    make: () => new AnthropicAdapter("test-key", "test-model", "http://mock"),
    successBody: {
      content: [{ type: "text", text: "hei" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
      stop_reason: "end_turn"
    },
    successHeaders: { "request-id": "req-2" },
    expectRequestId: true
  },
  {
    name: "gemini",
    make: () => new GeminiAdapter("test-key", "test-model", "http://mock"),
    successBody: {
      candidates: [{ content: { parts: [{ text: "hei" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    }
  },
  {
    name: "kimi",
    make: () => new KimiAdapter("test-key", "test-model", "http://mock"),
    successBody: {
      choices: [{ message: { content: "hei" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }
  },
  {
    name: "ollama",
    make: () => new OllamaAdapter("http://mock", "test-model"),
    successBody: { message: { content: "hei" }, prompt_eval_count: 10, eval_count: 5, done_reason: "stop" }
  }
];

const REQUEST = { messages: [{ role: "user" as const, content: "test" }] };

function mockFetch(response: () => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider-adapter conformance (UA-1 §28)", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("normaliserer suksessrespons (text/usage/latency/finish_reason)", async () => {
        mockFetch(
          () =>
            new Response(JSON.stringify(c.successBody), {
              status: 200,
              headers: { "content-type": "application/json", ...(c.successHeaders ?? {}) }
            })
        );
        const result = await c.make().complete(REQUEST);
        expect(result.text).toBe("hei");
        expect(result.usage.input_tokens).toBe(10);
        expect(result.usage.output_tokens).toBe(5);
        expect(result.provider).toBe(c.name);
        expect(result.model).toBe("test-model");
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
        expect(result.finish_reason).toBeTruthy();
        if (c.expectRequestId) {
          expect(result.provider_request_id).toBeTruthy();
        }
      });

      for (const [status, kind] of [
        [401, "auth"],
        [429, "rate_limit"],
        [500, "server"],
        [400, "bad_request"]
      ] as const) {
        it(`normaliserer HTTP ${status} til ProviderError(${kind})`, async () => {
          mockFetch(() => new Response("{}", { status }));
          const err = await c
            .make()
            .complete(REQUEST)
            .then(() => null)
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(ProviderError);
          expect((err as ProviderError).kind).toBe(kind);
          expect((err as ProviderError).provider).toBe(c.name);
        });
      }

      it("normaliserer ugyldig JSON til invalid_response", async () => {
        mockFetch(() => new Response("ikke-json", { status: 200 }));
        const err = await c.make().complete(REQUEST).then(() => null).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).kind).toBe("invalid_response");
      });

      it("normaliserer timeout til ProviderError(timeout)", async () => {
        mockFetch(() => {
          const e = new Error("timeout");
          e.name = "TimeoutError";
          throw e;
        });
        const err = await c.make().complete(REQUEST).then(() => null).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).kind).toBe("timeout");
      });

      it("kaster not_configured uten nøkkel/endepunkt (aldri nettverkskall)", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        // Tom streng (ikke undefined): default-parametre skal ikke hente host-env i test.
        const adapter =
          c.name === "ollama"
            ? new OllamaAdapter("", "m")
            : c.name === "openai"
              ? new OpenAiAdapter("", "m", "http://mock")
              : c.name === "anthropic"
                ? new AnthropicAdapter("", "m", "http://mock")
                : c.name === "gemini"
                  ? new GeminiAdapter("", "m", "http://mock")
                  : new KimiAdapter("", "m", "http://mock");
        expect(adapter.available()).toBe(false);
        const err = await adapter.complete(REQUEST).then(() => null).catch((e: unknown) => e);
        expect((err as ProviderError).kind).toBe("not_configured");
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });
  }

  it("openai: structured_schema gir parset structured_output", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 }
          }),
          { status: 200 }
        )
    );
    const result = await new OpenAiAdapter("k", "m", "http://mock").complete({
      ...REQUEST,
      structured_schema: { type: "object", properties: { a: { type: "number" } } }
    });
    expect(result.structured_output).toEqual({ a: 1 });
  });

  it("openai: ugyldig structured output gir invalid_response (repair-policy hos gateway)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ikke json" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 }
          }),
          { status: 200 }
        )
    );
    const err = await new OpenAiAdapter("k", "m", "http://mock")
      .complete({ ...REQUEST, structured_schema: { type: "object" } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe("invalid_response");
  });

  it("gemini: nøkkel sendes i header, aldri i URL", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: {} }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchSpy);
    await new GeminiAdapter("hemmelig-key", "m", "http://mock").complete(REQUEST);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("hemmelig-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("hemmelig-key");
  });
});
