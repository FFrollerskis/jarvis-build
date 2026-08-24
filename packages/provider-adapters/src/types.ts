/**
 * UA-2 P1B-A (D-43 §3): multimodalt innholdselement - normalisert, provider-
 * nøytralt format. `data` er RÅ base64 (ALDRI en `data:`-URI-prefiks, ALDRI
 * en fil-sti) - adaptere som faktisk støtter bilder oversetter selv til sitt
 * eget leverandørformat (se `anthropic.ts`). `media_type` er en MIME-type,
 * f.eks. "image/png" - aldri gjettet, alltid satt av kalleren som vet hva
 * bytes faktisk er.
 */
export type ContentPart = { type: "text"; text: string } | { type: "image"; media_type: string; data: string };

export interface ChatMessage {
  role: "user" | "assistant";
  /**
   * UA-2 P1B-A: `string` (uendret, dekker ALLE eksisterende kall) ELLER
   * `ContentPart[]` for multimodalt (vision) innhold. Adaptere UTEN reell
   * bildestøtte (se capability-registry.ts sitt `vision`-flagg) bruker
   * `textOnly()` og degraderer trygt til KUN tekstdelene - kaster ALDRI på
   * et array, sender ALDRI et rått array som streng til en leverandør-API.
   */
  content: string | ContentPart[];
}

/** Trekker ut kun tekstdelen av et meldingsinnhold - for adaptere/kode uten multimodal støtte. */
export function textOnly(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
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
  /**
   * D-106 Council reliability (§ARCHITECTURE DECISION): eksplisitt, validert
   * per-kall timeout-overstyring i millisekunder. ALDRI satt direkte av en
   * kaller - `ModelGateway` er det ENESTE stedet dette feltet fylles inn
   * (validert mot `MAX_MODEL_TIMEOUT_MS`), adaptere leser den bare. Udefinert
   * (normaltilfellet) = adapterens egen konstruksjonstidsdefault
   * (`JARVIS_MODEL_TIMEOUT_MS`/60000) - UENDRET oppførsel for alle ordinære
   * kall. Generisk arbeidsmengde-egenskap - ALDRI provider-spesifikk logikk
   * noe sted i adapterne.
   */
  timeoutMs?: number;
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

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt B): TRYGG feilsøkings-metadata
 * for en HTTP-feilrespons - bevisst begrenset til feltene ordren eksplisitt
 * tillot ("provider, status, provider error code, sanitized host/path,
 * selected model, request operation"). ALDRI API-nøkkel, ALDRI auth-header,
 * ALDRI query-string (kan i prinsippet bære secrets hos en fremtidig
 * provider, selv om ingen adapter i dag sender nøkkel der), ALDRI fulle
 * prompts. `provider_error_code` er KUN en kort identifikator hentet fra
 * leverandørens response-body (f.eks. Gemini sin `error.status`
 * ("NOT_FOUND"), en OpenAI-kompatibel `error.code`/`error.type`) - ALDRI
 * leverandørens frie `error.message`-tekst (som i prinsippet kunne
 * inneholde noe fra request-innholdet ekko'et tilbake).
 */
export interface ProviderErrorDiagnostic {
  provider_error_code?: string;
  sanitized_endpoint?: string;
  request_operation?: string;
}

/**
 * Henter en TRYGG, kort feilkode-identifikator fra en leverandørs JSON-
 * feilrespons-body - ALDRI den frie `message`-teksten. Dekker BÅDE Google-
 * stilen (`{error: {code, message, status}}`, Gemini/Gemma) OG OpenAI-
 * kompatibel stil (`{error: {message, type, code}}`, Kimi/OpenAI/lokale
 * endepunkter) - samme funksjon for begge, provider-nøytral. Returnerer
 * `undefined` ved ugyldig JSON eller uventet form - ALDRI en gjettet verdi.
 */
export function extractProviderErrorCode(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; status?: unknown; type?: unknown } };
    const err = parsed.error;
    if (!err || typeof err !== "object") return undefined;
    // Prioritering: Google-stil `status` (streng-enum, f.eks. "NOT_FOUND") FØRST -
    // deretter en STRENG `code` (OpenAI-kompatibel stil, f.eks. "model_not_found" -
    // det mest presise feltet der) - deretter `type` (bredere kategori, f.eks.
    // "invalid_request_error") - og HELT sist en NUMERISK `code` (Google-stil,
    // ekko av HTTP-statusen - minst nyttig, men bedre enn ingenting).
    const status = typeof err.status === "string" ? err.status : undefined;
    const codeStr = typeof err.code === "string" ? err.code : undefined;
    const type = typeof err.type === "string" ? err.type : undefined;
    const codeNum = typeof err.code === "number" ? String(err.code) : undefined;
    const value = status ?? codeStr ?? type ?? codeNum;
    return value ? value.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}

/** Host+path (ALDRI query-string/fragment - der en fremtidig provider i prinsippet kunne plassert secrets). */
export function sanitizeEndpointForDiagnostics(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly diagnostic?: ProviderErrorDiagnostic
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

/**
 * Felles HTTP-statusklassifisering for alle adaptere - konsistente
 * normaliserte feil. `diagnostic` er VALGFRITT (D-106 HOST-FIX Defekt B) -
 * eksisterende kallesteder som ikke sender det er UENDRET (§23
 * migrasjonssikkerhet); adaptere som ROT-ÅRSAKER en feil (i dag: Gemini,
 * Kimi) sender trygg, begrenset metadata for feilsøking uten live nøkler.
 */
export function classifyHttpStatus(provider: string, status: number, diagnostic?: ProviderErrorDiagnostic): ProviderError {
  if (status === 401 || status === 403) return new ProviderError(provider, "auth", `${provider}_auth_${status}`, status, diagnostic);
  if (status === 429) return new ProviderError(provider, "rate_limit", `${provider}_rate_limited`, status, diagnostic);
  if (status >= 500) return new ProviderError(provider, "server", `${provider}_server_${status}`, status, diagnostic);
  return new ProviderError(provider, "bad_request", `${provider}_error_${status}`, status, diagnostic);
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
