import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/**
 * Kimi (Moonshot AI)-adapter. Masterplan v4.0 planlegger Kimi for long
 * context/reasoning (UA-1 P0-registry); Moonshot eksponerer et OpenAI-
 * kompatibelt chat/completions-API, så adapteren normaliserer det formatet.
 * Base-URL/modell er konfig (JARVIS_KIMI_URL/JARVIS_KIMI_MODEL); nøkkel fra
 * KIMI_API_KEY (fallback MOONSHOT_API_KEY). Uverifisert uten reell nøkkel.
 */
export class KimiAdapter implements ModelProviderAdapter {
  readonly name: string = "kimi";

  constructor(
    private readonly apiKey: string | undefined = process.env["KIMI_API_KEY"] ?? process.env["MOONSHOT_API_KEY"],
    readonly model: string = process.env["JARVIS_KIMI_MODEL"] ?? "kimi-latest",
    private readonly baseUrl: string = process.env["JARVIS_KIMI_URL"] ?? "https://api.moonshot.ai",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 60_000)
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
      ...request.messages
    ];
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
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
      throw classifyHttpStatus(this.name, response.status);
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
