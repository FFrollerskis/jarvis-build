import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult
} from "./types.ts";

/**
 * Google Gemini-adapter (generateContent). Nøkkel sendes i header (x-goog-api-key),
 * ALDRI i URL-query (SECURITY_MODEL: ingen secrets i URL-er/logger).
 */
export class GeminiAdapter implements ModelProviderAdapter {
  readonly name: string = "gemini";

  constructor(
    private readonly apiKey: string | undefined = process.env["GEMINI_API_KEY"],
    readonly model: string = process.env["JARVIS_GEMINI_MODEL"] ?? "gemini-2.5-flash",
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 60_000)
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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          contents,
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
