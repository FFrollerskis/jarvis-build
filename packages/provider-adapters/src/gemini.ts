import {
  classifyFetchError,
  classifyHttpStatus,
  envOrDefault,
  envPositiveInt,
  extractProviderErrorCode,
  ProviderError,
  sanitizeEndpointForDiagnostics,
  sanitizeGeminiSchema,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/**
 * Google Gemini-adapter (generateContent). Nøkkel sendes i header (x-goog-api-key),
 * ALDRI i URL-query (SECURITY_MODEL: ingen secrets i URL-er/logger).
 *
 * D-106 GEMINI MODEL MIGRATION (live-bevis, 2026-08-23): default-modellen var
 * `"gemini-2.5-flash"` - Tobias sin ekte konfigurerte nøkkel viste denne
 * FAKTISK i katalogen (`/v1beta/models`), MEN selve `generateContent`-kallet
 * svarte 404 med Google sin egen feilmelding om at modellen ikke lenger er
 * tilgjengelig for nye brukere, med eksplisitt henvisning til
 * `models/gemini-3.6-flash`. Tobias sin direkte autentiserte prøve mot
 * `gemini-3.6-flash` lyktes (`GEMINI_36_FLASH_LIVE=true`). Uavhengig
 * WebSearch (direkte `WebFetch` mot `ai.google.dev`/`deepmind.google`/
 * `blog.google` var nettverks-blokkert i denne økten - kun søke-syntesen var
 * tilgjengelig) bekreftet `gemini-3.6-flash` som en ekte, offisiell Google
 * DeepMind-modell (lansert 21. juli 2026), OG at `gemini-2.5-flash` faktisk
 * er under utfasing. Dette var derfor IKKE et gjettet modellbytte (samme
 * D-41-disiplin som `kimi-k3`-fiksen) - roten var en utdatert default, ikke
 * en adapter-/auth-/URL-defekt (uendret her).
 */
export class GeminiAdapter implements ModelProviderAdapter {
  readonly name: string = "gemini";

  constructor(
    private readonly apiKey: string | undefined = process.env["GEMINI_API_KEY"],
    readonly model: string = envOrDefault("JARVIS_GEMINI_MODEL", "gemini-3.6-flash"),
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com",
    private readonly timeoutMs: number = envPositiveInt("JARVIS_MODEL_TIMEOUT_MS", 60_000)
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const contents = request.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: textOnly(m.content) }]
    }));
    const started = Date.now();
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
        body: JSON.stringify({
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          contents,
          generationConfig: {
            maxOutputTokens: request.max_tokens ?? 1024,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            // D-341: Google sitt Schema-format for responseSchema er en
            // begrenset OpenAPI-3.0-delmengde (samme begrensning D-204 fant
            // for verktøy-parametre i gemma.ts, ALDRI tidligere anvendt her
            // eller på responseSchema noe sted) - host-bevist
            // `gemini_error_400`/`INVALID_ARGUMENT` for
            // `modules/memory/src/extraction.ts` sitt uttrekk-skjema.
            ...(request.structured_schema
              ? { responseMimeType: "application/json", responseSchema: sanitizeGeminiSchema(request.structured_schema) }
              : {})
          }
        })
      });
    } catch (err) {
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      // D-106 HOST-FIX (Defekt B): trygg, begrenset feilsøkings-metadata - ALDRI
      // nøkkelen (den sendes i header, aldri i URL-en over), ALDRI hele body.
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
        request_operation: "generateContent"
      });
    }
    let body: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
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
    const text = (body.candidates[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    onToken?.(text);
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
      ...(structured !== undefined ? { structured_output: structured } : {})
    };
  }
}
