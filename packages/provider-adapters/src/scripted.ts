import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type StreamHandler, type ToolCallRequest } from "./types.ts";

/**
 * Deterministisk testadapter: svarer fra et skript, ingen nettverk.
 * Brukes i tester og som trygg standard når ingen leverandør er konfigurert.
 * UA-1 P1A: kan også skripte tool calls og streame deterministisk.
 */
export class ScriptedAdapter implements ModelProviderAdapter {
  readonly name: string = "scripted";
  readonly model: string = "scripted-1";
  calls: ModelRequest[] = [];

  constructor(
    private readonly reply: (request: ModelRequest) => string = () => "OK (skriptet svar)",
    /** Returner tool calls for en gitt request (f.eks. første runde) - tom = ferdig svar. */
    private readonly toolScript?: (request: ModelRequest) => ToolCallRequest[]
  ) {}

  available(): boolean {
    return true;
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    this.calls.push(request);
    const toolCalls = this.toolScript?.(request) ?? [];
    if (toolCalls.length > 0) {
      return {
        text: "",
        usage: { input_tokens: 100, output_tokens: 10 },
        provider: this.name,
        model: this.model,
        finish_reason: "tool_calls",
        tool_calls: toolCalls
      };
    }
    const text = this.reply(request);
    for (const token of text.split(/(?<=\s)/)) {
      onToken?.(token);
    }
    return {
      text,
      usage: { input_tokens: 100, output_tokens: 50 },
      provider: this.name,
      model: this.model,
      finish_reason: "stop"
    };
  }

  async stream(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    this.calls.push(request);
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: "gen-scripted" });
    const toolCalls = this.toolScript?.(request) ?? [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        onEvent({ type: "tool_call_start", tool_call_id: call.tool_call_id, tool_name: call.tool_name });
        onEvent({ type: "tool_call_delta", tool_call_id: call.tool_call_id, arguments_delta: JSON.stringify(call.arguments) });
        onEvent({ type: "tool_call_complete", call });
      }
      const usage = { input_tokens: 100, output_tokens: 10 };
      onEvent({ type: "usage", usage });
      onEvent({ type: "finish", finish_reason: "tool_calls" });
      return { text: "", usage, provider: this.name, model: this.model, finish_reason: "tool_calls", tool_calls: toolCalls, ttft_ms: 1 };
    }
    const text = this.reply(request);
    let ttft: number | undefined;
    for (const token of text.split(/(?<=\s)/)) {
      if (signal?.aborted) {
        onEvent({ type: "cancelled" });
        throw new ProviderError(this.name, "cancelled", "scripted_cancelled");
      }
      if (ttft === undefined) ttft = 1;
      onEvent({ type: "text_delta", text: token });
      await new Promise((r) => setTimeout(r, 1));
    }
    const usage = { input_tokens: 100, output_tokens: 50 };
    onEvent({ type: "usage", usage });
    onEvent({ type: "finish", finish_reason: "stop" });
    return { text, usage, provider: this.name, model: this.model, finish_reason: "stop", ...(ttft !== undefined ? { ttft_ms: ttft } : {}) };
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
