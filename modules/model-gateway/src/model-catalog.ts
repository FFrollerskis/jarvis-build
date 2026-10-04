import type { PricingTable } from "./pricing.ts";

/**
 * D-399 (modellrådgiver): Jarvis EIER modellkatalogen (CORE/adapter-grensen, regel 12) - hvilke modeller finnes per leverandør, hvilket TRINN de hører til og hva de koster.
 * En rådgiver (heuristisk i dag, evt. Jev-lignende senere) kan bare ANBEFALE et trinn/en modell; katalogen + deterministisk utvalg + ruteren avgjør hva som er lov.
 *
 * Trinn (laveste først): `fast` (billig/rask, enkle oppgaver) < `standard` (daglig arbeidshest, f.eks. Sonnet) < `heavy` < `frontier` (dyreste, f.eks. Fable - kun når oppgaven krever det).
 * Prinsipp: BILLIGST SOM HOLDER - ikke «best tilgjengelig».
 */
export type ModelTier = "fast" | "standard" | "heavy" | "frontier";
export const TIER_ORDER: readonly ModelTier[] = ["fast", "standard", "heavy", "frontier"];

export interface CatalogModel {
  provider: string;
  model: string;
  tier: ModelTier;
  /** Relativ kost 1 (billigst) - 5 (dyrest) - brukes til å velge BILLIGST innen samme trinn. */
  cost_class: 1 | 2 | 3 | 4 | 5;
}

/**
 * Standardkatalog. En modell kan KUN velges per kall når den har en EKSPLISITT pris (`provider:model` i pristabellen) eller er leverandørens konfigurerte standardmodell
 * (dekket av leverandørnivå-raden). Ukjent pris => aldri valgbar (ellers ville en dyr modell bli bokført til en billig sats og budsjettgrensen miste mening).
 * Modell-id-ene følger leverandørenes egne navn; legg til/endre via `JARVIS_MODEL_CATALOG` (JSON) og priser via `JARVIS_MODEL_PRICING` (JSON).
 */
export const DEFAULT_MODEL_CATALOG: readonly CatalogModel[] = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", tier: "fast", cost_class: 1 },
  { provider: "anthropic", model: "claude-sonnet-5-5", tier: "standard", cost_class: 3 },
  { provider: "anthropic", model: "claude-opus-5-5", tier: "heavy", cost_class: 4 },
  { provider: "anthropic", model: "claude-fable-5-1", tier: "frontier", cost_class: 5 },
  { provider: "openai", model: "gpt-4o-mini", tier: "fast", cost_class: 1 },
  { provider: "openai", model: "gpt-5", tier: "standard", cost_class: 3 }
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export class InvalidModelCatalogError extends Error {
  constructor(detail: string) {
    super(`invalid_model_catalog: ${detail}`);
    this.name = "InvalidModelCatalogError";
  }
}

/** Validerer en katalog (fra env/konfig). Kaster ved ugyldig oppføring - aldri stille ignorering. */
export function parseModelCatalog(raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) throw new InvalidModelCatalogError("forventet en liste");
  const seen = new Set<string>();
  return raw.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (typeof o?.["provider"] !== "string" || !/^[a-z0-9_]{1,40}$/.test(o["provider"])) throw new InvalidModelCatalogError(`#${i}: provider`);
    if (typeof o["model"] !== "string" || !MODEL_ID.test(o["model"])) throw new InvalidModelCatalogError(`#${i}: model`);
    if (!TIER_ORDER.includes(o["tier"] as ModelTier)) throw new InvalidModelCatalogError(`#${i}: tier`);
    if (![1, 2, 3, 4, 5].includes(o["cost_class"] as number)) throw new InvalidModelCatalogError(`#${i}: cost_class`);
    const key = `${o["provider"]}:${o["model"]}`;
    if (seen.has(key)) throw new InvalidModelCatalogError(`#${i}: duplikat ${key}`);
    seen.add(key);
    return { provider: o["provider"], model: o["model"], tier: o["tier"] as ModelTier, cost_class: o["cost_class"] as CatalogModel["cost_class"] };
  });
}

export function modelCatalogFromEnv(env: Record<string, string | undefined> = process.env): CatalogModel[] {
  const raw = env["JARVIS_MODEL_CATALOG"]?.trim();
  if (!raw) return [...DEFAULT_MODEL_CATALOG];
  try {
    return parseModelCatalog(JSON.parse(raw));
  } catch (err) {
    if (err instanceof InvalidModelCatalogError) throw err;
    throw new InvalidModelCatalogError("JARVIS_MODEL_CATALOG er ikke gyldig JSON");
  }
}

/** Er modellen valgbar per kall? Eksplisitt pris, eller leverandørens konfigurerte standardmodell. */
export function isModelSelectable(
  entry: CatalogModel,
  pricing: PricingTable,
  providerDefaultModel: string | undefined
): boolean {
  return pricing.rates[`${entry.provider}:${entry.model}`] !== undefined || entry.model === providerDefaultModel;
}

export function tierIndex(t: ModelTier): number {
  return TIER_ORDER.indexOf(t);
}
