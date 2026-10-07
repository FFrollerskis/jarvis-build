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
  /**
   * Del 3 (JARVIS-002): tillitsnivå på verktøyoutput, satt av TRUSTED lag (executor) fra verktøydefinisjonen - aldri av modellen.
   * Mangler den, behandles outputen som `untrusted` (fail-closed). Bevares gjennom hele løkka og ut i hver adapter via data-envelopet.
   */
  trust?: "trusted" | "internal" | "untrusted";
  /** Verktøykilde, f.eks. `email.read_inbox` (proveniens). */
  source?: string;
  /** Størrelsesgrenser som ble brukt på outputen. */
  bounds?: { truncated: boolean; max_chars: number };
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
  /**
   * D-399 (modellrådgiver): per-kall modellvalg INNENFOR adapterens leverandør (f.eks. Sonnet i stedet for Fable). Settes KUN av `ModelGateway` etter validering mot
   * modellkatalogen - aldri av en kaller/modell. Udefinert (normaltilfellet) = adapterens konfigurerte standardmodell, uendret oppførsel. Adaptere uten støtte ignorerer feltet.
   */
  model?: string;
}

/** D-399: forsvar i dybden - modell-id-en havner i en URL-sti/JSON-kropp, så kun trygge tegn slippes gjennom selv om gatewayen allerede har validert mot katalogen. */
export function effectiveModel(request: { model?: string }, fallback: string): string {
  if (request.model === undefined) return fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(request.model)) throw new Error("invalid_model_override");
  return request.model;
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
  /** Kun når provider rapporterer cache-treff (f.eks. Anthropic/OpenAI). Inngår i `input_tokens` (som er TOTALT antall inn-tokens). */
  cached_tokens?: number;
  /** D-432: tokens skrevet til prompt-cachen (Anthropic `cache_creation_input_tokens`); inngår i `input_tokens` og koster mer enn vanlig input (standard 1,25x). */
  cache_write_tokens?: number;
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

/**
 * D-340 (host-bevist, 2026-09-28 NAS-deploy: Gemini feilet med tomt
 * modellnavn i URL-en - `models/:generateContent`): `.env`/`.env.example`
 * sin dokumenterte konvensjon er at en TOM verdi betyr "bruk defaulten",
 * ALDRI "sett til tom streng" (se f.eks. JARVIS_GEMINI_MODEL sin kommentar:
 * "eksplisitt satt verdi vinner alltid over defaulten"). `docker compose`
 * sin `env_file`-mekanisme setter likevel variabelen til en FAKTISK, tilstede-
 * værende tom streng når `.env` inneholder `NAVN=` uten verdi - `??` fanger
 * KUN `null`/`undefined`, ikke tom streng, så defaulten ble aldri brukt.
 * Alle provider-adaptere sin modell-/URL-/nøkkel-fallback bruker denne
 * hjelperen i stedet for rå `?? "..."` for å faktisk overholde konvensjonen.
 */
export function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

/**
 * Remediering del 1 (JARVIS-078/092): `Number(process.env["JARVIS_MODEL_TIMEOUT_MS"] ?? 60_000)` ga
 * `0` ms for en tom streng (`KEY=` i `.env`) og `NaN` for søppel. Tom/usatt = defaulten;
 * satt men ikke et positivt heltall = oppstartsfeil (kaster).
 */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`ugyldig miljøvariabel ${name}="${raw.slice(0, 40)}": forventet positivt heltall (tom/usatt = ${fallback})`);
  }
  return parsed;
}

/** Samme tom-streng-som-usatt-semantikk for en kjede av valgfrie fallback-miljøvariabler (ingen sluttdefault - kan returnere undefined). */
export function firstNonEmptyEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * D-341 (host-bevist, 2026-09-28: Charlie svarte fortsatt 400 fra gemini/
 * gemma_hosted etter D-340 sin .env-fiks): Google sitt Schema-format for
 * BÅDE function-declaration-parametre (`generateContent`/`streamGenerateContent`
 * sitt `tools[].functionDeclarations[].parameters`) OG strukturert utdata
 * (`generationConfig.responseSchema`) er en BEGRENSET delmengde av
 * OpenAPI 3.0 - støtter IKKE `additionalProperties` (D-204, allerede kjent
 * og fikset for verktøy-parametre i `gemma.ts`, MEN ALDRI for
 * `responseSchema` - `modules/memory/src/extraction.ts` sitt
 * `EXTRACTION_JSON_SCHEMA` har `additionalProperties: false` i to nivåer og
 * sendes RÅTT som `responseSchema`, host-bevist `gemini_error_400`/
 * `INVALID_ARGUMENT`) ELLER unions (`anyOf`/`oneOf`/`allOf` - IKKE tidligere
 * oppdaget; Jarvis sine egne `z.union([...])`-baserte verktøyskjemaer, f.eks.
 * Google Sheets sin celleverdi-type i `mesh-bridge.ts` sin `allMeshTools()`,
 * produserer nettopp dette via `zod-to-json-schema`, og siden Gemini
 * validerer HELE `tools`-arrayet FØR generering starter, gjør ÉN eneste
 * usupportert verktøy-skjema at absolutt ALLE ~400 mesh-verktøyene feiler
 * samtidig, uansett hvilket verktøy brukerens melding faktisk trenger).
 * En union kollapses til en tom skjema (aksepterer alt) i stedet for å
 * GJETTE seg frem til én enkelt type - TRYGT fordi denne JSON-skjemaen KUN
 * er en modell-veiledende kopi, ALDRI selve autorisasjonsgrensen
 * (`ToolGateway.execute()` validerer ALLTID mot den ekte Zod-typen
 * uavhengig av hva som ble sendt til modellen, se `mesh-bridge.ts`).
 * Delt her (ikke duplisert i `gemini.ts`/`gemma.ts`) - SAMME Google-API-
 * begrensning gjelder identisk for verktøy-parametre OG responseSchema,
 * begge adaptere.
 *
 * D-343 (host-bevist, 2026-09-29: Charlie svarte FORTSATT `voice_core_error`/
 * "Noe gikk galt under generering" fra gemma_hosted ETTER D-341 var deployet
 * OG D-342/D-192-testrunden faktisk nådde en ekte tool-mesh-samtale for
 * FØRSTE gang - `docker logs local-api-1` viste SAMME `gemma_hosted`
 * `INVALID_ARGUMENT`-diagnostikk som D-341, uendret): offline-skanning av
 * ALLE 400 registrerte verktøy sin sanerte utdata (`npx tsx` mot de EKTE
 * Zod-skjemaene, IKKE gjettet) fant 9 gjenværende verktøy (finance/
 * finance_spend/finance_stripe/finance_vipps sine beløps-/intervallfelter,
 * f.eks. `finance:create_payment_intent.amount_ore`) med
 * `exclusiveMinimum: true` (OpenAPI-3.0-boolsk stil, fra Zod sin
 * `.positive()`/`.int().positive()`) - ET FELT Google sitt begrensede
 * Schema-format IKKE dokumenterer (samme "ukjent felt i tools-arrayet
 * knekker ALLE 400 verktøy samtidig"-mekanisme som D-341 sin `anyOf`-
 * oppdagelse - egress til `ai.google.dev` er BLOKKERT i denne økten, SAMME
 * D-297-forbehold: dette er trent kunnskap om Google sitt dokumenterte
 * Schema-feltsett, IKKE denne-økten-verifisert mot live dokumentasjon).
 * `exclusiveMinimum`/`exclusiveMaximum` fjernes derfor her (samme
 * "modell-veiledende kopi, ALDRI autorisasjonsgrensen"-begrunnelse som
 * `additionalProperties`/unions over) - `minimum`/`maximum` BEHOLDES
 * uendret (dokumentert støttet av Google, og selv om de IKKE skulle være
 * det ville de i verste fall ignoreres, aldri knekke kallet, siden de ikke
 * er strukturelt uventede nøkler på samme måte som en bar boolsk flagg-
 * verdi kan være).
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }
  if (schema && typeof schema === "object") {
    const obj = schema as Record<string, unknown>;
    if ("anyOf" in obj || "oneOf" in obj || "allOf" in obj) {
      return obj["description"] !== undefined ? { description: obj["description"] } : {};
    }
    const rest: Record<string, unknown> = { ...obj };
    delete rest["additionalProperties"];
    delete rest["exclusiveMinimum"];
    delete rest["exclusiveMaximum"];
    for (const key of Object.keys(rest)) {
      rest[key] = sanitizeGeminiSchema(rest[key]);
    }
    return rest;
  }
  return schema;
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
