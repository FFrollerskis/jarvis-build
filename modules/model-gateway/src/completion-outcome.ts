import type { ModelResult } from "@jarvis/provider-adapters";

/**
 * D-106 PR #53 (ModelGateway "functional success"-invariant): et provider-
 * kall kan lykkes på TRANSPORT-nivå (HTTP 200, gyldig JSON-body) uten å
 * produsere noe BRUKBART for Jarvis. Live-bevis (2026-08-23, kimi-k3,
 * `max_tokens: 200`): `finish_reason=length`, `usage.output_tokens=200`
 * (nøyaktig taket), synlig tekst tom - hele budsjettet gikk til skjulte
 * resonnement-tokens. `ModelGateway.executePlan()` skal ALDRI klassifisere
 * dette som suksess bare fordi ingen feil ble kastet.
 */
export type CompletionOutcome = "USABLE_SUCCESS" | "EMPTY_OUTPUT" | "TRUNCATED_NO_USABLE_OUTPUT";

/**
 * Kjente rå `finish_reason`-verdier på tvers av leverandører som betyr
 * "avbrutt fordi output-token-budsjettet ble brukt opp" - IKKE en naturlig
 * modell-avslutning. Leverandør-nøytral liste, verifisert mot hver
 * adapters egen normalisering (openai/kimi/local-llm/ollama: `"length"`;
 * anthropic: `"max_tokens"`; gemini/gemma: `"MAX_TOKENS"`) - bevisst IKKE en
 * `if (provider === "kimi")`-sjekk (§4: "Do NOT create provider-specific
 * if kimi logic").
 */
const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set(["length", "max_tokens", "MAX_TOKENS"]);

export function isTruncationFinishReason(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_FINISH_REASONS.has(finishReason);
}

/**
 * §2: usable success = ikke-tom synlig tekst, ELLER gyldig(e) tool call(s),
 * ELLER et faktisk parset `structured_output`. Whitespace-only tekst telles
 * som tom (§6-E). Skjulte resonnement-tokens (kun synlig i `usage.output_tokens`)
 * teller ALDRI som synlig innhold - de eksponeres uansett aldri til callere.
 */
export function isFunctionalSuccess(result: ModelResult): boolean {
  if (result.text.trim().length > 0) return true;
  if (result.tool_calls !== undefined && result.tool_calls.length > 0) return true;
  if (result.structured_output !== undefined) return true;
  return false;
}

/**
 * §3: kanonisk utfallsklassifisering for et IKKE-kastet providersvar.
 * `EMPTY_OUTPUT` (finish_reason stop/annet, ingen budsjett-signal) er IKKE
 * et retry-kandidat (§4: retry er betinget av at finish_reason indikerer
 * budsjett-uttømming); `TRUNCATED_NO_USABLE_OUTPUT` er det.
 */
export function classifyCompletionOutcome(result: ModelResult): CompletionOutcome {
  if (isFunctionalSuccess(result)) return "USABLE_SUCCESS";
  if (isTruncationFinishReason(result.finish_reason)) return "TRUNCATED_NO_USABLE_OUTPUT";
  return "EMPTY_OUTPUT";
}

const ADAPTIVE_RETRY_MAX_TOKENS_MULTIPLIER = 4;
const ADAPTIVE_RETRY_MAX_TOKENS_FLOOR = 2048;
const ADAPTIVE_RETRY_MAX_TOKENS_CEILING = 8192;

/**
 * §4: deterministisk, evidensbasert - ALDRI en gjetning (D-41-disiplinen
 * gjelder her også). Grunnlaget er hvor mange output-tokens leverandøren
 * FAKTISK brukte opp (`usage.output_tokens`, det eneste sanne beviset for
 * hvor stort det egentlige behovet er), kombinert med hva som var
 * konfigurert (`request.max_tokens`, hvis satt) - multiplisert med en fast
 * faktor og klemt mellom et gulv og et tak, slik at det ENE begrensede
 * retry-forsøket aldri kan bli en ukontrollert kostnadseksplosjon.
 */
export function computeAdaptiveRetryMaxTokens(result: ModelResult, request: { max_tokens?: number }): number {
  const consumed = result.usage.output_tokens;
  const priorCeiling = request.max_tokens ?? consumed;
  const evidenceBased = Math.max(consumed, priorCeiling) * ADAPTIVE_RETRY_MAX_TOKENS_MULTIPLIER;
  return Math.min(Math.max(evidenceBased, ADAPTIVE_RETRY_MAX_TOKENS_FLOOR), ADAPTIVE_RETRY_MAX_TOKENS_CEILING);
}
