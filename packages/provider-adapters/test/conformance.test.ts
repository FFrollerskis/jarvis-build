import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  normalizeLocalLlmBaseUrl,
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
  },
  {
    // D-79 (AI Mesh Gemma-first): samme generateContent-responsformat som gemini,
    // egen provider-identitet ("gemma_hosted").
    name: "gemma_hosted",
    make: () => new GemmaHostedAdapter("test-key", "test-model", "http://mock"),
    successBody: {
      candidates: [{ content: { parts: [{ text: "hei" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
    }
  },
  {
    // D-79 §6: OpenAI-kompatibelt lokalt endepunkt.
    name: "local_llm",
    make: () => new LocalOpenAiCompatibleAdapter("http://mock", "test-model"),
    successBody: {
      choices: [{ message: { content: "hei" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }
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
            : c.name === "local_llm"
              ? new LocalOpenAiCompatibleAdapter("", "m")
              : c.name === "openai"
                ? new OpenAiAdapter("", "m", "http://mock")
                : c.name === "anthropic"
                  ? new AnthropicAdapter("", "m", "http://mock")
                  : c.name === "gemini"
                    ? new GeminiAdapter("", "m", "http://mock")
                    : c.name === "gemma_hosted"
                      ? new GemmaHostedAdapter("", "m", "http://mock")
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

  it("gemma_hosted: nøkkel sendes i header, aldri i URL (samme sikkerhetsinvariant som gemini)", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }], usageMetadata: {} }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchSpy);
    await new GemmaHostedAdapter("hemmelig-key", "m", "http://mock").complete(REQUEST);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("hemmelig-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("hemmelig-key");
  });

  it("gemma_hosted: GEMMA_API_KEY faller tilbake til GEMINI_API_KEY når GEMMA_API_KEY ikke er satt (samme Google-konto/API)", () => {
    const prevGemma = process.env["GEMMA_API_KEY"];
    const prevGemini = process.env["GEMINI_API_KEY"];
    delete process.env["GEMMA_API_KEY"];
    process.env["GEMINI_API_KEY"] = "delt-nokkel";
    try {
      expect(new GemmaHostedAdapter().available()).toBe(true);
    } finally {
      if (prevGemma === undefined) delete process.env["GEMMA_API_KEY"];
      else process.env["GEMMA_API_KEY"] = prevGemma;
      if (prevGemini === undefined) delete process.env["GEMINI_API_KEY"];
      else process.env["GEMINI_API_KEY"] = prevGemini;
    }
  });

  it("gemma_hosted: normaliserer et functionCall-svar til en ToolCallRequest (§12: modellen utfører ALDRI selv)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ functionCall: { name: "read_x", args: { a: 1 } } }] }, finishReason: "STOP" }
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }
          }),
          { status: 200 }
        )
    );
    const result = await new GemmaHostedAdapter("k", "m", "http://mock").complete({
      ...REQUEST,
      tools: [{ name: "read_x", description: "les x", input_schema: { type: "object" } }]
    });
    expect(result.tool_calls?.[0]).toMatchObject({ tool_name: "read_x", arguments: { a: 1 }, provider: "gemma_hosted" });
  });

  it("gemma_hosted: tool-exchange oversettes til functionCall/functionResponse-turer", async () => {
    let capturedBody: Record<string, unknown> = {};
    const capture = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", capture);
    await new GemmaHostedAdapter("k", "m", "http://mock").complete({
      ...REQUEST,
      tool_exchanges: [
        {
          calls: [{ tool_call_id: "c1", tool_name: "read_x", arguments: { a: 1 }, provider: "gemma_hosted", model: "m" }],
          results: [{ tool_call_id: "c1", tool_name: "read_x", execution_id: "e1", success: true, output: { ok: 1 }, at: "2026-08-19T00:00:00Z" }]
        }
      ]
    });
    const contents = capturedBody["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents.some((c) => c.role === "model" && c.parts[0]?.["functionCall"])).toBe(true);
    expect(contents.some((c) => c.role === "function" && c.parts[0]?.["functionResponse"])).toBe(true);
  });

  it("local_llm: tool_calls fra et OpenAI-kompatibelt svar normaliseres til ToolCallRequest", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "call_1", function: { name: "read_x", arguments: '{"a":1}' } }]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 }
          }),
          { status: 200 }
        )
    );
    const result = await new LocalOpenAiCompatibleAdapter("http://mock", "m").complete({
      ...REQUEST,
      tools: [{ name: "read_x", description: "les x", input_schema: { type: "object" } }]
    });
    expect(result.tool_calls?.[0]).toMatchObject({ tool_call_id: "call_1", tool_name: "read_x", arguments: { a: 1 }, provider: "local_llm" });
  });

  it("local_llm: sender ALDRI en Authorization-header (rent lokalt endepunkt, ingen credential å lekke)", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    await new LocalOpenAiCompatibleAdapter("http://mock", "m").complete(REQUEST);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  // D-106 HOST-FIX (Defekt A): baseUrl-konvensjonen er tvetydig i praksis
  // (operatør-konfig kan komme inn med/uten `/v1`) - adapteren MÅ konstruere
  // `/v1/chat/completions` nøyaktig én gang uansett hvilken av de 4 formene
  // som er satt, og ALDRI produsere `/v1/v1`.
  describe("local_llm: normalizeLocalLlmBaseUrl (D-106 HOST-FIX Defekt A)", () => {
    it.each([
      ["http://127.0.0.1:11434", "http://127.0.0.1:11434"],
      ["http://127.0.0.1:11434/", "http://127.0.0.1:11434"],
      ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434"],
      ["http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434"]
    ])("normaliserer %s til root-URL %s", (input, expected) => {
      expect(normalizeLocalLlmBaseUrl(input)).toBe(expected);
    });

    it("stripper ALDRI en delvis/urelatert sti som bare ligner /v1 (ingen stille mangling)", () => {
      // "/v1beta" er IKKE "/v1" - skal bevares uendret, ikke stille kuttes.
      expect(normalizeLocalLlmBaseUrl("http://host/v1beta")).toBe("http://host/v1beta");
    });

    for (const [label, envUrl] of [
      ["root, uten /v1", "http://127.0.0.1:11434"],
      ["root med avsluttende /", "http://127.0.0.1:11434/"],
      ["root + /v1 (D-106 runbook sin tidligere anbefalte form)", "http://127.0.0.1:11434/v1"],
      ["root + /v1/", "http://127.0.0.1:11434/v1/"]
    ] as const) {
      it(`local_llm: fetch-URL blir ALDRI /v1/v1 for input-form "${label}"`, async () => {
        const fetchSpy = vi.fn(
          async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: "hei" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200
            })
        );
        vi.stubGlobal("fetch", fetchSpy);
        await new LocalOpenAiCompatibleAdapter(envUrl, "m").complete(REQUEST);
        const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
        expect(url).not.toContain("/v1/v1");
      });
    }
  });
});

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt B): live host-kjøring viste ekte
 * `gemini_error_404`/`kimi_error_404` - kode+dokumentasjonsforskning fant
 * INGEN åpenbart avvik i eksisterende endepunkt-/modell-/auth-konstruksjon
 * (se PR-beskrivelsen), så fiksen her er TRYGG feilsøkings-diagnostikk
 * (`classifyHttpStatus()` sitt nye `diagnostic`-parameter) - IKKE en gjettet
 * URL-/modell-endring. Disse testene beviser diagnostikken er ekte nyttig
 * OG hemmelighets-trygg, uansett om selve 404-årsaken forblir uverifisert
 * uten en live nøkkel.
 */
describe("D-106 HOST-FIX Defekt B: trygg feilsøkings-diagnostikk for Gemini/Kimi HTTP-feil", () => {
  it("gemini: 404 klassifiseres til bad_request MED trygg diagnostikk (provider_error_code/sanitized_endpoint/request_operation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 404, message: "models/gemini-9000 is not found", status: "NOT_FOUND" } }), {
            status: 404
          })
      )
    );
    const err = await new GeminiAdapter("hemmelig-key", "gemini-2.5-flash", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.kind).toBe("bad_request");
    expect(pe.status).toBe(404);
    expect(pe.diagnostic?.provider_error_code).toBe("NOT_FOUND");
    expect(pe.diagnostic?.sanitized_endpoint).toBe("mock/v1beta/models/gemini-2.5-flash:generateContent");
    expect(pe.diagnostic?.request_operation).toBe("generateContent");
  });

  it("kimi: 404 klassifiseres til bad_request MED trygg diagnostikk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" } }), {
            status: 404
          })
      )
    );
    const err = await new KimiAdapter("hemmelig-key", "kimi-latest", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.kind).toBe("bad_request");
    expect(pe.status).toBe(404);
    expect(pe.diagnostic?.provider_error_code).toBe("model_not_found");
    expect(pe.diagnostic?.sanitized_endpoint).toBe("mock/v1/chat/completions");
    expect(pe.diagnostic?.request_operation).toBe("chat.completions");
  });

  it("gemini/kimi: diagnostikk-objektet inneholder ALDRI API-nøkkelen (verken i provider_error_code, sanitized_endpoint eller feilmeldingen)", async () => {
    const secret = "sk-super-hemmelig-nokkel-12345";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 404, status: "NOT_FOUND" } }), { status: 404 }))
    );
    const geminiErr = (await new GeminiAdapter(secret, "gemini-2.5-flash", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e)) as ProviderError;
    const dump = JSON.stringify({ message: geminiErr.message, diagnostic: geminiErr.diagnostic, status: geminiErr.status });
    expect(dump).not.toContain(secret);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 }))
    );
    const kimiErr = (await new KimiAdapter(secret, "kimi-latest", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e)) as ProviderError;
    const kimiDump = JSON.stringify({ message: kimiErr.message, diagnostic: kimiErr.diagnostic, status: kimiErr.status });
    expect(kimiDump).not.toContain(secret);
  });

  it("gemini: 401/403 forblir klassifisert som 'auth' (uendret klassifiseringspolicy), men bærer NÅ også trygg diagnostikk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED" } }), { status: 403 }))
    );
    const err = (await new GeminiAdapter("k", "m", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe("auth");
    expect(err.diagnostic?.provider_error_code).toBe("PERMISSION_DENIED");
  });

  it("kimi: 404 MED ugyldig/ikke-JSON body feiler fortsatt trygt (diagnostikk er beste-innsats, aldri en krasjende avhengighet)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ikke json", { status: 404 })));
    const err = (await new KimiAdapter("k", "m", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("bad_request");
    expect(err.diagnostic?.provider_error_code).toBeUndefined();
    expect(err.diagnostic?.sanitized_endpoint).toBe("mock/v1/chat/completions");
  });

  it("gemini: default-modellen er gemini-3.6-flash (D-106 GEMINI MODEL MIGRATION - live-bevis fant en EKTE utdatert default, ikke en gjettet 404-årsak, se gemini.ts)", () => {
    expect(new GeminiAdapter("k", undefined, "http://mock").model).toBe("gemini-3.6-flash");
  });

  it("gemini: eksplisitt konstruktør-modell vinner ALLTID over defaulten", () => {
    expect(new GeminiAdapter("k", "gemini-custom-override", "http://mock").model).toBe("gemini-custom-override");
  });

  it("gemini: JARVIS_GEMINI_MODEL-miljøvariabelen vinner over defaulten når konstruktør-argumentet er udefinert", () => {
    const prev = process.env["JARVIS_GEMINI_MODEL"];
    process.env["JARVIS_GEMINI_MODEL"] = "gemini-env-override";
    try {
      expect(new GeminiAdapter("k", process.env["JARVIS_GEMINI_MODEL"], "http://mock").model).toBe("gemini-env-override");
    } finally {
      if (prev === undefined) delete process.env["JARVIS_GEMINI_MODEL"];
      else process.env["JARVIS_GEMINI_MODEL"] = prev;
    }
  });

  it("gemini: kanonisk endepunkt med default-modellen er nøyaktig /v1beta/models/gemini-3.6-flash:generateContent - bygget ÉN gang, ingen dobbel sti-konstruksjon", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 }
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new GeminiAdapter("k", undefined, "http://mock");
    const result = await adapter.complete(REQUEST);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mock/v1beta/models/gemini-3.6-flash:generateContent");
    expect(result.model).toBe("gemini-3.6-flash");
    expect(result.provider).toBe("gemini");
    expect(result.text).toBe("pong");
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.finish_reason).toBe("STOP");
  });

  it("kimi: base-URL-en er UENDRET (https://api.moonshot.ai, matcher offisiell Moonshot-dokumentasjon) - Defekt B ble IKKE 'fikset' ved å gjette en URL uten bevist rot-årsak", () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    return new KimiAdapter("k", "m").complete(REQUEST).then(() => {
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    });
  });
});

/** SSE-mock: Response med data-linjer som ReadableStream. */
function sseResponse(events: unknown[], done = true): Response {
  const lines = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(new Blob([lines]).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("P1A adapter-streaming conformance (§5-§6, §24)", () => {
  it("openai: SSE-deltas → normaliserte events + rekonstruert resultat med ttft/usage", async () => {
    mockFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: "hei " } }] },
        { choices: [{ delta: { content: "verden" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }
      ])
    );
    const events: string[] = [];
    const result = await new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, (e) => events.push(e.type));
    expect(result.text).toBe("hei verden");
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(events[0]).toBe("start");
    expect(events.at(-1)).toBe("finish");
  });

  it("openai: tool-call-deltas reassembles og valideres først ved komplett payload", async () => {
    mockFetch(() =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_x", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }
      ])
    );
    const order: string[] = [];
    const result = await new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, (e) => order.push(e.type));
    expect(result.tool_calls?.[0]).toMatchObject({ tool_call_id: "call_1", tool_name: "read_x", arguments: { a: 1 } });
    expect(order.indexOf("tool_call_complete")).toBeGreaterThan(order.lastIndexOf("tool_call_delta"));
  });

  it("anthropic: native events → samme normaliserte kontrakt", async () => {
    mockFetch(() =>
      sseResponse(
        [
          { type: "message_start", message: { usage: { input_tokens: 9 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hei " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
          { type: "message_stop" }
        ],
        false
      )
    );
    const events: string[] = [];
    const result = await new AnthropicAdapter("k", "m", "http://mock").stream(REQUEST, (e) => events.push(e.type));
    expect(result.text).toBe("hei claude");
    expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 4 });
    expect(result.finish_reason).toBe("end_turn");
    expect(events[0]).toBe("start");
  });

  it("anthropic: tool_use-blokk via input_json_delta → normalisert tool call", async () => {
    mockFetch(() =>
      sseResponse(
        [
          { type: "message_start", message: { usage: { input_tokens: 3 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_x" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "2}" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } }
        ],
        false
      )
    );
    const result = await new AnthropicAdapter("k", "m", "http://mock").stream(REQUEST, () => undefined);
    expect(result.tool_calls?.[0]).toMatchObject({ tool_call_id: "toolu_1", tool_name: "read_x", arguments: { a: 2 } });
    expect(result.finish_reason).toBe("tool_use");
  });

  it("tool-exchange oversettes provider-riktig i begge adaptere (cross-provider resume)", async () => {
    const exchange = {
      tool_exchanges: [{
        calls: [{ tool_call_id: "c1", tool_name: "read_x", arguments: { a: 1 }, provider: "openai", model: "m" }],
        results: [{ tool_call_id: "c1", tool_name: "read_x", execution_id: "e1", success: true, output: { ok: 1 }, at: "2026-08-14T00:00:00Z" }]
      }]
    };
    let capturedBody: Record<string, unknown> = {};
    const capture = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", capture);
    await new OpenAiAdapter("k", "m", "http://mock").complete({ ...REQUEST, ...exchange });
    const oaMessages = capturedBody["messages"] as Array<Record<string, unknown>>;
    expect(oaMessages.some((m) => m["role"] === "assistant" && Array.isArray(m["tool_calls"]))).toBe(true);
    expect(oaMessages.some((m) => m["role"] === "tool" && m["tool_call_id"] === "c1")).toBe(true);

    const capture2 = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", capture2);
    await new AnthropicAdapter("k", "m", "http://mock").complete({ ...REQUEST, ...exchange });
    const antMessages = capturedBody["messages"] as Array<Record<string, unknown>>;
    const toolUse = antMessages.find((m) => Array.isArray(m["content"]) && (m["content"] as Array<{ type: string }>)[0]?.type === "tool_use");
    const toolResult = antMessages.find((m) => Array.isArray(m["content"]) && (m["content"] as Array<{ type: string }>)[0]?.type === "tool_result");
    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
  });
});
