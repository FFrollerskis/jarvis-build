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
  type ModelResult
} from "./types.ts";

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
 */
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

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: textOnly(m.content) }))
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
    let body: {
      choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
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
    const text = body.choices[0]?.message.content ?? "";
    onToken?.(text);
    return {
      text,
      usage: { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.choices[0]?.finish_reason ? { finish_reason: body.choices[0].finish_reason } : {})
    };
  }
}
