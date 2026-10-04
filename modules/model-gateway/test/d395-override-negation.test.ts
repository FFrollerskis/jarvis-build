import { describe, expect, it } from "vitest";
import { parseRoutingOverride } from "../src/override-parser.ts";

/**
 * D-395 (JARVIS-078): override-parseren ignorerte negasjon og avfyrte på vanlig prosa. Imperative/forespørsels-former virker fortsatt;
 * negerte, infinitivs-beskrivende og siterte forekomster er IKKE instruksjoner (ingen override).
 */
describe("parseRoutingOverride: imperative former virker fortsatt", () => {
  it.each([
    ["bruk Claude", "anthropic"],
    ["Kan du bruke OpenAI til dette?", "openai"],
    ["Vennligst bruk bare Gemini", "gemini"],
    ["Hei! Bruk Kimi nå", "kimi"],
    ["bruk Hermes", "hermes"],
    ["Ok, bruk kun Claude for dette"  , "anthropic"],
    ["ikke tenk på det, bruk Claude", "anthropic"] // negasjon i en ANNEN klausul gjelder ikke
  ])("%s → %s", (text, provider) => {
    expect(parseRoutingOverride(text)?.provider).toBe(provider);
  });

  it("andre kategorier uendret", () => {
    expect(parseRoutingOverride("bruk bare lokale modeller")?.mode).toBe("LOCAL");
    expect(parseRoutingOverride("velg den beste modellen")?.mode).toBe("QUALITY");
    expect(parseRoutingOverride("ikke bruk betalte modeller")?.paid_models_allowed).toBe(false);
    expect(parseRoutingOverride("bruk AI-rådet")?.triggerCouncil).toBe(true);
    expect(parseRoutingOverride("ikke bruk AI-rådet")?.suppressCouncil).toBe(true);
    expect(parseRoutingOverride("bruk alle AI-ene")?.triggerCouncil).toBe(true);
    expect(parseRoutingOverride("bruk Gemma")?.providerPreference).toEqual(["gemma_local", "gemma_hosted"]);
  });
});

describe("parseRoutingOverride: negasjon gir ALDRI en override i motsatt retning", () => {
  it.each([
    "jeg vil ikke bruke Claude",
    "ikke bruk Claude til dette",
    "du skal aldri bruke OpenAI",
    "slutt å bruke Gemini",
    "unngå å bruke Kimi",
    "don't use Claude",
    "ikke bruk bare Gemini",
    "jeg vil helst ikke egentlig bruke Gemma"
  ])("%s → ingen override", (text) => {
    const result = parseRoutingOverride(text);
    expect(result?.provider).toBeUndefined();
    expect(result?.providerPreference).toBeUndefined();
  });

  it("negasjon i forrige SETNING gjelder ikke neste setning", () => {
    expect(parseRoutingOverride("Jeg har ikke tid. Bruk Claude.")?.provider).toBe("anthropic");
  });
});

describe("parseRoutingOverride: vanlig prosa er ikke en instruksjon", () => {
  it.each([
    "det er fint å bruke Gemini til slikt",
    "hva er forskjellen på å bruke Gemini og GPT?",
    "jeg liker å bruke Claude",
    "for å bruke OpenAI trenger du en nøkkel",
    'han skrev «bruk Claude» i dokumentet',
    'sa hun: "bruk Gemini" men jeg er usikker'
  ])("%s → ingen override", (text) => {
    expect(parseRoutingOverride(text)).toBeNull();
  });
});
