import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/**
 * Anthropic Messages API-adapter. Structured output tilbys ikke som capability
 * i registry (ingen fake feature parity, BO-08 §22); tool-use-basert struktur
 * kan komme senere med egen beslutning. Nøkkel fra miljø/vault - aldri kode.
 */
export class AnthropicAdapter implements ModelProviderAdapter {
  readonly name: string = "anthropic";

  constructor(
    private readonly apiKey: string | undefined = process.env["ANTHROPIC_API_KEY"],
    readonly model: string = process.env["JARVIS_ANTHROPIC_MODEL"] ?? "claude-sonnet-5",
    private readonly baseUrl: string = "https://api.anthropic.com",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 60_000)
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.max_tokens ?? 1024,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages
        })
      });
    } catch (err) {
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      throw classifyHttpStatus(this.name, response.status);
    }
    let body: {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      stop_reason?: string;
    };
    try {
      body = (await response.json()) as typeof body;
      if (!Array.isArray(body.content) || !body.usage) {
        throw new Error("mangler content/usage");
      }
    } catch {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_response`);
    }
    const text = body.content.map((c) => c.text ?? "").join("");
    onToken?.(text);
    return {
      text,
      usage: {
        input_tokens: body.usage.input_tokens,
        output_tokens: body.usage.output_tokens,
        ...(body.usage.cache_read_input_tokens !== undefined
          ? { cached_tokens: body.usage.cache_read_input_tokens }
          : {})
      },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.stop_reason ? { finish_reason: body.stop_reason } : {}),
      ...(response.headers.get("request-id") ? { provider_request_id: response.headers.get("request-id") as string } : {})
    };
  }
}
