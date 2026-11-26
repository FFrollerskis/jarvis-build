import { randomUUID } from "node:crypto";
import {
  classifyFetchError,
  classifyHttpStatus,
  envOrDefault,
  envPositiveInt,
  ProviderError,
  sseLines,
  textOnly,
  type ChatMessage,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamHandler,
  type ToolCallRequest
} from "./types.ts";
import { renderToolResultTextForLocal } from "./tool-result-envelope.ts";

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
 *
 * D-106 HOST-FIX (produksjonsherding): den kanoniske semantikken for
 * `baseUrl` er ALLTID "root-URL uten `/v1`" - adapteren eier å konstruere
 * `/v1/chat/completions` selv, nøyaktig én gang. Operatør-konfig (env-var)
 * kan likevel komme inn i 4 dokumenterte former (med/uten avsluttende `/`,
 * med/uten allerede inkludert `/v1`) - se `normalizeLocalLlmBaseUrl()`, som
 * KUN strippes en eksakt avsluttende `/v1`-segment (aldri delvis match, f.eks.
 * `/v1beta`), slik at feilkonfigurerte/uventede stier ALDRI stille mangles
 * til noe annet enn det operatøren faktisk skrev.
 */
export function normalizeLocalLlmBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * D-385: tenkemodeller (f.eks. Qwen3 via Ollama) kan levere resonneringen som `<think>...</think>` INNE i `content`. Den skal aldri nå
 * eieren (chat/tale) eller bli lagret som svar. Fjerner lukkede blokker og en åpen blokk uten avslutning (avkuttet på `max_tokens`).
 */
export function stripThinking(text: string): string {
  // WP-D4: LINEÆR skanning, ikke `/<think>[\s\S]*?<\/think>/gi` + `/<think>[\s\S]*$/i`: mange uavsluttede `<think>` i en lang respons ga kvadratisk tid (140 000 tegn ≈ 1,4 s, synkront i hendelsesløkken), og Hermes-parseren
  // leser ubetrodd modelltekst gjennom denne. NØYAKTIG samme to trinn som før (låst mot den gamle implementasjonen av en differensialtest, `wpd4-linear-parsers.test.ts`):
  //  1. lukkede blokker fjernes (en ny `<think>` inni en åpen blokk er en del av den; en løs `</think>` utenfor en blokk står som tekst; en åpning uten avslutning røres ikke);
  //  2. fra første gjenværende `<think>` forkastes alt til slutten (åpen blokk avkuttet på `max_tokens`). Trinn 2 ser også en `<think>` som først DANNES når trinn 1 fjerner en blokk midt i en tagg - bevisst like konservativt som før.
  let visible = "";
  let from = 0;
  let openAt = -1;
  for (const tag of text.matchAll(/<(\/?)think>/gi)) {
    const index = tag.index ?? 0;
    if (openAt === -1) {
      if (tag[1] === "") openAt = index;
    } else if (tag[1] === "/") {
      visible += text.slice(from, openAt);
      from = index + tag[0].length;
      openAt = -1;
    }
  }
  visible += text.slice(from);
  const cut = visible.search(/<think>/i);
  return (cut === -1 ? visible : visible.slice(0, cut)).trim();
}

/**
 * D-404: inkrementell variant av `stripThinking` for strømming. Tekst mellom `<think>` og `</think>` slippes ALDRI ut (heller ikke delvis når taggen
 * er delt over to deltaer), og en åpen blokk uten avslutning forkastes ved slutten - samme garanti som `stripThinking` i `complete()`.
 */
export class ThinkFilter {
  private inThink = false;
  private buf = "";

  /** Lengste suffiks av `text` som kan være starten på `tag` (tagen er ikke komplett ennå). */
  private static partialTail(text: string, tag: string): number {
    const lower = text.toLowerCase();
    for (let n = Math.min(tag.length - 1, lower.length); n > 0; n--) {
      if (tag.startsWith(lower.slice(lower.length - n))) return n;
    }
    return 0;
  }

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      const lower = this.buf.toLowerCase();
      if (!this.inThink) {
        const idx = lower.indexOf("<think>");
        if (idx >= 0) {
          out += this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 7);
          this.inThink = true;
          continue;
        }
        const keep = ThinkFilter.partialTail(this.buf, "<think>");
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const end = lower.indexOf("</think>");
      if (end >= 0) {
        this.buf = this.buf.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const keep = ThinkFilter.partialTail(this.buf, "</think>");
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** Ved strømmens slutt: en ufullstendig `<think`-hale utenfor en blokk er vanlig tekst; innhold i en åpen blokk forkastes. */
  flush(): string {
    const rest = this.inThink ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

/**
 * WP-G3 (D-465): bildedeler til et OpenAI-kompatibelt lokalt endepunkt. Kun `image_url` med en `data:`-URL (base64) - ALDRI en ekstern URL
 * (verken modellserveren eller noen annen får hente noe på nettet for oss, så ingen SSRF-flate og ingen utgående trafikk fra bildet).
 * Format verifisert mot Ollama sin OpenAI-kompatibilitetsside (vision: `image_url` med `data:image/...;base64,...`) og llama.cpp-serverens
 * multimodal-dokumentasjon (`image_url`-del i `/v1/chat/completions`) via WebSearch - IKKE live-verifisert mot en ekte lokal modell i
 * denne økten (se docs/runbooks/WPG3_VISION.md, `unverified`).
 * `media_type` må være jpeg/png/webp og `data` rå base64 (samme kontrakt som `ContentPart`): alt annet avvises som `bad_request` før noe sendes.
 */
const LOCAL_VISION_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_LOCAL_IMAGE_BASE64_CHARS = 28 * 1024 * 1024;

/**
 * WP-G3 (review A-L6): tak på svarkroppen fra den dedikerte visjonsidentiteten. Klassifisereren ber om maks 500 tokens (noen KB), så 1 MiB er rause rom; en lokal server som svarer med mer (feil, kompromittert
 * eller en endeløs strøm) avbrytes ved grensen i stedet for å fylle api-prosessens minne. Øvrige identiteter (`local_llm`/`gemma_local`) leser uendret med `response.json()`.
 */
const MAX_LOCAL_VISION_RESPONSE_BYTES = 1024 * 1024;

async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("response_too_large");
  }
  if (response.body === null) throw new Error("response_no_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

function toOpenAiVisionContent(provider: string, content: ChatMessage["content"]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!content.some((part) => part.type === "image")) return textOnly(content);
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (!LOCAL_VISION_MEDIA_TYPES.has(part.media_type) || part.data.length === 0 || part.data.length > MAX_LOCAL_IMAGE_BASE64_CHARS || !BASE64_BODY.test(part.data)) {
      throw new ProviderError(provider, "bad_request", `${provider}_invalid_image_part`);
    }
    return { type: "image_url", image_url: { url: `data:${part.media_type};base64,${part.data}` } };
  });
}

export class LocalOpenAiCompatibleAdapter implements ModelProviderAdapter {
  readonly name: string;
  private readonly chatCompletionsUrl: string | undefined;
  private readonly vision: boolean;
  private readonly noRedirect: boolean;

  constructor(
    private readonly baseUrl: string | undefined = process.env["LOCAL_LLM_BASE_URL"],
    readonly model: string = envOrDefault("LOCAL_LLM_MODEL", "local-model"),
    private readonly timeoutMs: number = envPositiveInt("JARVIS_MODEL_TIMEOUT_MS", 120_000),
    name: string = "local_llm",
    /**
     * D-385: `"off"` sender `reasoning_effort: "none"` (Ollama sin OpenAI-kompatible rute) slik at tenkemodeller ikke bruker `max_tokens`
     * på resonnering (tale har 320 tokens - hele budsjettet kan ellers gå til «tenking» og gi tomt svar). Av som standard: uendret
     * oppførsel for modeller/servere uten tenking. Styres av `JARVIS_LOCAL_LLM_THINKING=off`.
     */
    private readonly thinking: "off" | "default" = process.env["JARVIS_LOCAL_LLM_THINKING"] === "off" ? "off" : "default",
    /**
     * WP-G3 (D-465): `vision: true` sender bildedeler (`image_url` med base64 `data:`-URL) i stedet for å droppe dem stille (`textOnly`). Av som standard:
     * `local_llm`/`gemma_local` er byte-for-byte uendret. Brukes KUN av den dedikerte `local_vision`-identiteten (`JARVIS_VISION_LOCAL_URL`).
     */
    options: {
      vision?: boolean;
      /**
       * WP-G4b fiks-runde 1 (FIX-5, review B L1): `noRedirect: true` følger ALDRI en omdirigering (`redirect: "error"`): en 307/308 fra den lokale URL-en (http->https på en omvendt proxy, en kapret/feilkonfigurert vert) ville sendt
       * forespørselskroppen (modellinnhold) videre til `Location`. Settes av komposisjonsroten kun når `JARVIS_LOCAL_MODEL_URL_GUARD=on`; av som standard = ingen `redirect`-nøkkel (som før).
       */
      noRedirect?: boolean;
    } = {}
  ) {
    this.name = name;
    this.vision = options.vision === true;
    this.noRedirect = options.noRedirect === true;
    this.chatCompletionsUrl = baseUrl ? `${normalizeLocalLlmBaseUrl(baseUrl)}/v1/chat/completions` : undefined;
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

  private buildMessages(request: ModelRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: this.vision ? toOpenAiVisionContent(this.name, m.content) : textOnly(m.content) }))
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
        messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: renderToolResultTextForLocal(r) });
      }
    }
    return messages;
  }

  private buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.model,
      stream,
      messages: this.buildMessages(request),
      max_tokens: request.max_tokens ?? 1024,
      ...(this.thinking === "off" ? { reasoning_effort: "none" } : {}),
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
        : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {})
    };
  }

  async complete(request: ModelRequest, onToken?: (token: string) => void): Promise<ModelResult> {
    if (!this.baseUrl || !this.chatCompletionsUrl) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
        body: JSON.stringify(this.buildBody(request, false)),
        // WP-G3: den dedikerte visjonsidentiteten følger ALDRI en redirect (en 307/308 ville sendt kamerabildene videre til et annet mål); øvrige identiteter er uendret.
        ...(this.vision || this.noRedirect ? { redirect: "error" as const } : {})
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
      // WP-G3 (review A-L6): visjonsidentiteten leser svaret med et bytetak; øvrige identiteter er uendret (`response.json()`).
      body = (this.vision ? await readJsonLimited(response, MAX_LOCAL_VISION_RESPONSE_BYTES) : await response.json()) as typeof body;
      if (!Array.isArray(body.choices)) {
        throw new Error("mangler choices");
      }
    } catch (err) {
      const tooLarge = this.vision && err instanceof Error && err.message === "response_too_large";
      throw new ProviderError(this.name, "invalid_response", tooLarge ? `${this.name}_response_too_large` : `${this.name}_invalid_response`);
    }
    const message = body.choices[0]?.message;
    const text = stripThinking(message?.content ?? "");
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

  /**
   * D-404: ekte SSE-strømming mot et OpenAI-kompatibelt lokalt endepunkt (Ollama, llama.cpp, vLLM, LM Studio). Uten denne kunne `gateway.stream()`
   * aldri velge `gemma_local` (registeret kan ikke påstå `streaming` uten en `.stream()`, D-80), så «Gemma først» (D-354) falt stille til sky for
   * ALL vanlig chat. Samme event-kontrakt som `OpenAiAdapter.stream()`; `<think>`-blokker filtreres inkrementelt (`ThinkFilter`).
   *
   * UVERIFISERT mot en ekte Ollama-/llama.cpp-server i denne økten (kun enhetstestet mot en fake SSE-server). Særlig: om serveren strømmer
   * verktøykall (`delta.tool_calls`) varierer mellom serverversjoner - mangler `index`, brukes posisjonen i listen.
   */
  async stream(request: ModelRequest, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    if (!this.baseUrl || !this.chatCompletionsUrl) {
      throw new ProviderError(this.name, "not_configured", `${this.name}_not_configured`);
    }
    const started = Date.now();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs);
      response = await fetch(this.chatCompletionsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify(this.buildBody(request, true)),
        ...(this.vision || this.noRedirect ? { redirect: "error" as const } : {})
      });
    } catch (err) {
      if (signal?.aborted) throw new ProviderError(this.name, "cancelled", `${this.name}_cancelled`);
      throw classifyFetchError(this.name, err);
    }
    if (!response.ok) {
      throw classifyHttpStatus(this.name, response.status);
    }
    if (!response.body) {
      throw new ProviderError(this.name, "invalid_response", `${this.name}_no_stream_body`);
    }
    onEvent({ type: "start", provider: this.name, model: this.model, generation_id: `gen-${randomUUID().slice(0, 12)}` });
    const filter = new ThinkFilter();
    let text = "";
    let ttft: number | undefined;
    let finish = "";
    let sawDone = false;
    let usage = { input_tokens: 0, output_tokens: 0 };
    const pendingTools = new Map<number, { id?: string; name?: string; args: string }>();
    const completedCalls: ToolCallRequest[] = [];
    const emitText = (piece: string): void => {
      if (!piece) return;
      if (ttft === undefined) ttft = Date.now() - started;
      text += piece;
      onEvent({ type: "text_delta", text: piece });
    };
    try {
      for await (const data of sseLines(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
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
        if (delta?.content) emitText(filter.push(delta.content));
        (delta?.tool_calls ?? []).forEach((tc, position) => {
          const key = tc.index ?? position;
          let pending = pendingTools.get(key);
          if (!pending) {
            pending = { args: "" };
            pendingTools.set(key, pending);
            if (ttft === undefined) ttft = Date.now() - started;
          }
          if (tc.id) pending.id = tc.id;
          if (tc.function?.name) {
            pending.name = (pending.name ?? "") + tc.function.name;
            onEvent({ type: "tool_call_start", tool_call_id: pending.id ?? `idx-${key}`, tool_name: pending.name });
          }
          if (tc.function?.arguments) {
            pending.args += tc.function.arguments;
            onEvent({ type: "tool_call_delta", tool_call_id: pending.id ?? `idx-${key}`, arguments_delta: tc.function.arguments });
          }
        });
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
    // Samme regel som OpenAiAdapter (D-393/JARVIS-038): en strøm uten verken finish_reason eller [DONE] er AVBRUTT, ikke komplett.
    if (!finish && !sawDone) {
      throw new ProviderError(this.name, "stream_interrupted", `${this.name}_stream_ended_without_finish`);
    }
    emitText(filter.flush());
    for (const pending of pendingTools.values()) {
      const call = this.parseToolCall(pending.id, pending.name, pending.args);
      completedCalls.push(call);
      onEvent({ type: "tool_call_complete", call });
    }
    const finalText = text.trim();
    let structured: unknown;
    if (request.structured_schema && finalText) {
      try {
        structured = JSON.parse(finalText);
      } catch {
        throw new ProviderError(this.name, "invalid_response", `${this.name}_invalid_structured_output`);
      }
    }
    onEvent({ type: "usage", usage });
    onEvent({ type: "finish", finish_reason: finish || "stop" });
    return {
      text: finalText,
      usage,
      provider: this.name,
      model: this.model,
      latency_ms: Date.now() - started,
      ...(ttft !== undefined ? { ttft_ms: ttft } : {}),
      finish_reason: finish || "stop",
      ...(structured !== undefined ? { structured_output: structured } : {}),
      ...(completedCalls.length > 0 ? { tool_calls: completedCalls } : {})
    };
  }
}
