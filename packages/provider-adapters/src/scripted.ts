import type { ModelProviderAdapter, ModelRequest, ModelResult } from "./types.ts";

/**
 * Deterministisk testadapter: svarer fra et skript, ingen nettverk.
 * Brukes i tester og som trygg standard når ingen leverandør er konfigurert.
 */
export class ScriptedAdapter implements ModelProviderAdapter {
  readonly name = "scripted";
  calls: ModelRequest[] = [];

  constructor(private readonly reply: (request: ModelRequest) => string = () => "OK (skriptet svar)") {}

  available(): boolean {
    return true;
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    this.calls.push(request);
    const text = this.reply(request);
    for (const token of text.split(/(?<=\s)/)) {
      onToken?.(token);
    }
    return {
      text,
      usage: { input_tokens: 100, output_tokens: 50 },
      provider: this.name,
      model: "scripted-1"
    };
  }
}

/** Adapter som alltid feiler - for fallback-tester. */
export class FailingAdapter implements ModelProviderAdapter {
  readonly name = "failing";
  available(): boolean {
    return true;
  }
  async complete(): Promise<ModelResult> {
    throw new Error("provider_unavailable");
  }
}
