import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
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
 * Streaming: IKKE implementert i denne runden. D-81-verifisering (WebSearch mot
 * Googles offisielle Gemini API-dokumentasjon, se D-81 i
 * DECISIONS_AND_ASSUMPTIONS.md): `streamGenerateContent` (SSE, `alt=sse`) er
 * en GENERISK metode på SAMME `models/{model}`-ressurs som `generateContent`
 * for BÅDE Gemini- og Gemma-modeller - dette er altså en LEVERANDØR-STØTTET
 * kapabilitet (`PROVIDER_SUPPORT=true`), IKKE en Gemma-spesifikk begrensning.
 * Utelatelsen her er en BEVISST implementasjons-avgrensning
 * (`ADAPTER_SUPPORT=false`) - å bygge ekte SSE-parsing/tool-call-delta-
 * rekonstruksjon (samme kompleksitet som `openai.ts`/`anthropic.ts` sine
 * `.stream()`-metoder) er IKKE trivielt og er derfor bevisst utsatt til en
 * egen fremtidig runde (Q-30), IKKE implementert her for å unngå scope-økning
 * i en sikkerhetsherdingsrunde. `ModelGateway.executePlan()` degraderer
 * allerede trygt til enkelt-delta via `.complete()` for adaptere uten
 * `.stream()` - ingen krasj, kun tapt ekte token-for-token-latens.
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
    private readonly apiKey: string | undefined = process.env["GEMMA_API_KEY"] ?? process.env["GEMINI_API_KEY"],
    readonly model: string = process.env["JARVIS_GEMMA_MODEL"] ?? "gemma-4-26b-a4b-it",
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

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const contents = this.toGemmaContents(request.messages, request.tool_exchanges);
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          contents,
          ...(request.tools?.length
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parameters: t.input_schema
                    }))
                  }
                ]
              }
            : {}),
          generationConfig: {
            maxOutputTokens: request.max_tokens ?? 1024,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.structured_schema
              ? { responseMimeType: "application/json", responseSchema: request.structured_schema }
              : {})
          }
        })
      });
    } catch (err) {
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      throw classifyHttpStatus(this.name, response.status);
    }
    let body: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> };
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
    const text = parts.map((p) => p.text ?? "").join("");
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
}
