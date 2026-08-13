export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /** JSON Schema for strukturert output - kun providere med structured_output-capability. */
  structured_schema?: Record<string, unknown>;
}

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
  | "not_configured";

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

  /** Retry-safe mot SAMME provider (transient). */
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
}
