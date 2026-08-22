import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type ToolCallRequest
} from "./types.ts";

/**
 * D-79 (AI Mesh Gemma-first kost-/personvernarkitektur §6): provider-nøytral
 * lokal-inferens-adapter mot et OpenAI-kompatibelt chat/completions-endepunkt
 * (llama.cpp sin innebygde `server`, Ollama sin OpenAI-kompatible rute, vLLM,
 * LM Studio, osv. - IKKE Ollamas native `/api/chat`-format, det dekkes
 * allerede av `OllamaAdapter`). Dette er en NY, separat adapter - IKKE en
 * endring av `OllamaAdapter` - fordi den skal representere "et vilkårlig
 * OpenAI-kompatibelt lokalt endepunkt", ikke spesifikt Ollama.
 *
 * INGEN hardkodet IP/host - `LOCAL_LLM_BASE_URL` MÅ settes eksplisitt (samme
 * "ingen default-URL"-konvensjon som `OllamaAdapter`), og INGEN antakelse om
 * at inferensen kjører på samme maskin som Jarvis (§6: modellen kan senere
 * kjøre på en dedikert GPU-server - adapteren er ren HTTP-klient, ingen
 * lokal-maskin-spesifikk logikk noe sted).
 *
 * `locality: "local"` i capability-registryet (ikke i denne filen - se
 * `capability-registry.ts`), `hosted_free_tier: false` (dette er ALDRI et
 * sky-gratis-tier-spørsmål - lokal inferens er en helt annen
 * personvern-kategori, se D-79 §3).
 *
 * Streaming: IKKE implementert i denne runden (samme bevisste avgrensning
 * som `GemmaHostedAdapter` - `stream:false` alltid sendt, matcher
 * `OllamaAdapter`-presedens). Tool calling: EKTE (samme
 * `tools`/`tool_calls`-skjema som `OpenAiAdapter`, siden OpenAI-kompatible
 * lokale servere normalt implementerer akkurat dette skjemaet) - modellen
 * utfører ALDRI verktøy selv, samme `ToolGateway`/`PolicyGateway`-kjede som
 * alle andre providere (§12).
 *
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): `name` er nå
 * konstruktør-injiserbar (default uendret `"local_llm"`) slik at DENNE SAMME,
 * allerede testede HTTP-klienten kan registreres en gang til under en
 * distinkt provider-identitet (`"gemma_local"`) for et Gemma-modell servert
 * lokalt via et OpenAI-kompatibelt endepunkt (f.eks. Ollamas OpenAI-
 * kompatible rute, llama.cpp, LM Studio) - se `capability-registry.ts` sin
 * `gemma_local`-profil. INGEN ny adapterklasse, INGEN duplisert HTTP-logikk -
 * kun en ny navngitt registrering, samme mønster som `gemma_hosted` gjenbruker
 * `gemini.ts` sin API-flate under en egen identitet.
 */
export class LocalOpenAiCompatibleAdapter implements ModelProviderAdapter {
  readonly name: string;

  constructor(
    private readonly baseUrl: string | undefined = process.env["LOCAL_LLM_BASE_URL"],
    readonly model: string = process.env["LOCAL_LLM_MODEL"] ?? "local-model",
    private readonly timeoutMs: number = Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 120_000),
    name: string = "local_llm"
  ) {
    this.name = name;
  }

  available(): boolean {
    return Boolean(this.baseUrl);
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
    if (!this.baseUrl) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
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
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages,
          max_tokens: request.max_tokens ?? 1024,
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
            ? { response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: request.structured_schema } } }
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
      choices: Array<{
        message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    try {
      body = (await response.json()) as typeof body;
      if (!Array.isArray(body.choices)) {
        throw new Error("mangler choices");
      }
    } catch {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_response`);
    }
    const message = body.choices[0]?.message;
    const text = message?.content ?? "";
    if (text) onToken?.(text);
    const toolCalls = (message?.tool_calls ?? []).map((c) => this.parseToolCall(c.id, c.function.name, c.function.arguments));
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
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0
      },
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(body.choices[0]?.finish_reason ? { finish_reason: body.choices[0].finish_reason } : {}),
      ...(structured !== undefined ? { structured_output: structured } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    };
  }
}
