import { randomUUID } from "node:crypto";
import { ProviderError, type StreamEvent, type ToolCallRequest, type ToolDefinition, type ToolExchange, type ToolResultMessage } from "./types.ts";
import { renderToolResultText } from "./tool-result-envelope.ts";

/**
 * JARVIS-036 (WP-D4): felles, RENE hjelpere for leverandører som snakker OpenAI-kompatible `tools`/`tool_calls` (Kimi/Moonshot). Ingen nettverk og ingen tilstand utenom strømsammensetteren.
 *
 * Strenghet (alt under er fail-closed - et ugyldig verktøykall blir `invalid_tool_call`, aldri en delvis eller gjettet utførelse):
 *  - argumentene MÅ være et JSON-objekt (ikke liste, tall, streng eller `null`); tom streng betyr «ingen argumenter»;
 *  - navnet MÅ være en ikke-tom streng (maks 128 tegn);
 *  - et strømmet kall uten navn, med to ulike navn, eller med mer enn `MAX_STREAMED_CALLS` kall/`MAX_ARGUMENT_CHARS` tegn argumenter avvises.
 * Selve utførelsen skjer aldri her: gatewayen validerer navn/skjema mot verktøyutvalget og utfører kun via trusted executor (Policy/bekreftelse).
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const MAX_STREAMED_CALLS = 64;
export const MAX_ARGUMENT_CHARS = 1_000_000;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_CALL_ID_CHARS = 200;

/**
 * L10 (gjennomgang av PR #315): tokentall fra leverandøren går rett inn i kostberegningen (`cost_events`, månedsbudsjettet), så de må være tall vi kan stole på: ENDELIGE HELTALL >= 0 og under et romslig tak
 * (en kontekst på 1M tokens er ekte; 10M er det ikke). Alt annet (`usage: {}`, negative tall, strenger, desimaler, `NaN`/`Infinity`, manglende felt) blir 0 for det feltet og meldes som et problem - aldri en streng eller `NaN`
 * som flyter videre til kostformelen. Kallet feiler ikke (svaret er brukbart), men er merket `usage_missing`/`usage_invalid` i metadata, så ukjent kost aldri leses som gratis.
 */
export const MAX_REPORTED_TOKENS = 10_000_000;

export interface NormalizedUsage {
  usage: { input_tokens: number; output_tokens: number };
  /** Kategorier (aldri verdiene) for felt som ikke var gyldige - tom når alt var i orden. */
  problems: string[];
}

function tokenCount(value: unknown): { ok: true; value: number } | { ok: false; problem: string } {
  if (value === undefined || value === null) return { ok: false, problem: "missing" };
  if (typeof value !== "number") return { ok: false, problem: typeof value === "string" ? "string" : "not_a_number" };
  if (!Number.isFinite(value)) return { ok: false, problem: "not_finite" };
  if (!Number.isInteger(value)) return { ok: false, problem: "not_an_integer" };
  if (value < 0) return { ok: false, problem: "negative" };
  if (value > MAX_REPORTED_TOKENS) return { ok: false, problem: "too_large" };
  return { ok: true, value };
}

/** `usage` fra en OpenAI-kompatibel respons (`prompt_tokens`/`completion_tokens`) → validerte tokentall. */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const source = isPlainObject(raw) ? raw : {};
  const problems: string[] = isPlainObject(raw) ? [] : ["usage_not_an_object"];
  const read = (field: "prompt_tokens" | "completion_tokens"): number => {
    const parsed = tokenCount(source[field]);
    if (parsed.ok) return parsed.value;
    problems.push(`${field}:${parsed.problem}`);
    return 0;
  };
  return { usage: { input_tokens: read("prompt_tokens"), output_tokens: read("completion_tokens") }, problems };
}

export interface OpenAiToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Provider-nøytral verktøydefinisjon → OpenAI-kompatibelt `tools`-element. */
export function toOpenAiToolDefinitions(tools: readonly ToolDefinition[]): OpenAiToolDefinition[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function invalidToolCall(provider: string, reason: string): ProviderError {
  return new ProviderError(provider, "invalid_tool_call", `${provider}_${reason}`);
}

/** Streng parsing av verktøyargumenter (se filhodet). `undefined`/`null`/tom streng = ingen argumenter. */
export function parseToolArguments(provider: string, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string") throw invalidToolCall(provider, "tool_arguments_not_object");
  const text = raw.trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidToolCall(provider, "invalid_tool_arguments");
  }
  if (!isPlainObject(parsed)) throw invalidToolCall(provider, "tool_arguments_not_object");
  return parsed;
}

function requireToolName(provider: string, name: unknown): string {
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_TOOL_NAME_CHARS) throw invalidToolCall(provider, "invalid_tool_name");
  return name;
}

/**
 * L14 (gjennomgang av PR #315): et verktøynavn som IKKE ble tilbudt i denne forespørselen (`request.tools`) er et ugyldig kall - samme regel som Hermes-parseren. Uten dette ble `tool_call_start`/`tool_call_complete` for et
 * hallusinert eller injisert navn vist for klienten (strømmen) før gatewayen avviste kallet. `offered` udefinert = ingen sjekk (eldre kallere); en tom mengde = ingen verktøy tilbudt, så ethvert kall er ukjent.
 */
function requireOfferedToolName(provider: string, name: unknown, offered: ReadonlySet<string> | undefined): string {
  const valid = requireToolName(provider, name);
  if (offered !== undefined && !offered.has(valid)) throw invalidToolCall(provider, "unknown_tool");
  return valid;
}

/** Navnene på verktøyene som ble tilbudt i forespørselen (til `normalizeToolCalls`/`ToolCallStreamAssembler`). */
export function offeredToolNames(tools: readonly ToolDefinition[] | undefined): ReadonlySet<string> {
  return new Set((tools ?? []).map((tool) => tool.name));
}

function toolCallId(id: unknown): string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_TOOL_CALL_ID_CHARS ? id : `call-${randomUUID().slice(0, 8)}`;
}

/** Ett `tool_calls`-element slik det står i et ikke-strømmet svar (`message.tool_calls[]`). */
export interface RawToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Normaliserer `message.tool_calls` fra et ikke-strømmet svar. Ugyldig form → `invalid_tool_call` (aldri et delvis resultat). */
export function normalizeToolCalls(provider: string, model: string, raw: unknown, state?: ToolCallRequest["provider_state"], offered?: ReadonlySet<string>): ToolCallRequest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidToolCall(provider, "tool_calls_not_list");
  if (raw.length > MAX_STREAMED_CALLS) throw invalidToolCall(provider, "too_many_tool_calls");
  return raw.map((item: RawToolCall) => {
    if (!isPlainObject(item) || (item.type !== undefined && item.type !== "function") || !isPlainObject(item.function)) throw invalidToolCall(provider, "invalid_tool_call_shape");
    return {
      tool_call_id: toolCallId(item.id),
      tool_name: requireOfferedToolName(provider, item.function.name, offered),
      arguments: parseToolArguments(provider, item.function.arguments),
      provider,
      model,
      ...(state !== undefined ? { provider_state: state } : {})
    };
  });
}

export interface ReplayOptions {
  /** Leverandøren som spiller av runden (kun kall stemplet av DENNE får sin `provider_state` med). */
  provider: string;
  /** Innholdet i en assistent-melding som kun bærer verktøykall: OpenAI-standard er `null`; Moonshot får tom streng. */
  emptyAssistantContent: "" | null;
  /** Standard er det maskinlesbare DATA-envelopet (Del 3, JARVIS-002): verktøyoutput er data, aldri instruksjoner. */
  renderResult?: (result: ToolResultMessage) => string;
}

/** Tidligere verktøyrunder (provider-nøytrale) → OpenAI-kompatible meldinger: assistent-melding med `tool_calls`, deretter ett `tool`-svar per kall. */
export function openAiToolReplayMessages(exchanges: readonly ToolExchange[] | undefined, opts: ReplayOptions): Array<Record<string, unknown>> {
  const render = opts.renderResult ?? renderToolResultText;
  const messages: Array<Record<string, unknown>> = [];
  for (const ex of exchanges ?? []) {
    const reasoning = ex.calls
      .map((c) => (c.provider === opts.provider ? c.provider_state?.reasoning_content : undefined))
      .find((r): r is string => typeof r === "string" && r.length > 0);
    messages.push({
      role: "assistant",
      content: opts.emptyAssistantContent,
      ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      tool_calls: ex.calls.map((c) => ({ id: c.tool_call_id, type: "function", function: { name: c.tool_name, arguments: JSON.stringify(c.arguments) } }))
    });
    for (const r of ex.results) messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: render(r) });
  }
  return messages;
}

/** Ett delta-element i en strømmet respons (`choices[0].delta.tool_calls[]`). */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface PendingCall {
  id?: string;
  name?: string;
  args: string;
  started: boolean;
}

/**
 * Setter sammen strømmede verktøykall fra deltaer. Nøkkel: `index` når serveren oppgir den; ellers starter et nytt `id` et nytt kall, og delta uten både `index` og `id` hører til det
 * SISTE kallet (en server uten `index` sender argumentfragmentene uten id). Kallene valideres først når hele strømmen er mottatt (`complete()`), aldri mens fragmentene kommer.
 */
export class ToolCallStreamAssembler {
  private readonly calls = new Map<number, PendingCall>();
  private lastKey = -1;

  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly emit: (event: StreamEvent) => void,
    /** L14: verktøynavnene som ble tilbudt. Et navn utenfor mengden avvises (`invalid_tool_call`) FØR noe `tool_call_start` sendes til klienten. Udefinert = ingen sjekk. */
    private readonly offered?: ReadonlySet<string>
  ) {}

  /** `true` når deltaene inneholdt verktøykall-innhold (brukes til time-to-first-token). */
  push(deltas: readonly ToolCallDelta[] | undefined): boolean {
    if (!Array.isArray(deltas) || deltas.length === 0) return false;
    for (const delta of deltas) {
      // Kjøretidsvakt mot en server som sender noe annet enn et objekt (typen alene er ingen garanti for innkommende JSON).
      if (typeof delta !== "object" || delta === null || Array.isArray(delta)) throw invalidToolCall(this.provider, "invalid_tool_call_shape");
      const key = this.keyFor(delta);
      let call = this.calls.get(key);
      if (!call) {
        if (this.calls.size >= MAX_STREAMED_CALLS) throw invalidToolCall(this.provider, "too_many_tool_calls");
        call = { args: "", started: false };
        this.calls.set(key, call);
      }
      this.lastKey = key;
      if (typeof delta.id === "string" && delta.id.length > 0 && call.id === undefined) call.id = delta.id;
      const name = delta.function?.name;
      if (typeof name === "string" && name.length > 0) {
        if (call.name === undefined) {
          if (this.offered !== undefined && !this.offered.has(name)) throw invalidToolCall(this.provider, "unknown_tool");
          call.name = name;
        } else if (call.name !== name) throw invalidToolCall(this.provider, "conflicting_tool_names");
      }
      if (call.name !== undefined && !call.started) {
        call.started = true;
        this.emit({ type: "tool_call_start", tool_call_id: call.id ?? `idx-${key}`, tool_name: call.name });
      }
      const fragment = delta.function?.arguments;
      if (typeof fragment === "string" && fragment.length > 0) {
        if (call.args.length + fragment.length > MAX_ARGUMENT_CHARS) throw invalidToolCall(this.provider, "tool_arguments_too_large");
        call.args += fragment;
        this.emit({ type: "tool_call_delta", tool_call_id: call.id ?? `idx-${key}`, arguments_delta: fragment });
      }
    }
    return true;
  }

  private keyFor(delta: ToolCallDelta): number {
    if (typeof delta.index === "number" && Number.isInteger(delta.index) && delta.index >= 0) return delta.index;
    if (typeof delta.id === "string" && delta.id.length > 0) {
      for (const [key, call] of this.calls) if (call.id === delta.id) return key;
      return this.calls.size === 0 ? 0 : Math.max(...this.calls.keys()) + 1;
    }
    return this.lastKey >= 0 ? this.lastKey : 0;
  }

  /** Hele strømmen er mottatt: valider strengt og lever normaliserte kall (med `tool_call_complete`). Ugyldig → `invalid_tool_call`, ingenting leveres. */
  complete(state?: ToolCallRequest["provider_state"]): ToolCallRequest[] {
    const out: ToolCallRequest[] = [];
    for (const key of [...this.calls.keys()].sort((a, b) => a - b)) {
      const call = this.calls.get(key) as PendingCall;
      out.push({
        tool_call_id: toolCallId(call.id),
        tool_name: requireToolName(this.provider, call.name),
        arguments: parseToolArguments(this.provider, call.args),
        provider: this.provider,
        model: this.model,
        ...(state !== undefined ? { provider_state: state } : {})
      });
    }
    for (const call of out) this.emit({ type: "tool_call_complete", call });
    return out;
  }
}
