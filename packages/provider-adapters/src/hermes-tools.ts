import type { ToolCallRequest, ToolDefinition, ToolExchange, ToolResultMessage } from "./types.ts";
import { renderToolResult } from "./tool-result-envelope.ts";
import { stripThinking } from "./local-llm.ts";

/**
 * JARVIS-036 (WP-D4): Hermes (NousResearch) verktøykall via modellens EGET prompt-protokoll - rene funksjoner, ingen nettverk.
 *
 * Modellkortet (Hermes 4) beskriver verktøy som JSON-signaturer innenfor `<tools></tools>` i systemmeldingen, og at modellen svarer et kall som `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`;
 * resultater gis tilbake innenfor `<tool_response></tool_response>`. Hvorvidt Nous' HOSTEDE API oversetter OpenAI-`tools` til dette selv er IKKE dokumentert (kilder motsier hverandre: enkelte
 * tredjeparter oppgir funksjonskall som ustøttet på 405B, andre som støttet), så adapteren sender ALDRI `tools`-feltet og er ikke avhengig av serversiden: protokollen legges i systemmeldingen og
 * svaret parses her. Det virker likt mot Nous' API og mot en selvhostet vLLM/SGLang. VERIFISERINGSSTATUS: bevist mot fake server (`hermes-tools.test.ts`); IKKE kjørt mot Nous' ekte API
 * (ingen nøkkel/nettverk i sandkassen) - eieren kjører `mesh-live-smoke.ts --tools` (docs/runbooks/AI_MESH_ACCEPTANCE.md).
 *
 * PARSEREN ER STRENG OG DETERMINISTISK (fail-closed - alt under gir `invalid_tool_call`, aldri utføring og aldri en delvis utførelse av de øvrige kallene i svaret):
 *  - ukjent verktøynavn (ikke i `request.tools` for DENNE forespørselen);
 *  - ugyldig JSON, JSON som ikke er et objekt, ukjente nøkler (kun `name` og `arguments`), `arguments` som ikke er et objekt (en JSON-kodet streng godtas ikke);
 *  - åpnet men ikke lukket `<tool_call>` (typisk avkuttet av `max_tokens`), nestet `<tool_call>`, lukkemerke uten åpning;
 *  - flere enn `HERMES_MAX_TOOL_CALLS` kall, eller en blokk over `HERMES_MAX_BLOCK_CHARS`.
 * Er INGEN verktøy tilbudt i forespørselen, tolkes aldri tagger som kall: fullstendige blokker fjernes fra den synlige teksten og telles (`ignored_blocks`), aldri utført.
 * Tekst inni `<think>` ignoreres (et kall som bare står i resonneringen er ikke et kall).
 *
 * INJEKSJONSVERN: verktøyoutput (ubetrodd data) legges i `<tool_response>` som det maskinlesbare DATA-envelopet (Del 3, JARVIS-002), og protokoll-taggene (`<tool_call`, `</tool_response` m.fl.) i
 * all data vi selv setter i prompten skrives som `<...` (JSON-escape, tapsfritt) - data kan dermed ikke lukke blokken sin eller forfalske et kall. Modellen kan likevel selv gjenta tagger i et
 * svar; derfor er navnesjekken over det som faktisk avgjør, og gatewayen validerer skjema og utfører kun via trusted executor (Policy/bekreftelse).
 */
export const HERMES_MAX_TOOL_CALLS = 16;
export const HERMES_MAX_BLOCK_CHARS = 100_000;

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const PROTOCOL_TAG = /<(\/?(?:tool_call|tool_response|tools|think)\b)/gi;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Skriver protokoll-tagger i (allerede JSON-serialisert) tekst som `<...`: gyldig JSON, tapsfritt, men ikke lenger en tagg. */
export function neutralizeProtocolTags(json: string): string {
  return json.replace(PROTOCOL_TAG, "\\u003c$1");
}

/** Systemmelding-blokken som tilbyr verktøyene (modellkortets format). Legges ETTER Jarvis' egen systemprompt. */
export function renderHermesToolsSystemBlock(tools: readonly ToolDefinition[]): string {
  const signatures = neutralizeProtocolTags(
    JSON.stringify(tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })))
  );
  return [
    "You may call one or more functions to assist with the user's request. The available function signatures are provided within <tools></tools> XML tags. Do not make assumptions about what values to plug into functions.",
    "<tools>",
    signatures,
    "</tools>",
    "For each function call, return a JSON object with the function name and its arguments within <tool_call></tool_call> XML tags, exactly like this:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
    "Only call functions listed in <tools>. If no function is needed, answer normally without any <tool_call> tags."
  ].join("\n");
}

export function renderHermesToolCallBlock(call: Pick<ToolCallRequest, "tool_name" | "arguments">): string {
  return `${OPEN}\n${neutralizeProtocolTags(JSON.stringify({ name: call.tool_name, arguments: call.arguments }))}\n${CLOSE}`;
}

/** Resultatet i modellkortets `{"name": ..., "content": ...}`-form; innholdet er DATA-envelopet (aldri instruksjoner). */
export function renderHermesToolResponseBlock(result: ToolResultMessage): string {
  return `<tool_response>\n${neutralizeProtocolTags(JSON.stringify({ name: result.tool_name, content: renderToolResult(result) }))}\n</tool_response>`;
}

/**
 * Tidligere verktøyrunder → meldinger: assistenten gjentar kallene sine som `<tool_call>`-blokker, og resultatene kommer som `user`-melding med `<tool_response>`-blokker (i samme rekkefølge som kallene).
 * `user` (ikke `tool`) fordi rollen `tool` krever en forutgående `tool_calls` hos strengt OpenAI-kompatible servere; en `user`-melding er gyldig overalt.
 */
export function hermesToolReplayMessages(exchanges: readonly ToolExchange[] | undefined): Array<{ role: "assistant" | "user"; content: string }> {
  const out: Array<{ role: "assistant" | "user"; content: string }> = [];
  for (const ex of exchanges ?? []) {
    out.push({ role: "assistant", content: ex.calls.map(renderHermesToolCallBlock).join("\n") });
    out.push({ role: "user", content: ex.results.map(renderHermesToolResponseBlock).join("\n") });
  }
  return out;
}

/** Avvisningsårsak fra parseren (kode, aldri innhold). Adapteren gjør den om til `ProviderError("invalid_tool_call")`. */
export class HermesToolParseError extends Error {
  constructor(readonly code: string) {
    super(`hermes_tool_parse:${code}`);
    this.name = "HermesToolParseError";
  }
}

export interface ParsedHermesOutput {
  /** Synlig tekst uten `<think>` og uten `<tool_call>`-blokker. */
  text: string;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Fullstendige `<tool_call>`-blokker som ble fjernet uten å bli tolket fordi ingen verktøy var tilbudt. */
  ignored_blocks: number;
}

function parseBlock(inner: string, known: ReadonlySet<string>): { name: string; arguments: Record<string, unknown> } {
  if (inner.length > HERMES_MAX_BLOCK_CHARS) throw new HermesToolParseError("block_too_large");
  let value: unknown;
  try {
    value = JSON.parse(inner.trim());
  } catch {
    throw new HermesToolParseError("invalid_json");
  }
  if (!isPlainObject(value)) throw new HermesToolParseError("not_an_object");
  if (Object.keys(value).some((key) => key !== "name" && key !== "arguments")) throw new HermesToolParseError("unexpected_keys");
  const name = value["name"];
  if (typeof name !== "string" || !known.has(name)) throw new HermesToolParseError("unknown_tool");
  const args = value["arguments"] === undefined ? {} : value["arguments"];
  if (!isPlainObject(args)) throw new HermesToolParseError("invalid_arguments");
  return { name, arguments: args };
}

/** Parser modellens svartekst etter reglene i filhodet. Kaster `HermesToolParseError` (aldri et delvis resultat). */
export function parseHermesOutput(raw: string, tools: readonly ToolDefinition[] | undefined): ParsedHermesOutput {
  const visible = stripThinking(raw);
  if (tools === undefined || tools.length === 0) {
    // Ingen verktøy tilbudt: tagger er aldri kall. Fullstendige blokker fjernes (telles); en uavsluttet tagg i vanlig tekst får stå.
    // Lineær skanning med indexOf, ikke `/<tool_call>[\s\S]*?<\/tool_call>/g`: mange uavsluttede `<tool_call>` ga kvadratisk tid på en lang respons (220 000 tegn ≈ 1,7 s synkront). Samme resultat som regex-en
    // (låst av differensialtesten i `wpd4-linear-parsers.test.ts`): finnes ingen avslutning etter en åpning, finnes den heller ikke etter noen senere åpning.
    let ignored = 0;
    const kept: string[] = [];
    let skipFrom = 0;
    for (;;) {
      const open = visible.indexOf(OPEN, skipFrom);
      const close = open === -1 ? -1 : visible.indexOf(CLOSE, open + OPEN.length);
      if (close === -1) {
        kept.push(visible.slice(skipFrom));
        break;
      }
      kept.push(visible.slice(skipFrom, open));
      ignored += 1;
      skipFrom = close + CLOSE.length;
    }
    return { text: kept.join("").trim(), calls: [], ignored_blocks: ignored };
  }
  const known = new Set(tools.map((t) => t.name));
  const pieces: string[] = [];
  const calls: ParsedHermesOutput["calls"] = [];
  let position = 0;
  for (;;) {
    const open = visible.indexOf(OPEN, position);
    const stretch = visible.slice(position, open === -1 ? undefined : open);
    if (stretch.includes(CLOSE)) throw new HermesToolParseError("stray_close_tag");
    pieces.push(stretch);
    if (open === -1) break;
    const close = visible.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) throw new HermesToolParseError("unterminated_tool_call");
    const inner = visible.slice(open + OPEN.length, close);
    if (inner.includes(OPEN)) throw new HermesToolParseError("nested_tool_call");
    if (calls.length >= HERMES_MAX_TOOL_CALLS) throw new HermesToolParseError("too_many_tool_calls");
    calls.push(parseBlock(inner, known));
    position = close + CLOSE.length;
  }
  return { text: pieces.join("").trim(), calls, ignored_blocks: 0 };
}
