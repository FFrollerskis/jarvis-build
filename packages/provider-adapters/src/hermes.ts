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
