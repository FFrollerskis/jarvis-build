import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  GeminiAdapter,
  HermesAdapter,
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
    // D-360: Hermes (NousResearch) - samme OpenAI-kompatible chat/completions-form som Kimi.
    name: "hermes",
    make: () => new HermesAdapter("test-key", "test-model", "http://mock"),
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
                      : c.name === "hermes"
                        ? new HermesAdapter("", "m", "http://mock")
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

  it("gemma_hosted: complete() filtrerer ALDRI-strømmede `thought: true`-parter fra sluttsvaret (D-206, samme resonnerings-lekkasje som .stream() - se sse-fixtures.test.ts)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Brukeren sa hei. Jeg bør svare høflig.", thought: true },
                    { text: "Hei! Hvordan kan jeg hjelpe?" }
                  ]
                },
                finishReason: "STOP"
              }
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 9 }
          }),
          { status: 200 }
        )
    );
    const result = await new GemmaHostedAdapter("k", "m", "http://mock").complete(REQUEST);
    expect(result.text).toBe("Hei! Hvordan kan jeg hjelpe?");
    expect(result.text).not.toContain("Brukeren sa hei");
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

  it("gemma_hosted: fjerner additionalProperties (rekursivt) fra tool-skjemaer før de sendes til Gemini API (D-204, host-bevis: Gemini avviser denne nøkkelen med bad_request - Jarvis sine mesh-bridge.ts-verktøyskjemaer bruker den alle, gyldig for openai/anthropic)", async () => {
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
      tools: [
        {
          name: "read_recent_email",
          description: "les e-post",
          input_schema: {
            type: "object",
            properties: {
              filter: { type: "object", properties: {}, additionalProperties: false }
            },
            required: [],
            additionalProperties: false
          }
        }
      ]
    });
    const tools = capturedBody["tools"] as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    const parameters = tools[0]?.functionDeclarations[0]?.parameters;
    expect(JSON.stringify(parameters)).not.toContain("additionalProperties");
    // Andre nøkler (inkl. i det nestede objektet) overlever uendret - kun DENNE ene, konkret bevist usupporterte nøkkelen fjernes.
    expect(parameters).toEqual({
      type: "object",
      properties: { filter: { type: "object", properties: {} } },
      required: []
    });
  });

  it("D-341: gemma_hosted kollapser anyOf/oneOf/allOf (unions, IKKE støttet av Gemini sitt Schema-format) til en tom, permissiv skjema - samme host-bevist 400-klasse som D-204, men for et konstrukt additionalProperties-strippingen ALDRI dekket (f.eks. Google Sheets sin celleverdi-union i mesh-bridge.ts sin allMeshTools())", async () => {
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
      tools: [
        {
          name: "google_sheets__append_row",
          description: "legg til rad",
          input_schema: {
            type: "object",
            properties: {
              row: {
                type: "array",
                items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }
              }
            },
            required: ["row"],
            additionalProperties: false
          }
        }
      ]
    });
    const tools = capturedBody["tools"] as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    const parameters = tools[0]?.functionDeclarations[0]?.parameters;
    expect(JSON.stringify(parameters)).not.toContain("anyOf");
    expect(parameters).toEqual({
      type: "object",
      properties: { row: { type: "array", items: {} } },
      required: ["row"]
    });
  });

  it("D-341: gemini/gemma_hosted saniterer structured_schema (responseSchema) FØR sending - additionalProperties manglet HELT denne stripping frem til nå (host-bevist gemini_error_400 for modules/memory/src/extraction.ts sitt uttrekk-skjema)", async () => {
    const extractionLikeSchema = {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string" } },
            required: ["type"],
            additionalProperties: false
          }
        }
      },
      required: ["candidates"],
      additionalProperties: false
    };

    let geminiBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        geminiBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: {} }),
          { status: 200 }
        );
      })
    );
    await new GeminiAdapter("k", "m", "http://mock").complete({ ...REQUEST, structured_schema: extractionLikeSchema });
    const geminiConfig = geminiBody["generationConfig"] as { responseSchema: Record<string, unknown> };
    expect(JSON.stringify(geminiConfig.responseSchema)).not.toContain("additionalProperties");

    let gemmaBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        gemmaBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }], usageMetadata: {} }),
          { status: 200 }
        );
      })
    );
    await new GemmaHostedAdapter("k", "m", "http://mock").complete({ ...REQUEST, structured_schema: extractionLikeSchema });
    const gemmaConfig = gemmaBody["generationConfig"] as { responseSchema: Record<string, unknown> };
    expect(JSON.stringify(gemmaConfig.responseSchema)).not.toContain("additionalProperties");
  });

  it("D-343: gemma_hosted fjerner exclusiveMinimum/exclusiveMaximum (OpenAPI-3.0-boolsk stil fra Zod sin .positive()/.int().positive(), IKKE dokumentert i Google sitt Schema-format) fra verktøy-parametre - host-bevist voice_core_error for finance-relaterte verktøy (f.eks. finance:create_payment_intent sitt amount_ore) selv ETTER D-341 sin anyOf/additionalProperties-fiks var live - minimum/maximum selv BEHOLDES uendret", async () => {
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
      tools: [
        {
          name: "finance__create_payment_intent",
          description: "opprett betalingsintensjon",
          input_schema: {
            type: "object",
            properties: { amount_ore: { type: "integer", exclusiveMinimum: true, minimum: 0 } },
            required: ["amount_ore"]
          }
        }
      ]
    });
    const tools = capturedBody["tools"] as Array<{ functionDeclarations: Array<{ parameters: Record<string, unknown> }> }>;
    const parameters = tools[0]?.functionDeclarations[0]?.parameters;
    expect(JSON.stringify(parameters)).not.toContain("exclusiveMinimum");
    expect(JSON.stringify(parameters)).not.toContain("exclusiveMaximum");
    expect(parameters).toEqual({
      type: "object",
      properties: { amount_ore: { type: "integer", minimum: 0 } },
      required: ["amount_ore"]
    });
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
describe("D-106 HOST-FIX Defekt B: trygg feilsøkings-diagnostikk for Gemini/Kimi/Gemma HTTP-feil", () => {
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

  it("hermes: 404 klassifiseres til bad_request MED trygg diagnostikk (D-360, samme OpenAI-kompatible mønster som kimi)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "model not found", code: "model_not_found" } }), {
            status: 404
          })
      )
    );
    const err = await new HermesAdapter("hemmelig-key", "Hermes-4-70B", "http://mock")
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

  it("gemma_hosted: 400 klassifiseres til bad_request MED trygg diagnostikk (D-106 HOST-FIX Defekt B, tidligere manglet for denne adapteren - host-bevis 2026-09-20: hvert reelt `gemma_hosted`-kall feilet opakt med `bad_request` og falt stille tilbake til `openai`)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 400, message: "Invalid JSON payload received", status: "INVALID_ARGUMENT" } }),
            { status: 400 }
          )
      )
    );
    const err = await new GemmaHostedAdapter("hemmelig-key", "gemma-4-26b-a4b-it", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.kind).toBe("bad_request");
    expect(pe.status).toBe(400);
    expect(pe.diagnostic?.provider_error_code).toBe("INVALID_ARGUMENT");
    expect(pe.diagnostic?.sanitized_endpoint).toBe("mock/v1beta/models/gemma-4-26b-a4b-it:generateContent");
    expect(pe.diagnostic?.request_operation).toBe("generateContent");
  });

  it("anthropic: 400 klassifiseres til bad_request MED trygg diagnostikk (D-340, samme mønster som gemma_hosted over - anthropic.ts manglet denne diagnostikken siden UA-1, host-bevis 2026-09-28: en reell 400 var til nå en helt opak 'anthropic_error_400')", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "model: not_a_real_model" } }),
            { status: 400 }
          )
      )
    );
    const err = await new AnthropicAdapter("hemmelig-key", "claude-sonnet-5", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.kind).toBe("bad_request");
    expect(pe.status).toBe(400);
    expect(pe.diagnostic?.provider_error_code).toBe("invalid_request_error");
    expect(pe.diagnostic?.sanitized_endpoint).toBe("mock/v1/messages");
    expect(pe.diagnostic?.request_operation).toBe("messages");
  });

  it("gemma_hosted: stream()-operasjonen sin diagnostikk merker request_operation som streamGenerateContent, ikke generateContent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 }))
    );
    const err = await new GemmaHostedAdapter("hemmelig-key", "gemma-4-26b-a4b-it", "http://mock")
      .stream(REQUEST, () => {})
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.diagnostic?.request_operation).toBe("streamGenerateContent");
    expect(pe.diagnostic?.sanitized_endpoint).toBe("mock/v1beta/models/gemma-4-26b-a4b-it:streamGenerateContent");
  });

  it("gemma_hosted: diagnostikk-objektet inneholder ALDRI API-nøkkelen", async () => {
    const secret = "sk-super-hemmelig-nokkel-12345";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }), { status: 400 }))
    );
    const err = (await new GemmaHostedAdapter(secret, "m", "http://mock")
      .complete(REQUEST)
      .then(() => null)
      .catch((e: unknown) => e)) as ProviderError;
    const dump = JSON.stringify({ message: err.message, diagnostic: err.diagnostic, status: err.status });
    expect(dump).not.toContain(secret);
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

  it("D-340 (host-bevist, NAS-deploy 2026-09-28): en TOM (men til stede) JARVIS_GEMINI_MODEL faller fortsatt tilbake til defaulten - docker compose sin env_file-mekanisme setter variabelen til en FAKTISK tom streng når .env inneholder 'NAVN=' uten verdi, og en rå '??' fanger IKKE det tilfellet (kun null/undefined)", () => {
    const prev = process.env["JARVIS_GEMINI_MODEL"];
    process.env["JARVIS_GEMINI_MODEL"] = "";
    try {
      // Selve produksjonsbugen: den samme defaulterings-logikken adapteren FAKTISK bruker
      // (uten konstruktør-argument, direkte fra process.env, slik `mesh-bridge.ts` konstruerer den).
      expect(new GeminiAdapter().model).toBe("gemini-3.6-flash");
    } finally {
      if (prev === undefined) delete process.env["JARVIS_GEMINI_MODEL"];
      else process.env["JARVIS_GEMINI_MODEL"] = prev;
    }
  });

  it("D-340: samme tom-streng-fallback for anthropic (JARVIS_ANTHROPIC_MODEL) og gemma_hosted (JARVIS_GEMMA_MODEL + GEMMA_API_KEY→GEMINI_API_KEY-kjeden)", () => {
    const prevAnthropicModel = process.env["JARVIS_ANTHROPIC_MODEL"];
    const prevGemmaModel = process.env["JARVIS_GEMMA_MODEL"];
    const prevGemmaKey = process.env["GEMMA_API_KEY"];
    const prevGeminiKey = process.env["GEMINI_API_KEY"];
    process.env["JARVIS_ANTHROPIC_MODEL"] = "";
    process.env["JARVIS_GEMMA_MODEL"] = "";
    process.env["GEMMA_API_KEY"] = "";
    process.env["GEMINI_API_KEY"] = "delt-nokkel-fallback";
    try {
      expect(new AnthropicAdapter().model).toBe("claude-sonnet-5");
      const gemma = new GemmaHostedAdapter();
      expect(gemma.model).toBe("gemma-4-26b-a4b-it");
      expect(gemma.available()).toBe(true); // GEMMA_API_KEY="" skal falle tilbake til GEMINI_API_KEY, ikke bli værende tom.
    } finally {
      if (prevAnthropicModel === undefined) delete process.env["JARVIS_ANTHROPIC_MODEL"];
      else process.env["JARVIS_ANTHROPIC_MODEL"] = prevAnthropicModel;
      if (prevGemmaModel === undefined) delete process.env["JARVIS_GEMMA_MODEL"];
      else process.env["JARVIS_GEMMA_MODEL"] = prevGemmaModel;
      if (prevGemmaKey === undefined) delete process.env["GEMMA_API_KEY"];
      else process.env["GEMMA_API_KEY"] = prevGemmaKey;
      if (prevGeminiKey === undefined) delete process.env["GEMINI_API_KEY"];
      else process.env["GEMINI_API_KEY"] = prevGeminiKey;
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

  it("hermes: base-URL-en og default-modellen matcher Nous sin offisielle dokumentasjon (D-360, WebSearch-verifisert - ingen nettverkstilgang til inference-api.nousresearch.com i denne sandkassen for en live-ringbekreftelse, se hermes.ts)", () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new HermesAdapter("k");
    expect(adapter.model).toBe("Hermes-4-70B");
    return adapter.complete(REQUEST).then(() => {
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://inference-api.nousresearch.com/v1/chat/completions");
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
