import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/** OpenAI Chat Completions-adapter (UA-1 baseline). Nøkkel fra miljø/vault - aldri kode. */
export class OpenAiAdapter implements ModelProviderAdapter {
  readonly name: string = "openai";

  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    readonly model: string = process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-5",
    private readonly baseUrl: string = "https://api.openai.com",
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
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.structured_schema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "result", strict: true, schema: request.structured_schema }
                }
              }
            : {})
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
      usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } };
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
    const cached = body.usage.prompt_tokens_details?.cached_tokens;
    let structured: unknown;
    if (request.structured_schema && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_structured_output`);
      }
    }
    return {
      text,
      usage: {
        input_tokens: body.usage.prompt_tokens,
        output_tokens: body.usage.completion_tokens,
        ...(cached !== undefined ? { cached_tokens: cached } : {})
      },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.choices[0]?.finish_reason ? { finish_reason: body.choices[0].finish_reason } : {}),
      ...(response.headers.get("x-request-id") ? { provider_request_id: response.headers.get("x-request-id") as string } : {}),
      ...(structured !== undefined ? { structured_output: structured } : {})
    };
  }
}
