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
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type ToolCallRequest
} from "./types.ts";
import { HermesToolParseError, hermesToolReplayMessages, parseHermesOutput, renderHermesToolsSystemBlock } from "./hermes-tools.ts";
import { normalizeToolCalls, normalizeUsage } from "./openai-compat-tools.ts";

/**
 * Hermes (NousResearch)-adapter. Tobias direkte i chat (D-360): "Hermes
 * LLM-modellfamilie (NousResearch)" - en ny ModelGateway-leverandør bak
 * samme adapter-mønster som alle andre (CLAUDE.md regel 3), IKKE Hermes
 * Agent (NousResearch sin egen CLI/agent-rammeverk - et annet produkt med
 * samme navn, ALDRI adoptert her, se D-359 for hvorfor en tredjeparts
 * agent-/minne-rammeverk ikke blir Jarvis sin kjerne).
 *
 * Nous eksponerer modellene via et OpenAI-kompatibelt `/v1/chat/completions`
 * på `https://inference-api.nousresearch.com` (verifisert mot BÅDE Nous sin
 * egen `hermes-agent`-repo-dokumentasjon på GitHub OG uavhengige
 * tredjeparts-prisoversikter - to uavhengige kilder, se D-360). Modell-ID-en
 * `"Hermes-4-70B"` er sitert ORDRETT i Nous sin egen dokumentasjon (samme
 * streng brukt for både 70B- og 405B-variantene der, ingen leverandør-
 * navnerom-prefiks slik aggregatorer som OpenRouter bruker).
 *
 * D-41-forbehold (samme disiplin som Kimi/D-106): nøkkelformatet
 * `sk-nous-...` er bekreftet fra Nous sin egen dokumentasjon, men denne
 * økten har INGEN ekte Nous-konto/nøkkel og ingen nettverkstilgang til
 * `inference-api.nousresearch.com` i sandkassen for å faktisk ringe
 * endepunktet - standard `Authorization: Bearer <key>` er derfor det
 * STANDARDISERTE OpenAI-kompatible mønsteret denne adapteren bruker (samme
 * som enhver annen adapter i denne pakken), IKKE en live-bekreftet
 * header-form for akkurat dette endepunktet. `HERMES_LIVE_GATE=
 * PENDING_CREDENTIALS` - FIXED_SUITE_VERIFIED, ALDRI LIVE_VERIFIED før
 * Tobias limmer inn en ekte Nous Portal-nøkkel og en host-kjøring bekrefter
 * et faktisk svar.
 *
 * JARVIS-036 (WP-D4): VERKTØYKALL via Hermes' eget prompt-protokoll (`<tools>`/`<tool_call>`/`<tool_response>`), se `hermes-tools.ts` for format, streng parser og injeksjonsvern. `tools`-feltet
 * sendes ALDRI (hosted støtte er udokumentert/motstridende), så adapteren virker likt mot Nous' API og en selvhostet vLLM/SGLang. Ugyldig/ukjent verktøykall → `invalid_tool_call`, aldri utføring.
 * Hvis serveren likevel selv leverer `message.tool_calls` (den kan oversette taggene), brukes de på samme strenge måte (kun tilbudte verktøy), så et kall aldri forsvinner stille - men
 * tagger OG `tool_calls` i samme svar er tvetydig og avvises. STREAMING er BEVISST ikke bygget for Hermes (taggene måtte filtreres ut av en løpende strøm; registeret påstår derfor ikke `streaming`):
 * `ModelGateway.stream()` velger ikke Hermes, mens bakgrunnsløkker (`complete()`) kan.
 */
export class HermesAdapter implements ModelProviderAdapter {
  readonly name: string = "hermes";

  constructor(
    private readonly apiKey: string | undefined = firstNonEmptyEnv("HERMES_API_KEY", "NOUS_API_KEY"),
    readonly model: string = envOrDefault("JARVIS_HERMES_MODEL", "Hermes-4-70B"),
    private readonly baseUrl: string = envOrDefault("JARVIS_HERMES_URL", "https://inference-api.nousresearch.com"),
    private readonly timeoutMs: number = envPositiveInt("JARVIS_MODEL_TIMEOUT_MS", 60_000)
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const tools = request.tools ?? [];
    // Protokollblokken legges ETTER Jarvis' egen systemprompt, og kun når verktøy er tilbudt i denne forespørselen.
    const system = [request.system, tools.length > 0 ? renderHermesToolsSystemBlock(tools) : undefined]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n\n");
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: textOnly(m.content) })),
      ...hermesToolReplayMessages(request.tool_exchanges)
    ];
    const started = Date.now();
    const url = `${this.baseUrl}/v1/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: request.max_tokens ?? 1024,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
        })
      });
    } catch (err) {
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      // Trygg, begrenset feilsøkings-metadata - ALDRI nøkkelen (den sendes
      // kun i Authorization-headeren, aldri i URL-en/body over).
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
    let body: {
      choices: Array<{ message: { content: string | null; tool_calls?: unknown }; finish_reason?: string }>;
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
    const parsed = this.parseOutput(message?.content ?? "", message?.tool_calls, tools);
    if (parsed.text) onToken?.(parsed.text);
    const finish = body.choices[0]?.finish_reason;
    // L10: tokentall valideres (endelige heltall >= 0) før de når kostberegningen; ugyldige felt blir 0 og svaret merkes, aldri en streng/NaN.
    const normalized = normalizeUsage(body.usage);
    const metadata = {
      ...(parsed.ignored_blocks > 0 ? { tool_blocks_ignored: parsed.ignored_blocks } : {}),
      ...(normalized.problems.length > 0 ? { usage_missing: true, usage_invalid: true, usage_problems: normalized.problems } : {})
    };
    return {
      text: parsed.text,
      usage: normalized.usage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(parsed.calls.length > 0 ? { finish_reason: "tool_calls" } : finish ? { finish_reason: finish } : {}),
      ...(parsed.calls.length > 0 ? { tool_calls: parsed.calls } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {})
    };
  }

  /** Svartekst (+ eventuelle serveroversatte `tool_calls`) → synlig tekst og normaliserte kall, eller `invalid_tool_call` (aldri et delvis resultat). */
  private parseOutput(
    content: string,
    nativeToolCalls: unknown,
    tools: NonNullable<ModelRequest["tools"]>
  ): { text: string; calls: ToolCallRequest[]; ignored_blocks: number } {
    let tagged: ReturnType<typeof parseHermesOutput>;
    try {
      tagged = parseHermesOutput(content, tools);
    } catch (err) {
      if (err instanceof HermesToolParseError) throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_call:${err.code}`);
      throw err;
    }
    const native = Array.isArray(nativeToolCalls) && nativeToolCalls.length > 0 ? normalizeToolCalls(this.name, this.model, nativeToolCalls) : [];
    if (native.length > 0 && (tagged.calls.length > 0 || tagged.ignored_blocks > 0)) {
      throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_call:ambiguous_call_formats`);
    }
    if (native.length > 0) {
      const known = new Set(tools.map((t) => t.name));
      if (tools.length === 0 || native.some((c) => !known.has(c.tool_name))) {
        throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_call:unknown_tool`);
      }
      return { text: tagged.text, calls: native, ignored_blocks: 0 };
    }
    return {
      text: tagged.text,
      calls: tagged.calls.map((c) => ({
        tool_call_id: `call-${randomUUID().slice(0, 8)}`,
        tool_name: c.name,
        arguments: c.arguments,
        provider: this.name,
        model: this.model
      })),
      ignored_blocks: tagged.ignored_blocks
    };
  }
}
