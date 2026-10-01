import type { RouterMode } from "@jarvis/contracts";

/**
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse §"user routing
 * overrides"): 100% deterministisk fraseparsing - INGEN LLM brukes til å
 * tolke en routing-instruksjon (samme "en modell kan aldri velge seg selv"-
 * prinsipp som `AiRouter` selv, §35 i router.ts). Ren funksjon, ingen I/O,
 * lett testbar med en fasttabell (samme D-53-presedens: deterministisk regel
 * fremfor semantisk gjetning der en enkel regel dekker det faktiske behovet).
 *
 * Dekker MINST de eksplisitte frasene fra ordren: "bruk bare Claude"/"bruk
 * OpenAI"/"bruk Gemini"/"bruk Kimi"/"bruk Gemma"/"bruk alle AI-ene"/"ikke
 * bruk betalte modeller"/"bruk bare lokale modeller"/"velg den beste
 * modellen". Returnerer `null` når ingen kjent frase treffer - kalleren
 * (ConversationEngine) bruker da vanlig AUTO-ruting uendret.
 *
 * Skalerer ALDRI til å omgå sikkerhetspolicy/tenant-isolasjon/leverandør-
 * begrensninger/autorisasjonskrav (§ordre-krav): dette produserer KUN et
 * `RoutingOverrideIntent`-objekt som `AiRouter`/`ModelGateway` fortsatt
 * håndhever alle eksisterende gates mot (sensitivity/paid_models_allowed/
 * capability) - se `router.ts`. En bruker kan ikke "si seg forbi" en
 * SECRET_RESTRICTED-sensitivitetsgate eller en avslått
 * `paid_models_allowed=false`-policy via tekst.
 *
 * Kjent, eksplisitt DEFERRED begrensning (Q-26-ærlighet, ikke skjult): denne
 * parseren virker PER SAMTALETUR (én `CompleteInput`/ett tool-loop/én
 * council-/collaboration-kjøring) - den persisterer IKKE automatisk en
 * "bruk bare Claude"-preferanse over flere fremtidige samtaleturer. Det ville
 * kreve et sesjonsskopet preferanselager, som ikke er bygget i denne runden.
 */
export interface RoutingOverrideIntent {
  mode?: RouterMode;
  provider?: string;
  providerPreference?: string[];
  paid_models_allowed?: boolean;
  triggerCouncil?: boolean;
  /**
   * D-106 HOST-FIX (§"USER OVERRIDES"): eksplisitt eier-frase om å IKKE bruke
   * AI-rådet ("ikke bruk AI-rådet"/"don't use the council"). Sjekket FØR
   * `COUNCIL_PATTERNS` (ellers ville "ikke bruk AI-rådet" feilaktig matchet
   * "bruk AI-rådet" som substring). `ConversationEngine` bruker denne til å
   * la eieren eksplisitt undertrykke et policy-mandatert høy-innvirkning-
   * Council-triggeret (se `decision-importance.ts`) - ALDRI en skjult
   * begrensning på eierens autoritet, kun en eksplisitt, auditerbar
   * overstyring NÅR eieren faktisk sier det.
   */
  suppressCouncil?: boolean;
  /** Auditerbart: hvilken frase som faktisk trigget - aldri en LLM-generert forklaring. */
  matched_phrase: string;
}

interface ProviderPhraseEntry {
  patterns: RegExp[];
  provider?: string;
  providerPreference?: string[];
}

const NO_COUNCIL_PATTERNS: RegExp[] = [
  /\bikke\s+bruke?\s+ai[- ]?r[åa]det\b/i,
  /\bikke\s+bruke?\s+alle\s+ai(-ene)?\b/i,
  /\bikke\s+sp[øo]r\s+alle\s+ai(-ene)?\b/i,
  /\bdon'?t\s+use\s+the\s+(ai\s+)?council\b/i,
  /\bdo\s+not\s+use\s+the\s+(ai\s+)?council\b/i
];

const COUNCIL_PATTERNS: RegExp[] = [
  /\bbruke?\s+ai[- ]?r[åa]det\b/i,
  /\bsp[øo]r\s+alle\s+ai(-ene)?\b/i,
  /\bbruke?\s+alle\s+ai(-ene)?\b/i,
  /\bbruke?\s+hele\s+ai[- ]?r[åa]det\b/i
];

const LOCAL_ONLY_PATTERNS: RegExp[] = [
  /\bbruke?\s+(bare|kun)\s+lokale\s+modeller\b/i,
  /\bkun\s+lokale?\s+modell(er)?\b/i
];

const NO_PAID_PATTERNS: RegExp[] = [
  /\bikke\s+bruk\s+betalte\s+modeller\b/i,
  /\buten\s+betalte\s+modeller\b/i
];

const BEST_MODEL_PATTERNS: RegExp[] = [
  /\bvelg\s+den\s+beste\s+modellen\b/i,
  /\bbruke?\s+den\s+beste\s+modellen\b/i
];

/** Rekkefølge betyr ikke noe her - hver oppføring er et distinkt provider-navn/preferanse. */
const PROVIDER_PHRASES: ProviderPhraseEntry[] = [
  { patterns: [/\bbruke?\s+(bare\s+|kun\s+)?claude\b/i], provider: "anthropic" },
  { patterns: [/\bbruke?\s+(bare\s+|kun\s+)?openai\b/i, /\bbruke?\s+(bare\s+|kun\s+)?gpt\b/i], provider: "openai" },
  { patterns: [/\bbruke?\s+(bare\s+|kun\s+)?gemini\b/i], provider: "gemini" },
  { patterns: [/\bbruke?\s+(bare\s+|kun\s+)?kimi\b/i], provider: "kimi" },
  { patterns: [/\bbruke?\s+(bare\s+|kun\s+)?hermes\b/i], provider: "hermes" },
  {
    // "Gemma" er en modellFAMILIE, ikke en enkelt providerinstans - kan kjøre
    // lokalt (D-106 `gemma_local`) eller hostet (D-80 `gemma_hosted`).
    // Preferanserekkefølge lar `AiRouter` velge den første som faktisk er
    // konfigurert/kvalifisert (§10-prinsippet, se router.ts `providerPreference`).
    patterns: [/\bbruke?\s+(bare\s+|kun\s+)?gemma\b/i],
    providerPreference: ["gemma_local", "gemma_hosted"]
  }
];

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Deterministisk fraseparsing. Sjekker AI-rådet-triggeren FØRST (siden "bruk
 * alle AI-ene" ellers kunne mistolkes som et forsøk på en enkelt
 * provider-frase), deretter policy-frasene, deretter enkelt-provider-frasene.
 * Returnerer KUN første treff (§10: forutsigbarhet - en tekst med flere
 * motstridende instruksjoner behandles ikke som en kombinasjon).
 */
export function parseRoutingOverride(text: string): RoutingOverrideIntent | null {
  // §"USER OVERRIDES": sjekkes FØR COUNCIL_PATTERNS - "ikke bruk AI-rådet"
  // inneholder "bruk AI-rådet" som substring og ville ellers blitt feiltolket
  // som en TRIGGER i stedet for en undertrykkelse.
  const noCouncilMatch = firstMatch(text, NO_COUNCIL_PATTERNS);
  if (noCouncilMatch) {
    return { suppressCouncil: true, matched_phrase: noCouncilMatch };
  }
  const councilMatch = firstMatch(text, COUNCIL_PATTERNS);
  if (councilMatch) {
    return { triggerCouncil: true, matched_phrase: councilMatch };
  }
  const localMatch = firstMatch(text, LOCAL_ONLY_PATTERNS);
  if (localMatch) {
    return { mode: "LOCAL", matched_phrase: localMatch };
  }
  const noPaidMatch = firstMatch(text, NO_PAID_PATTERNS);
  if (noPaidMatch) {
    return { paid_models_allowed: false, matched_phrase: noPaidMatch };
  }
  const bestMatch = firstMatch(text, BEST_MODEL_PATTERNS);
  if (bestMatch) {
    return { mode: "QUALITY", matched_phrase: bestMatch };
  }
  for (const entry of PROVIDER_PHRASES) {
    const match = firstMatch(text, entry.patterns);
    if (match) {
      return {
        ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
        ...(entry.providerPreference !== undefined ? { providerPreference: entry.providerPreference } : {}),
        matched_phrase: match
      };
    }
  }
  return null;
}
