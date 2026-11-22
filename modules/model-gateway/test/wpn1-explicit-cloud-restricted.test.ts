import { describe, expect, it } from "vitest";
import { AiRouter, CapabilityRegistry, NoEligibleProviderError, ProviderHealthTracker } from "../src/index.ts";

/**
 * WP-N1 (fiks-runde 1, F-A5): en eksplisitt «bruk Claude»/«bruk GPT» (eierens valg av leverandør) kan IKKE åpne skyen for en tur som er løftet til SECRET_RESTRICTED - heller ikke når løftet kommer fra en merket historikkrad
 * (`history:restricted`). Så lenge smitten varer (en merket rad er blant de siste meldingene), feiler en slik forespørsel LUKKET (D-378/D-80 §3: SECRET_RESTRICTED = kun lokale providere, ingen sky-fallback). Dette beviser RUTERENS regel mot det ekte
 * leverandørregisteret; kjeden samtalemotor -> ruter er ikke kjørt mot en ekte `ModelGateway` (NOT VERIFIED, se runbooken).
 */
const MODELS: Record<string, string> = { openai: "gpt-5", anthropic: "claude-sonnet-5", gemini: "gemini-2.5-flash", gemma_hosted: "gemma-4-26b-a4b-it", local_llm: "local-model", kimi: "kimi-latest", ollama: "llama3.1" };
const providers = (configured: Record<string, boolean>) => new Map(Object.entries(configured).map(([name, c]) => [name, { configured: c, model: MODELS[name] ?? "m" }]));
const ALL = { openai: true, anthropic: true, gemini: true, gemma_hosted: true, kimi: true, ollama: true, local_llm: true };
const router = () => new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());

describe("eksplisitt skyvalg mot SECRET_RESTRICTED (tur løftet av en merket historikkrad)", () => {
  it("hver skyleverandør som eieren velger eksplisitt feiler LUKKET (NoEligibleProviderError), selv med lokale leverandører konfigurert - ingen stille bytte til sky eller lokal", () => {
    for (const provider of ["anthropic", "openai", "gemini", "kimi", "gemma_hosted"]) {
      expect(() => router().plan({ provider, sensitivity: "SECRET_RESTRICTED" }, providers(ALL)), provider).toThrow(NoEligibleProviderError);
    }
  });

  it("kontroll: en eksplisitt LOKAL leverandør virker fortsatt, og uten eksplisitt valg er det kun lokale kandidater", () => {
    for (const provider of ["ollama", "local_llm"]) {
      const plan = router().plan({ provider, sensitivity: "SECRET_RESTRICTED" }, providers(ALL));
      expect(plan.candidates[0]?.provider, provider).toBe(provider);
    }
    const open = router().plan({ sensitivity: "SECRET_RESTRICTED" }, providers(ALL));
    expect(open.candidates.map((c) => c.provider).sort()).toEqual(["local_llm", "ollama"]);
  });

  it("uten SECRET_RESTRICTED (flagg AV eller ingen merket rad) kan eieren velge Claude som før", () => {
    expect(router().plan({ provider: "anthropic", sensitivity: "PRIVATE" }, providers(ALL)).candidates[0]?.provider).toBe("anthropic");
  });
});
