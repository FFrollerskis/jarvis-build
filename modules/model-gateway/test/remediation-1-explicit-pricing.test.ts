import { describe, expect, it } from "vitest";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import {
  assertExplicitPricing,
  assertProvidersHaveExplicitPricing,
  CapabilityRegistry,
  costOre,
  DEFAULT_PRICING,
  DEFAULT_PROFILES,
  MemoryTraceSink,
  MissingExplicitPricingError,
  ModelGateway,
  rateFor,
  type PricingTable
} from "../src/index.ts";

/**
 * Remediering del 1 / JARVIS-006: `gemma_local` hadde ingen prisrad og falt til
 * `default_rate` (30/150 øre per 1k) - fantomforbruk som traff 3 000-kr-
 * hardgrensen. Disse testene låser at ALLE registrerte modellprofiler har en
 * eksplisitt pris, og at lokale modeller aldri kan ha en API-kostnad.
 */
describe("JARVIS-006: eksplisitt pris for alle registrerte modeller", () => {
  it("hver DEFAULT_PROFILE har en eksplisitt rad i DEFAULT_PRICING (aldri default_rate)", () => {
    for (const profile of DEFAULT_PROFILES) {
      const rate = rateFor(DEFAULT_PRICING, profile.provider, profile.model);
      expect(rate, `provider ${profile.provider}`).not.toBe(DEFAULT_PRICING.default_rate);
    }
    expect(() => assertExplicitPricing(DEFAULT_PRICING, DEFAULT_PROFILES)).not.toThrow();
  });

  it("gemma_local er registrert som LOCAL med 0 øre - et 48k-token verktøyskjema koster 0", () => {
    const rate = rateFor(DEFAULT_PRICING, "gemma_local", "gemma-local");
    expect(rate.pricing_mode).toBe("LOCAL");
    expect(rate.input_per_1k_ore).toBe(0);
    expect(rate.output_per_1k_ore).toBe(0);
    expect(costOre(DEFAULT_PRICING, "gemma_local", "gemma-local", { input_tokens: 48_000, output_tokens: 2_000 })).toBe(0);
  });

  it("alle lokale profiler er LOCAL/0 - ingen lokal provider kan produsere API-kostnad", () => {
    for (const profile of DEFAULT_PROFILES.filter((p) => p.locality === "local")) {
      const rate = rateFor(DEFAULT_PRICING, profile.provider, profile.model);
      expect(rate.pricing_mode, profile.provider).toBe("LOCAL");
      expect(costOre(DEFAULT_PRICING, profile.provider, profile.model, { input_tokens: 100_000, output_tokens: 10_000 })).toBe(0);
    }
  });

  it("assertExplicitPricing avviser en registrert provider uten rad (ville falt til default_rate)", () => {
    const table: PricingTable = { ...DEFAULT_PRICING, rates: { ...DEFAULT_PRICING.rates } };
    delete table.rates["gemma_local"];
    expect(() => assertExplicitPricing(table, DEFAULT_PROFILES)).toThrow(MissingExplicitPricingError);
    try {
      assertExplicitPricing(table, DEFAULT_PROFILES);
    } catch (err) {
      expect((err as MissingExplicitPricingError).missing).toEqual(["gemma_local"]);
    }
  });

  it("assertExplicitPricing avviser en LOKAL provider med ikke-null pris", () => {
    const table: PricingTable = {
      ...DEFAULT_PRICING,
      rates: { ...DEFAULT_PRICING.rates, gemma_local: { input_per_1k_ore: 30, output_per_1k_ore: 150, pricing_mode: "PAID" } }
    };
    expect(() => assertExplicitPricing(table, DEFAULT_PROFILES)).toThrow(/lokal provider/);
  });

  it("ModelGateway nekter å konstrueres når registryet inneholder en upriset modell", () => {
    const registry = new CapabilityRegistry([
      ...DEFAULT_PROFILES,
      {
        provider: "mystery_local",
        model: "m1",
        capabilities: ["text"],
        context_tokens: 8_000,
        locality: "local",
        cost_class: 1,
        quality_class: 1,
        latency_class: "fast"
      }
    ]);
    expect(
      () =>
        new ModelGateway({
          pool: {} as never,
          trace: new MemoryTraceSink(),
          providers: [new ScriptedAdapter()],
          registry
        })
    ).toThrow(MissingExplicitPricingError);
  });

  it("ModelGateway med standard registry/pris konstrueres uten feil", () => {
    expect(
      () => new ModelGateway({ pool: {} as never, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter()] })
    ).not.toThrow();
  });

  it("assertProvidersHaveExplicitPricing: produksjons-adapternavn uten rad avvises", () => {
    expect(() =>
      assertProvidersHaveExplicitPricing(DEFAULT_PRICING, ["openai", "anthropic", "gemma_local", "hermes"])
    ).not.toThrow();
    expect(() => assertProvidersHaveExplicitPricing(DEFAULT_PRICING, ["gemma_local", "brand_new_provider"])).toThrow(
      /brand_new_provider/
    );
  });
});
