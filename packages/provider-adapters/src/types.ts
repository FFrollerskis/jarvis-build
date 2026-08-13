export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** UA-1 P1A: normalisert verktøydefinisjon - kommer alltid fra trusted Tool Gateway-lag. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Normalisert tool call fra modellen (provider-uavhengig; adaptere oversetter). */
export interface ToolCallRequest {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  provider: string;
  model: string;
}

/** Normalisert verktøyresultat tilbake til modellen. Aldri credentials/intern metadata. */
export interface ToolResultMessage {
  tool_call_id: string;
  tool_name: string;
  execution_id: string;
  success: boolean;
  output: unknown;
  error_category?: string;
  at: string;
}

/** Én gjennomført tool-runde (provider-nøytral) - gjør cross-provider resume mulig. */
export interface ToolExchange {
  calls: ToolCallRequest[];
  results: ToolResultMessage[];
}

export interface ModelRequest {
  system?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /** JSON Schema for strukturert output - kun providere med structured_output-capability. */
  structured_schema?: Record<string, unknown>;
  /** UA-1 P1A: tilgjengelige verktøy (fra trusted lag - modellen definerer aldri egne). */
  tools?: ToolDefinition[];
  /** Gjennomførte tool-runder som skal med i konteksten (provider-nøytralt format). */
  tool_exchanges?: ToolExchange[];
}

/** UA-1 P1A: normalisert streaming-event. Resten av Jarvis ser aldri provider-format. */
export type StreamEvent =
  | { type: "start"; provider: string; model: string; generation_id: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; tool_call_id: string; tool_name: string }
  | { type: "tool_call_delta"; tool_call_id: string; arguments_delta: string }
  | { type: "tool_call_complete"; call: ToolCallRequest }
  | { type: "usage"; usage: ModelUsage }
  | { type: "finish"; finish_reason: string }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "cancelled" }
  | { type: "error"; category: ProviderErrorKind; message: string };

export type StreamHandler = (event: StreamEvent) => void;

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  /** Kun når provider rapporterer cache-treff (f.eks. Anthropic/OpenAI). */
  cached_tokens?: number;
}

export interface ModelResult {
  text: string;
  usage: ModelUsage;
  provider: string;
  model: string;
  latency_ms?: number;
  finish_reason?: string;
  provider_request_id?: string;
  /** Parset JSON når structured_schema ble bedt om og provider leverte gyldig JSON. */
  structured_output?: unknown;
  /** Provider-spesifikke detaljer resten av Jarvis ikke skal trenge å forstå. */
  metadata?: Record<string, unknown>;
  /** UA-1 P1A: normaliserte tool calls modellen ber om (tom/udefinert = ferdig svar). */
  tool_calls?: ToolCallRequest[];
  /** Time-to-first-token ved streaming (viktig for Voice-routing senere, §8). */
  ttft_ms?: number;
}

/** Normaliserte feilklasser (UA-1): styrer retry-/fallback-policy deterministisk. */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "server"
  | "network"
  | "invalid_response"
  | "bad_request"
  | "not_configured"
  | "stream_interrupted"
  | "invalid_tool_call"
  | "cancelled";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Retry-safe mot ANNEN provider. auth/bad_request/not_configured skal aldri spamme retries. */
  get fallbackSafe(): boolean {
    return this.kind !== "not_configured" && this.kind !== "bad_request";
  }

  /** Retry-safe mot SAMME provider (transient). Avbrudd/cancel skal aldri auto-retryes. */
  get retryableSameProvider(): boolean {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server" || this.kind === "invalid_response";
  }
}

/** Felles HTTP-statusklassifisering for alle adaptere - konsistente normaliserte feil. */
export function classifyHttpStatus(provider: string, status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError(provider, "auth", `${provider}_auth_${status}`, status);
  if (status === 429) return new ProviderError(provider, "rate_limit", `${provider}_rate_limited`, status);
  if (status >= 500) return new ProviderError(provider, "server", `${provider}_server_${status}`, status);
  return new ProviderError(provider, "bad_request", `${provider}_error_${status}`, status);
}

/** Nettverks-/timeoutfeil fra fetch normalisert (AbortError → timeout). */
export function classifyFetchError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = (err as Error)?.name ?? "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new ProviderError(provider, "timeout", `${provider}_timeout`);
  }
  return new ProviderError(provider, "network", `${provider}_network: ${(err as Error)?.message ?? "ukjent"}`);
}

/**
 * Felles adaptergrensesnitt for alle modell-leverandører (arkitekturregel:
 * ingen modul snakker med en leverandør-API direkte, kun via adapter).
 * onToken muliggjør streaming; adaptere uten ekte streaming kaller den én gang.
 */
export interface ModelProviderAdapter {
  readonly name: string;
  /** Modellen adapteren er konfigurert mot (informativt for registry/status). */
  readonly model?: string;
  /** Har adapteren nødvendig konfigurasjon (nøkkel/endepunkt) til å kunne brukes? */
  available(): boolean;
  complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult>;
  /**
   * UA-1 P1A: ekte streaming gjennom normalisert event-kontrakt. Returnerer samme
   * ModelResult som complete (rekonstruert). Avbrudd via signal → ProviderError(cancelled).
   */
  stream?(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult>;
}

/** Deler SSE-bytes til datalinjer ("data: {...}") - felles for OpenAI/Anthropic-streams. */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
