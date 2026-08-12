import type { ModelProviderAdapter, ModelRequest, ModelResult } from "./types.ts";

/**
 * Anthropic Messages API-adapter (ikke-streamende i fase 3; token-streaming
 * mot klient håndteres per i dag av at hele svaret leveres som ett token).
 * Nøkkel kommer fra miljø/SOPS - aldri fra kode. Uverifisert uten reell nøkkel.
 */
export class AnthropicAdapter implements ModelProviderAdapter {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string | undefined = process.env["ANTHROPIC_API_KEY"],
    private readonly model: string = process.env["JARVIS_ANTHROPIC_MODEL"] ?? "claude-sonnet-5",
    private readonly baseUrl: string = "https://api.anthropic.com"
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.apiKey) {
      throw new Error("anthropic_not_configured");
    }
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.max_tokens ?? 1024,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages
      })
    });
    if (!response.ok) {
      throw new Error(`anthropic_error_${response.status}`);
    }
    const body = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };
    const text = body.content.map((c) => c.text ?? "").join("");
    onToken?.(text);
    return { text, usage: body.usage, provider: this.name, model: this.model };
  }
}
