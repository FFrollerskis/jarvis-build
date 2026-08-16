import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  sseLines,
  type ChatMessage,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest
} from "./types.ts";

/**
 * UA-2 P1B-A (D-43 §3): eneste adapter med EKTE bildestøtte i denne runden
 * (`capability-registry.ts` sitt `vision`-flagg reflekterer dette - router
 * sender derfor ALDRI et vision-krevd kall hit til andre adaptere). Anthropic
 * sitt Messages API tar imot `{type:"image", source:{type:"base64",
 * media_type, data}}`-blokker i samme `content`-array som tekstblokker -
 * bekreftet mot Anthropic sin offisielle Messages API-dokumentasjon.
 */
function toAnthropicContent(content: ChatMessage["content"]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.media_type, data: part.data } }
  );
}

/**
 * Anthropic Messages API-adapter (UA-1 P1A: tekst, tool use og streaming gjennom
 * samme normaliserte kontrakt som OpenAI). Nøkkel fra miljø/vault - aldri kode.
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

  /** Provider-nøytral request → Anthropic-format (tool_use/tool_result-blokker). */
  private buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = request.messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
    for (const ex of request.tool_exchanges ?? []) {
      messages.push({
        role: "assistant",
        content: ex.calls.map((c) => ({ type: "tool_use", id: c.tool_call_id, name: c.tool_name, input: c.arguments }))
      });
      messages.push({
        role: "user",
        content: ex.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_call_id,
          content: JSON.stringify(r.output ?? r.error_category ?? null),
          ...(r.success ? {} : { is_error: true })
        }))
      });
    }
    return {
      model: this.model,
      max_tokens: request.max_tokens ?? 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.system ? { system: request.system } : {}),
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }
        : {}),
      messages,
      ...(stream ? { stream: true } : {})
    };
  }

  private async post(request: ModelRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01"
        },
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

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    const started = Date.now();
    const response = await this.post(request, false);
    let body: {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
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
    const text = body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (text) onToken?.(text);
    const toolCalls: ToolCallRequest[] = body.content
      .filter((c) => c.type === "tool_use")
      .map((c) => ({
        tool_call_id: c.id ?? `call-${randomUUID().slice(0, 8)}`,
        tool_name: c.name ?? "",
        arguments: c.input ?? {},
        provider: this.name,
        model: this.model
      }));
    return {
      text,
      usage: {
        input_tokens: body.usage.input_tokens,
        output_tokens: body.usage.output_tokens,
        ...(body.usage.cache_read_input_tokens !== undefined ? { cached_tokens: body.usage.cache_read_input_tokens } : {})
      },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.stop_reason ? { finish_reason: body.stop_reason } : {}),
      ...(response.headers.get("request-id") ? { provider_request_id: response.headers.get("request-id") as string } : {}),
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
    let inputTokens = 0;
    let outputTokens = 0;
    // Anthropic streamer blokk-indeksert: index → påbegynt tool_use-blokk.
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
    const completedCalls: ToolCallRequest[] = [];
    try {
      for await (const data of sseLines(response.body)) {
        let event: {
          type: string;
          index?: number;
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          content_block?: { type: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        try {
          event = JSON.parse(data) as typeof event;
        } catch {
          continue;
        }
        switch (event.type) {
          case "message_start":
            inputTokens = event.message?.usage?.input_tokens ?? 0;
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use" && event.index !== undefined) {
              const id = event.content_block.id ?? `call-${randomUUID().slice(0, 8)}`;
              const name = event.content_block.name ?? "";
              pendingTools.set(event.index, { id, name, json: "" });
              if (ttft === undefined) ttft = Date.now() - started;
              onEvent({ type: "tool_call_start", tool_call_id: id, tool_name: name });
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && event.delta.text) {
              if (ttft === undefined) ttft = Date.now() - started;
              text += event.delta.text;
              onEvent({ type: "text_delta", text: event.delta.text });
            } else if (event.delta?.type === "input_json_delta" && event.index !== undefined) {
              const pending = pendingTools.get(event.index);
              if (pending && event.delta.partial_json !== undefined) {
                pending.json += event.delta.partial_json;
                onEvent({ type: "tool_call_delta", tool_call_id: pending.id, arguments_delta: event.delta.partial_json });
              }
            }
            break;
          case "content_block_stop":
            if (event.index !== undefined && pendingTools.has(event.index)) {
              const pending = pendingTools.get(event.index) as { id: string; name: string; json: string };
              let args: Record<string, unknown>;
              try {
                args = pending.json.trim() === "" ? {} : (JSON.parse(pending.json) as Record<string, unknown>);
              } catch {
                throw new ProviderError(this.name, "invalid_tool_call", `${this.name}_invalid_tool_arguments`);
              }
              const call: ToolCallRequest = {
                tool_call_id: pending.id, tool_name: pending.name, arguments: args, provider: this.name, model: this.model
              };
              completedCalls.push(call);
              onEvent({ type: "tool_call_complete", call });
              pendingTools.delete(event.index);
            }
            break;
          case "message_delta":
            if (event.delta?.stop_reason) finish = event.delta.stop_reason;
            if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
            break;
          case "error": {
            // BO-11.1 §12-funn: error-events i streamen skal ALDRI bli stille
            // suksess - de klassifiseres som normaliserte provider-feil (§33).
            const errType = event.error?.type ?? "unknown";
            if (errType === "rate_limit_error") {
              throw new ProviderError(this.name, "rate_limit", `${this.name}_rate_limited_in_stream`);
            }
            throw new ProviderError(this.name, "server", `${this.name}_stream_error:${errType}`);
          }
          default:
            break;
        }
      }
    } catch (err) {
      // Allerede klassifiserte feil (invalid_tool_call, error-events → server/rate_limit)
      // beholder klassifiseringen - den styrer router/health/fallback deterministisk.
      if (err instanceof ProviderError) throw err;
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
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
    onEvent({ type: "usage", usage });
    onEvent({ type: "finish", finish_reason: finish || "end_turn" });
    return {
      text,
      usage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
      finish_reason: finish || "end_turn",
      ...(completedCalls.length > 0 ? { tool_calls: completedCalls } : {})
    };
  }
}
