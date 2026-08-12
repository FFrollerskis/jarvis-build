import type { ModelProviderAdapter, ModelRequest, ModelResult } from "./types.ts";

/** OpenAI Chat Completions-adapter. Nøkkel fra miljø/SOPS. Uverifisert uten reell nøkkel. */
export class OpenAiAdapter implements ModelProviderAdapter {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = process.env["JARVIS_OPENAI_MODEL"] ?? "gpt-5",
    private readonly baseUrl: string = "https://api.openai.com"
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new Error("openai_not_configured");
    }
    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages
    ];
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, max_tokens: request.max_tokens ?? 1024 })
    });
    if (!response.ok) {
      throw new Error(`openai_error_${response.status}`);
    }
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const text = body.choices[0]?.message.content ?? "";
    onToken?.(text);
    return {
      text,
      usage: { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens },
      provider: this.name,
      model: this.model
    };
  }
}
