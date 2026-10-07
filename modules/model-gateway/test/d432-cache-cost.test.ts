import { describe, expect, it } from "vitest";
import { costOre, DEFAULT_PRICING } from "../src/pricing.ts";

/** D-432: cache-treff koster ca. en tidel, cache-skriving 1,25x - og `input_tokens` er TOTALT inn (treff og skriving inngår). */
describe("D-432: kostnad med prompt-cache (Sonnet 5.5: 2,1 / 10,5 øre per 1k, treff 0,21)", () => {
  const P = "anthropic", M = "claude-sonnet-5-5";
  it("uten cache er regnskapet som før", () => {
    expect(costOre(DEFAULT_PRICING, P, M, { input_tokens: 6400, output_tokens: 250 })).toBe(Math.ceil(6.4 * 2.1 + 0.25 * 10.5));
  });
  it("cache-treff billiggjør prefikset, og skriving koster 1,25x", () => {
    const noCache = costOre(DEFAULT_PRICING, P, M, { input_tokens: 6400, output_tokens: 250 });
    const hit = costOre(DEFAULT_PRICING, P, M, { input_tokens: 6400, output_tokens: 250, cached_tokens: 4500 });
    expect(hit).toBeLessThan(noCache * 0.6);
    const write = costOre(DEFAULT_PRICING, P, M, { input_tokens: 6400, output_tokens: 250, cache_write_tokens: 4500 });
    expect(write).toBe(Math.ceil(1.9 * 2.1 + 4.5 * 2.1 * 1.25 + 0.25 * 10.5));
    expect(write).toBeGreaterThan(noCache);
  });
  it("aldri negativ fersk input hvis leverandøren rapporterer mer cache enn total", () => {
    expect(costOre(DEFAULT_PRICING, P, M, { input_tokens: 100, output_tokens: 0, cached_tokens: 500 })).toBeGreaterThanOrEqual(0);
  });
});
