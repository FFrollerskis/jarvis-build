import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  envOrDefault,
  extractProviderErrorCode,
  firstNonEmptyEnv,
  ProviderError,
  sanitizeEndpointForDiagnostics,
  sanitizeGeminiSchema,
  sseLines,
  type ChatMessage,
  type ContentPart,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest
} from "./types.ts";

/**
 * D-79 (AI Mesh Gemma-first kost-/personvernarkitektur): hostet Gemma via
 * Googles Gemini API (samme `generateContent`-endepunkt/autentiseringsmønster
 * som `GeminiAdapter` - Google server Gemma-modeller gjennom nøyaktig samme
 * API-flate). Nøkkel sendes i header (`x-goog-api-key`), ALDRI i URL
 * (samme sikkerhetsinvariant som Gemini). EGEN provider-identitet ("gemma_hosted"),
 * IKKE bare en annen `JARVIS_GEMINI_MODEL`-verdi - trenger uavhengig helse-/
 * kost-/capability-sporing og en EKSPLISITT `hosted_free_tier`-markering i
 * capability-registryet (§3: gratis-tier skal ALDRI motta sensitivt innhold
 * automatisk).
 *
 * Modeller er IKKE oppfunnet her - eksakte ID-er (`gemma-4-26b-a4b-it` default,
 * `gemma-4-31b-it` som alternativ) er oppgitt av Tobias og satt via
 * `JARVIS_GEMMA_MODEL` (samme konvensjon som øvrige adaptere - aldri hardkodet
 * utover default-verdien).
 *
 * Streaming: EKTE (D-199-B, Q-30 lukket). `streamGenerateContent` (SSE,
 * `alt=sse`) er SAMME generiske metode på `models/{model}`-ressursen som
 * `generateContent` (D-81-verifisert mot Googles offisielle Gemini API-
 * dokumentasjon), forskjellen fra `complete()` er kun endepunkt+parsing.
 * I motsetning til Anthropic/OpenAI (som strømmer function-call-argumenter
 * som delvise JSON-biter) leverer Gemini API `functionCall`-parts KOMPLETTE
 * i én chunk - `tool_call_start` og `tool_call_complete` emittes derfor
 * RETT ETTER HVERANDRE for hvert funksjonskall (ingen delta-fase, se
 * `handleChunk()` under), ALDRI en oppdiktet delta-strøm som leverandøren
 * selv ikke sender. `ModelGateway.executePlan()` sin non-stream-fallback
 * for adaptere uten `.stream()` er nå IRRELEVANT for denne adapteren.
 *
 * Vision: EKTE (D-81) - Gemma 4 støtter bildeforståelse via Gemini API sitt
 * `inlineData`-part-format (samme mekanisme som tekst-multiturn), bekreftet
 * via offisiell dokumentasjonsgjennomgang. `toGemmaParts()` under mapper
 * `ContentPart`-bilder til `{inlineData:{mimeType,data}}` - SAMME mønster som
 * `anthropic.ts` sin `toAnthropicContent()`. `vision`-capability er satt i
 * `capability-registry.ts` sin `gemma_hosted`-profil (KUN her og `anthropic` -
 * `openai`/`gemini`/`local_llm` bruker fortsatt `textOnly()`/har ingen
 * bilde-wiring). Personvern-gaten (`isSensitivityEligible()`) gjelder
 * UENDRET og FØRST for ALLE forespørsler til denne adapteren, uavhengig av om
 * de inneholder bilder - vision-innhold til `gemma_hosted` krever DERFOR
 * fortsatt eksplisitt `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å
 * kunne rutes hit i det hele tatt (D-81 §1) - dette åpner ALDRI en sidevei
 * for at private Gmail-vedlegg skal kunne nå gratis-tieret.
 *
 * Tool calling: EKTE (Gemini API sin `functionDeclarations`/`functionCall`-
 * flate) - modellen returnerer normaliserte `ToolCallRequest`-objekter som
 * går gjennom SAMME `ModelGateway.executeToolCall()` → `ToolGateway` →
 * `PolicyGateway`-kjede som alle andre providere (§12: aldri direkte
 * verktøyutførelse fra modellen).
 */
/** Ett Gemini-API-innholdselement - dekker turtypene adapteren faktisk sender. */
type GemmaPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { name: string; content: unknown } } };

/**
 * D-81: provider-nøytralt `ContentPart[]` → Gemini-API-parts. Bilder mappes
 * til `inlineData` (base64, RÅ - ALDRI en `data:`-URI-prefiks, se
 * `types.ts` sin `ContentPart`-kommentar). Streng-innhold degraderer til
 * ett tekst-part (uendret oppførsel for ALLE eksisterende, tekst-only kall).
 */
function toGemmaParts(content: ChatMessage["content"]): GemmaPart[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part: ContentPart) =>
    part.type === "text" ? { text: part.text } : { inlineData: { mimeType: part.media_type, data: part.data } }
  );
}
interface GemmaContent {
  role: "user" | "model" | "function";
  parts: GemmaPart[];
}

export class GemmaHostedAdapter implements ModelProviderAdapter {
  readonly name: string = "gemma_hosted";

  constructor(
    private readonly apiKey: string | undefined = firstNonEmptyEnv("GEMMA_API_KEY", "GEMINI_API_KEY"),
    readonly model: string = envOrDefault("JARVIS_GEMMA_MODEL", "gemma-4-26b-a4b-it"),
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 60_000)
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  private toGemmaContents(messages: ChatMessage[], toolExchanges: ModelRequest["tool_exchanges"]): GemmaContent[] {
    const contents: GemmaContent[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: toGemmaParts(m.content)
    }));
    for (const ex of toolExchanges ?? []) {
      contents.push({
        role: "model",
        parts: ex.calls.map((c) => ({ functionCall: { name: c.tool_name, args: c.arguments } }))
      });
      contents.push({
        role: "function",
        parts: ex.results.map((r) => ({
          functionResponse: {
            name: r.tool_name,
            response: { name: r.tool_name, content: r.success ? r.output : { error: r.error_category ?? "tool_failed" } }
          }
        }))
      });
    }
    return contents;
  }

  private parseFunctionCall(name: string, args: Record<string, unknown>): ToolCallRequest {
    return {
      tool_call_id: `call-${randomUUID().slice(0, 8)}`,
      tool_name: name,
      arguments: args,
      provider: this.name,
      model: this.model
    };
  }

  /** Provider-nøytral request → Gemini-API-body. Delt av `complete()`/`stream()` - IKKE duplisert. */
  private buildRequestBody(request: ModelRequest): Record<string, unknown> {
    const contents = this.toGemmaContents(request.messages, request.tool_exchanges);
    return {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      contents,
      ...(request.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: sanitizeGeminiSchema(t.input_schema)
                }))
              }
            ]
          }
        : {}),
      generationConfig: {
        maxOutputTokens: request.max_tokens ?? 1024,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // D-341: samme Google Schema-begrensning som verktøy-parametre over -
        // `responseSchema` manglet denne saneringen helt (host-bevist
        // `gemini_error_400` for `modules/memory/src/extraction.ts` sitt
        // `additionalProperties: false`-holdige uttrekk-skjema).
        ...(request.structured_schema
          ? { responseMimeType: "application/json", responseSchema: sanitizeGeminiSchema(request.structured_schema) }
          : {})
      }
    };
  }

  private async post(request: ModelRequest, streamMode: boolean, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const method = streamMode ? "streamGenerateContent?alt=sse" : "generateContent";
    const url = `${this.baseUrl}/v1beta/models/${this.model}:${method}`;
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs);
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify(this.buildRequestBody(request))
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      }
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      // D-106 HOST-FIX (Defekt B, samme mønster som gemini.ts/kimi.ts): trygg,
      // begrenset feilsøkings-metadata - ALDRI nøkkelen (den sendes i
      // `x-goog-api-key`-header, aldri i URL-en over), ALDRI hele body.
      // `gemma_hosted` manglet denne diagnostikken fra D-79 av (bygget FØR
      // D-106 HOST-FIX-runden som ga gemini/kimi dette) - hver reelle
      // `bad_request` fra Gemini API har derfor til nå vært en helt opak
      // `gemma_hosted_error_400` uten noen indikasjon på ÅRSAK (host-bevis,
      // 2026-09-20: `cost_events` viste gjentatte `model:failed:bad_request`
      // for `gemma_hosted` uten noen ytterligere detalj å feilsøke fra).
      let providerErrorCode: string | undefined;
      try {
        providerErrorCode = extractProviderErrorCode(await response.text());
      } catch {
        // Body kunne ikke leses - diagnostikk er beste-innsats, aldri en blokkerende avhengighet.
      }
      const sanitizedEndpoint = sanitizeEndpointForDiagnostics(url);
      throw classifyHttpStatus(this.name, response.status, {
        ...(providerErrorCode !== undefined ? { provider_error_code: providerErrorCode } : {}),
        ...(sanitizedEndpoint !== undefined ? { sanitized_endpoint: sanitizedEndpoint } : {}),
        request_operation: streamMode ? "streamGenerateContent" : "generateContent"
      });
    }
    return response;
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, false);
    let body: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> } }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
    };
    try {
      body = (await response.json()) as typeof body;
      if (!Array.isArray(body.candidates)) {
        throw new Error("mangler candidates");
      }
    } catch {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_response`);
    }
    const parts = body.candidates[0]?.content?.parts ?? [];
    // D-206 (host-bevis, 2026-09-20): Gemini sine "thinking"-modeller (Gemma 4)
    // returnerer resonnerings-tekst som EGNE parts merket `thought: true` -
    // IKKE den faktiske svarteksten. Uten dette filteret ble modellens interne
    // resonnering ("The user said X... I should respond...") synlig i selve
    // Jarvis-svaret til eieren (observert live i chatten). `thought`-parter har
    // ALDRI `functionCall`, så verktøykalls-filtreringen under er upåvirket.
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (text) onToken?.(text);
    let toolCalls: ToolCallRequest[] | undefined;
    try {
      toolCalls = parts
        .filter((p): p is { functionCall: { name: string; args?: Record<string, unknown> } } => Boolean(p.functionCall))
        .map((p) => this.parseFunctionCall(p.functionCall.name, p.functionCall.args ?? {}));
    } catch {
      throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_arguments`);
    }
    let structured: unknown;
    if (request.structured_schema && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_structured_output`);
      }
    }
    const usage = body.usageMetadata ?? {};
    return {
      text,
      usage: {
        input_tokens: usage.promptTokenCount ?? 0,
        output_tokens: usage.candidatesTokenCount ?? 0,
        ...(usage.cachedContentTokenCount !== undefined ? { cached_tokens: usage.cachedContentTokenCount } : {})
      },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.candidates[0]?.finishReason ? { finish_reason: body.candidates[0].finishReason } : {}),
      ...(structured !== undefined ? { structured_output: structured } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
  }

  /**
   * D-199-B (Q-30 lukket): ekte SSE-strømming via `streamGenerateContent?alt=sse`.
   * Én chunk = SAMME skjema som `complete()` sin body (`candidates[].content.
   * parts[]`), IKKE et Anthropic/OpenAI-stil delta-objekt - se `sseLines()`
   * (delt SSE-linjedeler, `types.ts`) og filhodets kommentar for hvorfor
   * funksjonskall ALDRI får en delta-fase her (leverandøren selv sender dem
   * komplette i én chunk).
   */
  async stream(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, true, signal);
    if (!response.body) {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_no_stream_body`);
    }
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: `gen-${randomUUID().slice(0, 12)}` });
    let text = "";
    let ttft: number | undefined;
    let finish = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens: number | undefined;
    const completedCalls: ToolCallRequest[] = [];
    try {
      for await (const data of sseLines(response.body)) {
        let chunk: {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> } }> };
            finishReason?: string;
          }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // D-206: se `complete()` sin kommentar - `thought`-parter er
          // modellens interne resonnering, ALDRI svaret som skal strømmes.
          if (part.text && !part.thought) {
            if (ttft === undefined) ttft = Date.now() - started;
            text += part.text;
            onEvent({ type: "text_delta", text: part.text });
          } else if (part.functionCall) {
            if (ttft === undefined) ttft = Date.now() - started;
            const call = this.parseFunctionCall(part.functionCall.name, part.functionCall.args ?? {});
            onEvent({ type: "tool_call_start", tool_call_id: call.tool_call_id, tool_name: call.tool_name });
            completedCalls.push(call);
            onEvent({ type: "tool_call_complete", call });
          }
        }
        if (candidate?.finishReason) finish = candidate.finishReason;
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
          if (chunk.usageMetadata.cachedContentTokenCount !== undefined) {
            cachedTokens = chunk.usageMetadata.cachedContentTokenCount;
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (signal?.aborted) {
        onEvent({ type: "cancelled" });
        throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      }
      throw new ProviderError(this.name, "stream_interrupted", `${this.name}_stream_interrupted: ${(err as Error).message.slice(0, 80)}`);
    }
    if (signal?.aborted) {
      onEvent({ type: "cancelled" });
      throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
    }
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens, ...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}) };
    onEvent({ type: "usage", usage });
    onEvent({ type: "finish", finish_reason: finish || "STOP" });
    return {
      text,
      usage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
      finish_reason: finish || "STOP",
      ...(completedCalls.length > 0 ? { tool_calls: completedCalls } : {})
    };
  }
}
