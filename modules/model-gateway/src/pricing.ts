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
  version: "2026-08.1",
  updated_at: "2026-08-13",
  rates: {
    "openai:gpt-4o-mini": { input_per_1k_ore: 0.2, output_per_1k_ore: 0.7, cached_per_1k_ore: 0.1 },
    "openai:gpt-5": { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5, cached_per_1k_ore: 0.2 },
    openai: { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5 },
    anthropic: { input_per_1k_ore: 3.2, output_per_1k_ore: 15.8, cached_per_1k_ore: 0.4 },
    gemini: { input_per_1k_ore: 0.4, output_per_1k_ore: 2.7 },
    kimi: { input_per_1k_ore: 0.7, output_per_1k_ore: 3.2 },
    ollama: { input_per_1k_ore: 0, output_per_1k_ore: 0 },
    // D-79: hostet Gemma sin default-modell er gratis-tier (0 øre) - IKKE en
    // antakelse om at fremtidige betalte Gemma-tiers også er gratis; oppdater
    // raten hvis/når en betalt kvote/tier faktisk konfigureres.
    gemma_hosted: { input_per_1k_ore: 0, output_per_1k_ore: 0 },
    // §18: lokal inferens har ALDRI en API-kostnad (infrastrukturkost spores
    // separat i en fremtidig runde, ALDRI oppdiktet som modell-øre her).
    local_llm: { input_per_1k_ore: 0, output_per_1k_ore: 0 }
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
