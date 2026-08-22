import { describe, expect, it } from "vitest";
import { parseRoutingOverride } from "../src/index.ts";

/**
 * D-106 (§"user routing overrides"): 100% deterministisk fraseparsing - se
 * `override-parser.ts` sin filkommentar for arkitekturbegrunnelsen (aldri en
 * LLM som tolker instruksjonen selv).
 */
describe("D-106: parseRoutingOverride() - deterministisk fraseparsing", () => {
  it("A: 'bruk bare Claude' -> provider anthropic", () => {
    expect(parseRoutingOverride("bruk bare Claude på dette")?.provider).toBe("anthropic");
  });

  it("B: 'bruk OpenAI' -> provider openai", () => {
    expect(parseRoutingOverride("Kan du bruke OpenAI her?")?.provider).toBe("openai");
  });

  it("C: 'bruk Gemini' -> provider gemini", () => {
    expect(parseRoutingOverride("bruk gemini")?.provider).toBe("gemini");
  });

  it("D: 'bruk Kimi' -> provider kimi", () => {
    expect(parseRoutingOverride("bruk kun Kimi")?.provider).toBe("kimi");
  });

  it("E: 'bruk Gemma' -> providerPreference [gemma_local, gemma_hosted] (modellFAMILIE, ikke én instans)", () => {
    expect(parseRoutingOverride("bruk gemma")?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
  });

  it("F: 'bruk alle AI-ene' -> triggerCouncil", () => {
    expect(parseRoutingOverride("bruk alle AI-ene på dette")?.triggerCouncil).toBe(true);
  });

  it("G: 'spør alle AI-ene' -> triggerCouncil", () => {
    expect(parseRoutingOverride("spør alle AI-ene om dette")?.triggerCouncil).toBe(true);
  });

  it("H: 'bruk AI-rådet' -> triggerCouncil", () => {
    expect(parseRoutingOverride("bruk AI-rådet")?.triggerCouncil).toBe(true);
  });

  it("I: 'ikke bruk betalte modeller' -> paid_models_allowed=false", () => {
    expect(parseRoutingOverride("ikke bruk betalte modeller til dette")?.paid_models_allowed).toBe(false);
  });

  it("J: 'bruk bare lokale modeller' -> mode LOCAL", () => {
    expect(parseRoutingOverride("bruk bare lokale modeller")?.mode).toBe("LOCAL");
  });

  it("K: 'velg den beste modellen' -> mode QUALITY", () => {
    expect(parseRoutingOverride("velg den beste modellen")?.mode).toBe("QUALITY");
  });

  it("L: ingen kjent frase -> null (vanlig AUTO-ruting uendret)", () => {
    expect(parseRoutingOverride("hva er klokken?")).toBeNull();
  });

  it("P: 'ikke bruk AI-rådet' -> suppressCouncil=true (D-106 HOST-FIX, sjekket FØR triggerCouncil)", () => {
    const result = parseRoutingOverride("ikke bruk AI-rådet på dette");
    expect(result?.suppressCouncil).toBe(true);
    expect(result?.triggerCouncil).toBeUndefined();
  });

  it("Q: \"don't use the council\" -> suppressCouncil=true", () => {
    expect(parseRoutingOverride("don't use the council for this")?.suppressCouncil).toBe(true);
  });

  it("R: 'ikke bruk alle AI-ene' -> suppressCouncil=true (ikke feiltolket som 'bruk alle AI-ene')", () => {
    const result = parseRoutingOverride("ikke bruk alle AI-ene her");
    expect(result?.suppressCouncil).toBe(true);
    expect(result?.triggerCouncil).toBeUndefined();
  });

  it("M: Council-frasen sjekkes FØR enkelt-provider-frasene (unngår feiltolkning av 'AI-ene' som en provider)", () => {
    const result = parseRoutingOverride("bruk alle AI-ene, ikke bare Claude");
    expect(result?.triggerCouncil).toBe(true);
    expect(result?.provider).toBeUndefined();
  });

  it("N: case-insensitiv matching", () => {
    expect(parseRoutingOverride("BRUK BARE CLAUDE")?.provider).toBe("anthropic");
  });

  it("O: matched_phrase er alltid satt og auditerbar (ikke en LLM-generert forklaring)", () => {
    const result = parseRoutingOverride("bruk kun openai");
    expect(result?.matched_phrase).toBeTruthy();
    expect(typeof result?.matched_phrase).toBe("string");
  });
});
