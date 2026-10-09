import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  envOrDefault,
  envPositiveInt,
  extractProviderErrorCode,
  firstNonEmptyEnv,
  ProviderError,
  sanitizeEndpointForDiagnostics,
  sseLines,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest
} from "./types.ts";
import { normalizeToolCalls, openAiToolReplayMessages, ToolCallStreamAssembler, toOpenAiToolDefinitions, type ToolCallDelta } from "./openai-compat-tools.ts";

/**
 * Kimi (Moonshot AI)-adapter. Masterplan v4.0 planlegger Kimi for long
 * context/reasoning (UA-1 P0-registry); Moonshot eksponerer et OpenAI-
 * kompatibelt chat/completions-API, så adapteren normaliserer det formatet.
 * Base-URL/modell er konfig (JARVIS_KIMI_URL/JARVIS_KIMI_MODEL); nøkkel fra
 * KIMI_API_KEY (fallback MOONSHOT_API_KEY).
 *
 * D-106 PR #53 HOST FIX (live-bevis, 2026-08-23): default-modellen var
 * `"kimi-latest"` - denne finnes IKKE i Moonshot sin modellkatalog (verifisert
 * BÅDE mot Tobias sitt ekte kontos `/v1/models`-svar OG uavhengig mot
 * Moonshot sin offentlige modell-dokumentasjon - se D-41: aldri gjettet,
 * alltid verifisert). Ekte kontoer eksponerer versjonerte modell-IDer
 * (`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, ...) - INGEN "latest"-alias.
 * `kimi-k3` er Moonshot sitt gjeldende generelle flaggskip-chat-endepunkt
 * (de "-code"/"-highspeed"-variantene er spesialiserte, ikke generell chat).
 *
 * JARVIS-036 (WP-D4): VERKTØYKALL + STREAMING. Moonshot bruker OpenAI-formatet: `tools: [{type:"function", function:{name, description, parameters}}]` i forespørselen,
 * `message.tool_calls[{id, type:"function", function:{name, arguments}}]` (argumentene som JSON-STRENG) og `finish_reason: "tool_calls"` i svaret, og resultatet tilbake som
 * `{role:"tool", tool_call_id, content}`. Offisiell dokumentasjon (platform.kimi.ai, «tool use»): maks 128 funksjoner i `tools`, parallelle kall støttes, `functions` (utfaset) støttes ikke;
 * streaming-guiden: `stream_options: {include_usage: true}` gir en siste statistikk-chunk (tom `choices`, `usage` på toppnivå) FØR `data: [DONE]`.
 * VERIFISERINGSSTATUS (D-41, ærlig): sandkassen har ingen nettverkstilgang til Moonshot, så formatet over er bygget etter dokumentasjonen (lest via søk, ikke kjørt mot ekte API) og bevist mot
 * en fake server i `packages/provider-adapters/test/kimi-tools.test.ts`. LIVE-verifisering gjøres av eieren med `mesh-live-smoke.ts --tools` (docs/runbooks/AI_MESH_ACCEPTANCE.md).
 * Tre bevisste forsiktighetsregler siden bare dokumentasjon, ikke en ekte nøkkel, ligger til grunn:
 *  - `usage` leses fra toppnivå FØRST og deretter fra `choices[0].usage` (en tredjepartskilde hevdet at Moonshot legger den der; begge tåles, ingenting antas);
 *  - tenkemodeller (K2-serien) leverer `reasoning_content` sammen med verktøykall og kan avvise neste runde uten den: den bæres i `ToolCallRequest.provider_state` og spilles av KUN mot Kimi.
 *    `reasoning_content` havner aldri i svarteksten, og en gjenspilt runde fra en annen leverandør får ikke feltet;
 *  - en assistent-melding som kun bærer verktøykall sendes med `content: ""` (en tom streng er det API-et selv returnerer; `null` er OpenAI-standard men ikke bekreftet hos Moonshot).
 * Ugyldige verktøykall (ikke-JSON, ikke-objekt, uten navn) gir `invalid_tool_call` og leveres aldri; gatewayen utfører uansett kun via trusted executor.
 */
export const KIMI_MAX_TOOLS = 128;
/** Reasoning-tekst større enn dette bæres ikke videre (minnegrense); en tenkemodell kan da avvise neste runde - en ærlig feil i stedet for ubegrenset minne. */
const MAX_REASONING_CHARS = 200_000;

interface KimiChoiceMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: unknown;
}

export class KimiAdapter implements ModelProviderAdapter {
  readonly name: string = "kimi";

  constructor(
    private readonly apiKey: string | undefined = firstNonEmptyEnv("KIMI_API_KEY", "MOONSHOT_API_KEY"),
    readonly model: string = envOrDefault("JARVIS_KIMI_MODEL", "kimi-k3"),
    private readonly baseUrl: string = envOrDefault("JARVIS_KIMI_URL", "https://api.moonshot.ai"),
    private readonly timeoutMs: number = envPositiveInt("JARVIS_MODEL_TIMEOUT_MS", 60_000)
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  private buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const tools = request.tools ?? [];
    if (tools.length > KIMI_MAX_TOOLS) {
      // Moonshot tillater maks 128 funksjoner. Å kutte stille ville gitt modellen et uforutsigbart utvalg - en ærlig feil lar gatewayen gå til neste kandidat.
      throw new ProviderError(this.name, "bad_request", `${this.name}_too_many_tools`);
    }
    const messages: Array<Record<string, unknown>> = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: textOnly(m.content) })),
      ...openAiToolReplayMessages(request.tool_exchanges, { provider: this.name, emptyAssistantContent: "" })
    ];
    return {
      model: this.model,
      messages,
      max_tokens: request.max_tokens ?? 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(tools.length > 0 ? { tools: toOpenAiToolDefinitions(tools) } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
  }

  private async post(request: ModelRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const body = JSON.stringify(this.buildBody(request, stream));
    const url = `${this.baseUrl}/v1/chat/completions`;
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs);
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body
      });
    } catch (err) {
      if (signal?.aborted) throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      // D-106 HOST-FIX (Defekt B): trygg, begrenset feilsøkings-metadata - ALDRI
      // nøkkelen (den sendes i Authorization-header, aldri i URL-en/body over).
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
        request_operation: "chat.completions"
      });
    }
    return response;
  }

  /** Resonneringen bæres videre kun når den faktisk hører til en runde med verktøykall, og aldri over minnegrensen. */
  private stateFor(reasoning: string | null | undefined, hasToolCalls: boolean): ToolCallRequest["provider_state"] | undefined {
    if (!hasToolCalls || typeof reasoning !== "string" || reasoning.length === 0 || reasoning.length > MAX_REASONING_CHARS) return undefined;
    return { reasoning_content: reasoning };
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, false);
    let body: {
      choices: Array<{ message: KimiChoiceMessage; finish_reason?: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    try {
      body = (await response.json()) as typeof body;
      if (!Array.isArray(body.choices) || !body.usage) {
        throw new Error("mangler choices/usage");
      }
    } catch {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_response`);
    }
    const message = body.choices[0]?.message;
    const text = message?.content ?? "";
    const hasToolCalls = Array.isArray(message?.tool_calls) && (message?.tool_calls as unknown[]).length > 0;
    const toolCalls = normalizeToolCalls(this.name, this.model, message?.tool_calls, this.stateFor(message?.reasoning_content, hasToolCalls));
    if (text) onToken?.(text);
    return {
      text,
      usage: { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.choices[0]?.finish_reason ? { finish_reason: body.choices[0].finish_reason } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
  }

  /**
   * JARVIS-036: ekte SSE-strømming (OpenAI-kompatibel). Samme event-kontrakt som `OpenAiAdapter.stream()`. En strøm uten `finish_reason` OG uten `[DONE]` er AVBRUTT (stream_interrupted), ikke et komplett
   * svar (JARVIS-038). Verktøykall valideres først når hele strømmen er mottatt, og `reasoning_content` slippes aldri ut som tekst.
   */
  async stream(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, true, signal);
    if (!response.body) {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_no_stream_body`);
    }
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: `gen-${randomUUID().slice(0, 12)}` });
    const assembler = new ToolCallStreamAssembler(this.name, this.model, onEvent);
    let text = "";
    let reasoning = "";
    let ttft: number | undefined;
    let finish = "";
    let sawDone = false;
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    try {
      for await (const data of sseLines(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: {
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCallDelta[] };
            finish_reason?: string | null;
            usage?: { prompt_tokens: number; completion_tokens: number } | null;
          }>;
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.reasoning_content === "string" && reasoning.length <= MAX_REASONING_CHARS) reasoning += delta.reasoning_content;
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          if (ttft === undefined) ttft = Date.now() - started;
          text += delta.content;
          onEvent({ type: "text_delta", text: delta.content });
        }
        if (assembler.push(delta?.tool_calls) && ttft === undefined) ttft = Date.now() - started;
        if (choice?.finish_reason) finish = choice.finish_reason;
        const reported = chunk.usage ?? choice?.usage;
        if (reported) usage = { input_tokens: reported.prompt_tokens, output_tokens: reported.completion_tokens };
      }
    } catch (err) {
      if (signal?.aborted) {
        onEvent({ type: "cancelled" });
        throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, "stream_interrupted", `${this.name}_stream_interrupted: ${(err as Error).message.slice(0, 80)}`);
    }
    if (signal?.aborted) {
      onEvent({ type: "cancelled" });
      throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
    }
    if (!finish && !sawDone) {
      throw new ProviderError(this.name, "stream_interrupted", `${this.name}_stream_ended_without_finish`);
    }
    // Komplette tool calls valideres/parses FØRST når hele payload er mottatt (§24); ugyldig → invalid_tool_call, ingen tool_call_complete.
    const toolCalls = assembler.complete(this.stateFor(reasoning, true));
    const finalUsage = usage ?? { input_tokens: 0, output_tokens: 0 };
    onEvent({ type: "usage", usage: finalUsage });
    onEvent({ type: "finish", finish_reason: finish || "stop" });
    return {
      text,
      usage: finalUsage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
      finish_reason: finish || "stop",
      // Ærlig: manglet statistikk-chunken helt, er tokentallene 0 fordi de er ukjente (ikke fordi kallet var gratis).
      ...(usage === undefined ? { metadata: { usage_missing: true } } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
  }
}
