/**
 * UA-1 pricing-abstraksjon (BO-08 §14): priser i NOK-øre per 1000 tokens,
 * versjonert med dato - provider-priser endrer seg og skal aldri hardkodes
 * spredt i koden. Oppdateres som konfig; router bruker cost_class fra
 * registry (relativ), denne tabellen brukes til faktisk kostberegning.
 */
export interface TokenRate {
  input_per_1k_ore: number;
  output_per_1k_ore: number;
  /** Rabattert pris for cache-treff der provider rapporterer det. */
  cached_per_1k_ore?: number;
  /**
   * D-81 (§7 pris-sannhet): eksplisitt skiller en BEKREFTET NÅVÆRENDE
   * leverandørpris fra en PERMANENT modellegenskap - "gratis i dag" er ALDRI
   * kodet inn som en varig sannhet. `FREE_TIER` = kvotebegrenset gratis-nivå
   * (kan endres/utløpe uten varsel, se `gemma_hosted` under); `PAID` = en
   * betalt tarif; `LOCAL` = ALDRI en API-kostnad (infrastrukturkost er en
   * separat, ikke-modellert kostnadskategori - se §18/`local_llm` under).
   * En fremtidig "AI Market & Cost Optimizer" kan erstatte disse verdiene
   * dynamisk (samme `PricingTable`-injeksjonspunkt som allerede finnes i
   * `GatewayOptions.pricing`) UTEN å skrive om selve rutinglogikken - denne
   * filen er allerede det eneste stedet priser leses fra.
   */
  pricing_mode?: "FREE_TIER" | "PAID" | "LOCAL";
  /** ISO-dato: når denne raten sist ble bekreftet mot leverandørens offisielle prisside/API-dokumentasjon. */
  pricing_verified_at?: string;
}

export interface PricingTable {
  version: string;
  updated_at: string;
  /** Nøkkel: "provider" eller mer spesifikt "provider:model" (mest spesifikk vinner). */
  rates: Record<string, TokenRate>;
  default_rate: TokenRate;
}

/** Grove omregninger (USD→øre ca. 10.5 kr/USD, aug 2026) - konfig, ikke fasit. */
export const DEFAULT_PRICING: PricingTable = {
  version: "2026-08.2",
  updated_at: "2026-08-23",
  rates: {
    "openai:gpt-4o-mini": { input_per_1k_ore: 0.2, output_per_1k_ore: 0.7, cached_per_1k_ore: 0.1 },
    "openai:gpt-5": { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5, cached_per_1k_ore: 0.2 },
    openai: { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5 },
    anthropic: { input_per_1k_ore: 3.2, output_per_1k_ore: 15.8, cached_per_1k_ore: 0.4 },
    // D-106 GEMINI MODEL MIGRATION (2026-08-23): raten var kalibrert for
    // `gemini-2.5-flash` (nå under utfasing, se gemini.ts). `gemini-3.6-flash`
    // sin offisielle pris ($1.50/$7.50 per 1M input/output-tokens,
    // WebSearch-verifisert - direkte WebFetch mot Google sine egne domener
    // var nettverks-blokkert denne økten) er VESENTLIG høyere enn 2.5-flash
    // (~5x input, ~2,9x output) - å beholde den gamle raten etter
    // model-byttet ville gitt systematisk under-sporet kostnad. Konvertert
    // til øre med filens egen ca. 10,5 kr/USD (aug 2026): $0.0015/1k*10.5=
    // 1.575≈1.58 øre input, $0.0075/1k*10.5=7.875≈7.88 øre output,
    // cache-rabatt $0.00015/1k*10.5=0.001575≈0.16 øre (context caching er
    // ekte wiret - `gemini.ts` leser allerede `cachedContentTokenCount` inn
    // i `usage.cached_tokens`).
    gemini: {
      input_per_1k_ore: 1.58,
      output_per_1k_ore: 7.88,
      cached_per_1k_ore: 0.16,
      pricing_mode: "PAID",
      pricing_verified_at: "2026-08-23"
    },
    kimi: { input_per_1k_ore: 0.7, output_per_1k_ore: 3.2 },
    ollama: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" },
    // D-80/D-81: hostet Gemma sin default-modell er gratis-tier (0 øre) PER
    // 2026-08-19 (bekreftet via WebSearch mot Google sin offisielle Gemini
    // API-dokumentasjon, se D-81 i DECISIONS_AND_ASSUMPTIONS.md) - EKSPLISITT
    // markert `pricing_mode: "FREE_TIER"`, IKKE en antakelse om at fremtidige
    // betalte Gemma-tiers også er gratis. Kvotebegrenset gratis-nivå kan
    // endres/utløpe uten varsel - oppdater raten OG `pricing_mode`/
    // `pricing_verified_at` hvis/når en betalt kvote/tier faktisk konfigureres.
    gemma_hosted: {
      input_per_1k_ore: 0,
      output_per_1k_ore: 0,
      pricing_mode: "FREE_TIER",
      pricing_verified_at: "2026-08-19"
    },
    // §18/D-81: lokal inferens har ALDRI en API-kostnad (`pricing_mode: "LOCAL"`)
    // - infrastrukturkost (strøm/maskinvare/drift) er en SEPARAT, ikke-modellert
    // kostnadskategori, ALDRI oppdiktet som modell-øre her. "API-kostnad 0" er
    // IKKE det samme som "total driftskostnad 0".
    local_llm: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" }
  },
  default_rate: { input_per_1k_ore: 30, output_per_1k_ore: 150 }
};

export function rateFor(table: PricingTable, provider: string, model: string): TokenRate {
  return table.rates[`${provider}:${model}`] ?? table.rates[provider] ?? table.default_rate;
}

export function costOre(
  table: PricingTable,
  provider: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cached_tokens?: number }
): number {
  const rate = rateFor(table, provider, model);
  const cached = usage.cached_tokens ?? 0;
  const freshInput = Math.max(0, usage.input_tokens - cached);
  return Math.ceil(
    (freshInput / 1000) * rate.input_per_1k_ore +
      (cached / 1000) * (rate.cached_per_1k_ore ?? rate.input_per_1k_ore) +
      (usage.output_tokens / 1000) * rate.output_per_1k_ore
  );
}
