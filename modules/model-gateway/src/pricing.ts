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
  version: "2026-10.1",
  updated_at: "2026-10-01",
  rates: {
    "openai:gpt-4o-mini": { input_per_1k_ore: 0.2, output_per_1k_ore: 0.7, cached_per_1k_ore: 0.1, pricing_mode: "PAID" },
    "openai:gpt-5": { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5, cached_per_1k_ore: 0.2, pricing_mode: "PAID" },
    openai: { input_per_1k_ore: 1.4, output_per_1k_ore: 10.5, pricing_mode: "PAID" },
    // D-399: Sonnet 5.5 har SAMME sats som leverandørnivå-raden under (raden er satt for Sonnet-klassen) - eksplisitt slik at den er valgbar per kall. Øvrige Anthropic-modeller
    // (Haiku/Opus/Fable) har bevisst IKKE en rad før eier har bekreftet prisen (`JARVIS_MODEL_PRICING`) - uten pris er de aldri valgbare.
    // D-431: Sonnet 5.5 koster $2 / $10 per million (Anthropic sin prisside, verifisert 2026-10-07; cache-lesing $0,20) - tidligere rad (3,2 / 15,8) var for høy og ga overbokført kostnad. Omregnet med ca. 10,5 kr/USD.
    "anthropic:claude-sonnet-5-5": { input_per_1k_ore: 2.1, output_per_1k_ore: 10.5, cached_per_1k_ore: 0.21, pricing_mode: "PAID", pricing_verified_at: "2026-10-07" },
    // D-431: Haiku 4.5 ($1 / $5 per million, cache-lesing $0,10; verifisert 2026-10-07) - eksplisitt rad gjør den valgbar per kall.
    "anthropic:claude-haiku-4-5-20251001": { input_per_1k_ore: 1.05, output_per_1k_ore: 5.25, cached_per_1k_ore: 0.105, pricing_mode: "PAID", pricing_verified_at: "2026-10-07" },
    anthropic: { input_per_1k_ore: 3.2, output_per_1k_ore: 15.8, cached_per_1k_ore: 0.4, pricing_mode: "PAID" },
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
    kimi: { input_per_1k_ore: 0.7, output_per_1k_ore: 3.2, pricing_mode: "PAID" },
    // D-360: Nous Portal sin offisielle $/1M-token-rate for Hermes-4-70B
    // ($0.093 input / $0.373 output) - WebSearch-verifisert (pricepertoken.com),
    // direkte WebFetch mot nousresearch.com-domener var nettverks-blokkert i
    // denne sandkassen (samme forbehold-mønster som D-106s Gemini-oppdatering
    // over). Konvertert med filens egen ca. 10,5 kr/USD: $0.000093/1k*10.5≈
    // 0.098 øre input, $0.000373/1k*10.5≈0.392 øre output.
    hermes: {
      input_per_1k_ore: 0.1,
      output_per_1k_ore: 0.39,
      pricing_mode: "PAID",
      pricing_verified_at: "2026-10-01"
    },
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
    local_llm: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" },
    // JARVIS-006 / Remediering del 1: `gemma_local` (standard chat-/minnemodell,
    // Tobias sin egen PC) hadde INGEN rad og falt derfor til `default_rate`
    // (30/150 øre per 1k) - fantomkostnad som traff 3 000-kr-hardgrensen.
    // Lokal inferens har ALDRI en API-kostnad (se `local_llm` over).
    gemma_local: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" },
    // Deterministisk testprovider (ScriptedAdapter): aldri en reell kostnad.
    scripted: { input_per_1k_ore: 0, output_per_1k_ore: 0, pricing_mode: "LOCAL" }
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

export class MissingExplicitPricingError extends Error {
  constructor(readonly missing: string[], readonly violations: string[] = []) {
    super(
      [
        missing.length > 0 ? `mangler eksplisitt pris for: ${missing.join(", ")}` : "",
        violations.length > 0 ? `lokal provider med ikke-null API-pris: ${violations.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; ")
    );
    this.name = "MissingExplicitPricingError";
  }
}

/**
 * JARVIS-006: `default_rate` (30/150 øre per 1k) er en bevisst konservativ
 * sats for UKJENTE betalte leverandører - men den ble i praksis også brukt for
 * en REGISTRERT lokal modell (`gemma_local`) og produserte fantomforbruk.
 * Hver registrert provider MÅ derfor ha en eksplisitt rad (`provider` eller
 * `provider:model`), og en lokal provider MÅ være `pricing_mode: "LOCAL"` med
 * 0 øre (lokal inferens har aldri en API-kostnad; infrastrukturkost er en
 * separat, ikke-modellert kategori).
 */
export function assertExplicitPricing(
  table: PricingTable,
  profiles: ReadonlyArray<{ provider: string; model: string; locality: "local" | "cloud" }>
): void {
  const missing: string[] = [];
  const violations: string[] = [];
  for (const p of profiles) {
    const rate = table.rates[`${p.provider}:${p.model}`] ?? table.rates[p.provider];
    if (!rate) {
      missing.push(p.provider);
      continue;
    }
    if (p.locality === "local" && (rate.pricing_mode !== "LOCAL" || rate.input_per_1k_ore !== 0 || rate.output_per_1k_ore !== 0)) {
      violations.push(p.provider);
    }
  }
  if (missing.length > 0 || violations.length > 0) {
    throw new MissingExplicitPricingError(missing, violations);
  }
}

/** Streng variant for produksjonsoppstart: hvert faktisk konstruert adapter-navn må ha eksplisitt pris. */
export function assertProvidersHaveExplicitPricing(table: PricingTable, providerNames: readonly string[]): void {
  const missing = providerNames.filter((name) => {
    const hasProvider = table.rates[name] !== undefined;
    const hasModelSpecific = Object.keys(table.rates).some((k) => k.startsWith(`${name}:`));
    return !hasProvider && !hasModelSpecific;
  });
  if (missing.length > 0) {
    throw new MissingExplicitPricingError(missing);
  }
}

/**
 * D-399: eier-bekreftede modellpriser via `JARVIS_MODEL_PRICING` (JSON: `{"anthropic:claude-fable-5-1": {"input_per_1k_ore": ..., "output_per_1k_ore": ...}}`).
 * Flettes OVER standardtabellen. Ugyldige oppføringer kaster (aldri stille ignorering - en feil pris er verre enn ingen pris).
 */
export function pricingFromEnv(base: PricingTable = DEFAULT_PRICING, env: Record<string, string | undefined> = process.env): PricingTable {
  const raw = env["JARVIS_MODEL_PRICING"]?.trim();
  if (!raw) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_model_pricing: JARVIS_MODEL_PRICING er ikke gyldig JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_model_pricing: forventet et objekt");
  const rates: Record<string, TokenRate> = { ...base.rates };
  for (const [key, v] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    if (!/^[a-z0-9_]{1,40}:[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key)) throw new Error(`invalid_model_pricing: nøkkel '${key}' må være provider:model`);
    const inp = Number(v?.["input_per_1k_ore"]);
    const out = Number(v?.["output_per_1k_ore"]);
    if (!Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) throw new Error(`invalid_model_pricing: ${key} mangler gyldige satser`);
    const cached = v?.["cached_per_1k_ore"] !== undefined ? Number(v["cached_per_1k_ore"]) : undefined;
    rates[key] = { input_per_1k_ore: inp, output_per_1k_ore: out, ...(cached !== undefined && Number.isFinite(cached) ? { cached_per_1k_ore: cached } : {}), pricing_mode: "PAID" };
  }
  return { ...base, rates };
}
