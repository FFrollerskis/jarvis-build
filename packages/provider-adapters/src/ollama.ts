import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/** Lokal modell via Ollama-kompatibelt API (kjører på dev-PC/AI-server, D-20/D-23). */
export class OllamaAdapter implements ModelProviderAdapter {
  readonly name: string = "ollama";

  constructor(
    private readonly baseUrl: string | undefined = process.env["JARVIS_OLLAMA_URL"],
    readonly model: string = process.env["JARVIS_OLLAMA_MODEL"] ?? "llama3.1",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 120_000)
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.baseUrl) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          ...(request.structured_schema ? { format: request.structured_schema } : {}),
          options: {
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.max_tokens !== undefined ? { num_predict: request.max_tokens } : {})
          },
          messages: [
            ...(request.system ? [{ role: "system", content: request.system }] : []),
            ...request.messages
          ]
        })
      });
    } catch (err) {
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      throw classifyHttpStatus(this.name, response.status);
    }
    let body: {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };
    try {
      body = (await response.json()) as typeof body;
      if (!body.message) {
        throw new Error("mangler message");
      }
    } catch {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_response`);
    }
    const text = body.message.content ?? "";
    onToken?.(text);
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
      usage: { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0 },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.done_reason ? { finish_reason: body.done_reason } : {}),
      ...(structured !== undefined ? { structured_output: structured } : {})
    };
  }
}
