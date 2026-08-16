import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  sseLines,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest
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

  /** Provider-nøytral request → OpenAI-format (meldinger, tools, tidligere tool-runder). */
  private buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: textOnly(m.content) }))
    ];
    for (const ex of request.tool_exchanges ?? []) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: ex.calls.map((c) => ({
          id: c.tool_call_id,
          type: "function",
          function: { name: c.tool_name, arguments: JSON.stringify(c.arguments) }
        }))
      });
      for (const r of ex.results) {
        messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: JSON.stringify(r.output ?? r.error_category ?? null) });
      }
    }
    return {
      model: this.model,
      messages,
      // gpt-5/o-serien avviser legacy max_tokens; max_completion_tokens gjelder alle chat-modeller.
      max_completion_tokens: request.max_tokens ?? 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input_schema }
            }))
          }
        : {}),
      ...(request.structured_schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "result", strict: true, schema: request.structured_schema }
            }
          }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
  }

  private async post(request: ModelRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify(this.buildBody(request, stream))
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      }
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      throw classifyHttpStatus(this.name, response.status);
    }
    return response;
  }

  private parseToolCall(id: string | undefined, name: string | undefined, args: string): ToolCallRequest {
    let parsed: Record<string, unknown>;
    try {
      parsed = args.trim() === "" ? {} : (JSON.parse(args) as Record<string, unknown>);
    } catch {
      throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_arguments`);
    }
    return {
      tool_call_id: id ?? `call-${randomUUID().slice(0, 8)}`,
      tool_name: name ?? "",
      arguments: parsed,
      provider: this.name,
      model: this.model
    };
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, false);
    let body: {
      choices: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason?: string;
      }>;
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
    const message = body.choices[0]?.message;
    const text = message?.content ?? "";
    if (text) onToken?.(text);
    const toolCalls = (message?.tool_calls ?? []).map((c) => this.parseToolCall(c.id, c.function.name, c.function.arguments));
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
      ...(structured !== undefined ? { structured_output: structured } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
  }

  async stream(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, true, signal);
    if (!response.body) {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_no_stream_body`);
    }
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: `gen-${randomUUID().slice(0, 12)}` });
    let text = "";
    let ttft: number | undefined;
    let finish = "";
    let usage = { input_tokens: 0, output_tokens: 0 };
    const pendingTools = new Map<number, { id?: string; name?: string; args: string }>();
    const completedCalls: ToolCallRequest[] = [];
    try {
      for await (const data of sseLines(response.body)) {
        if (data === "[DONE]") break;
        let chunk: {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          if (ttft === undefined) ttft = Date.now() - started;
          text += delta.content;
          onEvent({ type: "text_delta", text: delta.content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          let pending = pendingTools.get(tc.index);
          if (!pending) {
            pending = { args: "" };
            pendingTools.set(tc.index, pending);
            if (ttft === undefined) ttft = Date.now() - started;
          }
          if (tc.id) pending.id = tc.id;
          if (tc.function?.name) {
            pending.name = (pending.name ?? "") + tc.function.name;
            onEvent({ type: "tool_call_start", tool_call_id: pending.id ?? `idx-${tc.index}`, tool_name: pending.name });
          }
          if (tc.function?.arguments) {
            pending.args += tc.function.arguments;
            onEvent({ type: "tool_call_delta", tool_call_id: pending.id ?? `idx-${tc.index}`, arguments_delta: tc.function.arguments });
          }
        }
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens };
      }
    } catch (err) {
      if (signal?.aborted) {
        onEvent({ type: "cancelled" });
        throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      }
      throw new ProviderError(this.name, "stream_interrupted", `${this.name}_stream_interrupted: ${(err as Error).message.slice(0, 80)}`);
    }
    if (signal?.aborted) {
      onEvent({ type: "cancelled" });
      throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
    }
    // Komplette tool calls valideres/parses FØRST når hele payload er mottatt (§24).
    for (const pending of pendingTools.values()) {
      const call = this.parseToolCall(pending.id, pending.name, pending.args);
      completedCalls.push(call);
      onEvent({ type: "tool_call_complete", call });
    }
    onEvent({ type: "usage", usage });
    onEvent({ type: "finish", finish_reason: finish || "stop" });
    return {
      text,
      usage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
      finish_reason: finish || "stop",
      ...(completedCalls.length > 0 ? { tool_calls: completedCalls } : {})
    };
  }
}
