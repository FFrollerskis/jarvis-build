import { describe, expect, it } from "vitest";
import {
  AiRouter,
  CapabilityRegistry,
  NoEligibleProviderError,
  PaidModelsDisabledError,
  ProviderHealthTracker
} from "../src/index.ts";

/**
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): beviser
 * `paid_models_allowed`-policygaten og `providerPreference`-preferanselisten
 * i `router.ts`, samme rene routing-mot-registry+health-mønster som
 * `gemma-first-routing.test.ts` (ingen ekte adapter/pool nødvendig).
 */

const MODELS: Record<string, string> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-5",
  gemini: "gemini-2.5-flash",
  gemma_hosted: "gemma-4-26b-a4b-it",
  gemma_local: "gemma-local",
  local_llm: "local-model",
  kimi: "kimi-latest",
  ollama: "llama3.1"
};

function providers(configured: Record<string, boolean>): Map<string, { configured: boolean; model: string }> {
  return new Map(Object.entries(configured).map(([name, c]) => [name, { configured: c, model: MODELS[name] ?? "m" }]));
}

const ALL = { openai: true, anthropic: true, gemini: true, gemma_hosted: true, kimi: true, ollama: true, local_llm: true, gemma_local: true };

function newRouter(): AiRouter {
  return new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
}

describe("D-106: gemma_local capability-registry profil", () => {
  it("A: gemma_local har en profil, distinkt fra local_llm og gemma_hosted", () => {
    const registry = new CapabilityRegistry();
    const profile = registry.get("gemma_local");
    expect(profile).toBeDefined();
    expect(profile?.locality).toBe("local");
    expect(profile?.hosted_free_tier).not.toBe(true);
    expect(profile?.capabilities).toEqual(expect.arrayContaining(["tool_calling"]));
  });
});

describe("D-106: paid_models_allowed=false", () => {
  it("B: AUTO-modus med udefinert paid_models_allowed er UENDRET (§23 migrasjonssikkerhet)", () => {
    const withUndefined = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL));
    const withTrue = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", paid_models_allowed: true }, providers(ALL));
    expect(withUndefined.candidates).toEqual(withTrue.candidates);
  });

  it("C: paid_models_allowed=false ekskluderer ALLE sky-providere fra AUTO-planen, uansett hosted_free_tier", () => {
    const plan = newRouter().plan({ paid_models_allowed: false }, providers(ALL));
    for (const c of plan.candidates) {
      expect(["ollama", "local_llm", "gemma_local"]).toContain(c.provider);
    }
  });

  it("D: paid_models_allowed=false, INGEN lokal provider konfigurert -> PaidModelsDisabledError (fail-closed, aldri stille betalt fallback)", () => {
    expect(() =>
      newRouter().plan(
        { paid_models_allowed: false },
        providers({ openai: true, anthropic: true, gemini: true, kimi: true, gemma_hosted: true })
      )
    ).toThrow(PaidModelsDisabledError);
  });

  it("E: PAID_MODELS_DISABLED-reason satt når minst én sky-kandidat ble ekskludert av policyen (og INGEN sensitivitetsgate samtidig trigget)", () => {
    // sensitivity=PUBLIC_OR_LOW_SENSITIVITY nøytraliserer sensitivitetsgaten helt (gemma_hosted
    // ikke ekskludert av D-81 her) - eneste gjenværende eksklusjonsårsak er paid_models_allowed.
    const plan = newRouter().plan(
      { paid_models_allowed: false, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" },
      providers(ALL)
    );
    expect(plan.reason).toBe("PAID_MODELS_DISABLED");
  });

  it("F: SPECIFIC_PROVIDER-override av en BETALT provider feiler når paid_models_allowed=false (eier kan ikke omgå policyen)", () => {
    expect(() =>
      newRouter().plan({ provider: "openai", paid_models_allowed: false }, providers(ALL))
    ).toThrow(PaidModelsDisabledError);
  });

  it("G: SPECIFIC_PROVIDER-override av en LOKAL provider fungerer FORTSATT når paid_models_allowed=false", () => {
    const plan = newRouter().plan({ provider: "ollama", paid_models_allowed: false }, providers(ALL));
    expect(plan.candidates[0]?.provider).toBe("ollama");
  });
});

describe("D-106: providerPreference (\"bruk Gemma\" -> [\"gemma_local\",\"gemma_hosted\"])", () => {
  it("H: første kandidat i listen som er konfigurert vinner - ingen scoring", () => {
    const plan = newRouter().plan(
      { providerPreference: ["gemma_local", "gemma_hosted"], sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" },
      providers(ALL)
    );
    expect(plan.candidates).toEqual([{ provider: "gemma_local", model: "gemma-local" }]);
    expect(plan.reason).toBe("PROVIDER_PREFERENCE");
  });

  it("I: hopper over ukonfigurert første kandidat og velger andre i listen", () => {
    const plan = newRouter().plan(
      { providerPreference: ["gemma_local", "gemma_hosted"], sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" },
      providers({ ...ALL, gemma_local: false })
    );
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });

  it("J/K: gemma_hosted i preferanselisten respekterer FORTSATT D-81 sensitivitetsgaten - udefinert sensitivity gir NoEligibleProviderError, aldri stille fallback utenfor listen", () => {
    expect(() =>
      newRouter().plan({ providerPreference: ["gemma_hosted"] }, providers({ ...ALL, gemma_local: false }))
    ).toThrow(NoEligibleProviderError);
  });

  it("L: providerPreference respekterer paid_models_allowed=false (hopper over betalt kandidat i listen)", () => {
    const plan = newRouter().plan(
      { providerPreference: ["anthropic", "ollama"], paid_models_allowed: false },
      providers(ALL)
    );
    expect(plan.candidates[0]?.provider).toBe("ollama");
  });

  it("M: eksakt `provider`-override vinner over `providerPreference` når begge er satt", () => {
    const plan = newRouter().plan(
      { provider: "openai", providerPreference: ["gemma_local"] },
      providers(ALL)
    );
    expect(plan.candidates[0]?.provider).toBe("openai");
  });

  it("N: manglende required_capabilities filtreres bort fra preferanselisten (samme presisjon som eksakt override)", () => {
    // kimi mangler structured_output - krever den eksplisitt, gemma_local har den
    const plan = newRouter().plan(
      { providerPreference: ["kimi", "gemma_local"], needs_structured: true },
      providers(ALL)
    );
    expect(plan.candidates[0]?.provider).toBe("gemma_local");
  });
});
