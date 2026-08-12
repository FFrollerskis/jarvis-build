import type { ModelProviderAdapter, ModelRequest, ModelResult } from "./types.ts";

/** Lokal modell via Ollama-kompatibelt API (kjører på dev-PC/AI-server, D-20/D-23). */
export class OllamaAdapter implements ModelProviderAdapter {
  readonly name = "ollama";

  constructor(
    private readonly baseUrl: string | undefined = process.env["JARVIS_OLLAMA_URL"],
    private readonly model: string = process.env["JARVIS_OLLAMA_MODEL"] ?? "llama3.1"
  ) {}

  available(): boolean {
    return Boolean(this.baseUrl);
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.baseUrl) {
      throw new Error("ollama_not_configured");
    }
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          ...request.messages
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`ollama_error_${response.status}`);
    }
    const body = (await response.json()) as {
      message: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = body.message.content;
    onToken?.(text);
    return {
      text,
      usage: { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0 },
      provider: this.name,
      model: this.model
    };
  }
}
