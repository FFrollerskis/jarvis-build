import { describe, expect, it } from "vitest";
import { AiRouter, CapabilityRegistry, NoEligibleProviderError, ProviderHealthTracker } from "../src/index.ts";

/**
 * D-80/D-81 (AI Mesh Gemma-first kost-/personvernarkitektur): beviser den
 * sensitivitetsgaten og standard-rutingen deterministisk (§15/D-81 §3
 * test-krav). Ingen ekte nettverk/adapter her - ren routing-logikk mot
 * registry+health, samme mønster som `ua1-mesh.test.ts`.
 *
 * D-81 P0-SIKKERHETSFIKS (§1): `hosted_free_tier`-providere (`gemma_hosted`)
 * krever et EKSPLISITT `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å
 * være kvalifisert - udefinert sensitivitet blir ALDRI tolket som "public".
 * Denne filen ble omskrevet fra den opprinnelige D-80-versjonen (som feilaktig
 * antok udefinert = samme ruting som PUBLIC_OR_LOW_SENSITIVITY, INKLUDERT for
 * gratis-tier-kvalifisering) - se D-81 i DECISIONS_AND_ASSUMPTIONS.md.
 */

const MODELS: Record<string, string> = {
  openai: "gpt-5",
  anthropic: "claude-sonnet-5",
  gemini: "gemini-2.5-flash",
  gemma_hosted: "gemma-4-26b-a4b-it",
  local_llm: "local-model",
  kimi: "kimi-latest",
  ollama: "llama3.1"
};

function providers(configured: Record<string, boolean>): Map<string, { configured: boolean; model: string }> {
  return new Map(Object.entries(configured).map(([name, c]) => [name, { configured: c, model: MODELS[name] ?? "m" }]));
}

const ALL_CLOUD = { openai: true, anthropic: true, gemini: true, gemma_hosted: true, kimi: true };
const ALL = { ...ALL_CLOUD, ollama: true, local_llm: true };

function newRouter(): AiRouter {
  return new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
}

describe("D-80: capability registry - nye providere", () => {
  it("gemma_hosted og local_llm har profiler", () => {
    const registry = new CapabilityRegistry();
    expect(registry.get("gemma_hosted")).toBeDefined();
    expect(registry.get("local_llm")).toBeDefined();
  });

  it("gemma_hosted er markert hosted_free_tier=true; ALLE andre providere er false/uendret", () => {
    const registry = new CapabilityRegistry();
    expect(registry.get("gemma_hosted")?.hosted_free_tier).toBe(true);
    for (const p of ["openai", "anthropic", "gemini", "kimi", "ollama", "local_llm"]) {
      expect(registry.get(p)?.hosted_free_tier, p).not.toBe(true);
    }
  });

  it("local_llm er markert locality=local (samme kategori som ollama, IKKE cloud)", () => {
    expect(new CapabilityRegistry().get("local_llm")?.locality).toBe("local");
  });

  it("D-80 bugfiks: gemini sin profil hevder IKKE lenger 'streaming' (adapteren har aldri hatt .stream())", () => {
    expect(new CapabilityRegistry().get("gemini")?.capabilities).not.toContain("streaming");
  });

  it("gemma_hosted og local_llm hevder tool_calling+structured_output (ekte wiret i adapterne, ikke aspirasjonelt)", () => {
    const registry = new CapabilityRegistry();
    expect(registry.get("gemma_hosted")?.capabilities).toEqual(
      expect.arrayContaining(["tool_calling", "structured_output"])
    );
    expect(registry.get("local_llm")?.capabilities).toEqual(
      expect.arrayContaining(["tool_calling", "structured_output"])
    );
  });
});

describe("D-81 §1/P0: udefinert sensitivitet MÅ IKKE nå gratis-tier (fail-safe, ikke fail-open)", () => {
  it("udefinert sensitivity: gemma_hosted er IKKE blant kandidatene", () => {
    const plan = newRouter().plan({}, providers(ALL_CLOUD));
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });

  it("udefinert sensitivity + AUTO: openai vinner (identisk med FØR D-80 - ingen regresjon for eksisterende providere)", () => {
    const plan = newRouter().plan({}, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("openai");
  });

  it("udefinert sensitivity != PUBLIC_OR_LOW_SENSITIVITY - kandidatlistene er FORSKJELLIGE (gratis-tier med, uten)", () => {
    const withUndefined = newRouter().plan({}, providers(ALL_CLOUD));
    const withPublic = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL_CLOUD));
    expect(withUndefined.candidates).not.toEqual(withPublic.candidates);
    expect(withUndefined.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
    expect(withPublic.candidates.map((c) => c.provider)).toContain("gemma_hosted");
  });

  it("udefinert sensitivity + KUN gemma_hosted konfigurert: fail-closed, ALDRI stille bruk av gratis-tieret", () => {
    expect(() => newRouter().plan({}, providers({ gemma_hosted: true }))).toThrow(NoEligibleProviderError);
  });

  it("udefinert sensitivity: eksisterende, allerede betrodde providere (openai/anthropic/gemini/kimi/ollama) forblir UENDRET kvalifisert (§23 migrasjonssikkerhet)", () => {
    const plan = newRouter().plan({}, providers(ALL));
    const nonFree = plan.candidates.map((c) => c.provider).filter((p) => p !== "gemma_hosted");
    expect(nonFree.length).toBeGreaterThan(0);
    for (const p of nonFree) {
      expect(["openai", "anthropic", "gemini", "kimi", "ollama", "local_llm"]).toContain(p);
    }
  });
});

describe("D-80/D-81 §1/§4: Gemma-first ruting KUN når eksplisitt klassifisert PUBLIC_OR_LOW_SENSITIVITY", () => {
  it("PUBLIC_OR_LOW_SENSITIVITY + AUTO: gemma_hosted vinner over openai/anthropic/gemini/kimi (kost-optimalisert)", () => {
    const plan = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });

  it("PUBLIC_OR_LOW_SENSITIVITY + BACKGROUND (kost-vektet): gemma_hosted vinner", () => {
    const plan = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", purpose: "BACKGROUND" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });

  it("BACKGROUND uten sensitivity + kun sky-providere: gemini vinner (samme som FØR D-80 - kost-vektet BACKGROUND favoriserer gemini sin lave cost_class, gemma_hosted ekskludert)", () => {
    const plan = newRouter().plan({ purpose: "BACKGROUND" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("gemini");
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });
});

describe("D-80 §5: Claude/OpenAI som eskaleringsmål (kvalitet/kritikk slår kost)", () => {
  it("QUALITY-modus: gemma_hosted taper for quality_class=5-providere (openai/anthropic)", () => {
    const plan = newRouter().plan({ mode: "QUALITY", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL_CLOUD));
    expect(["openai", "anthropic"]).toContain(plan.candidates[0]?.provider);
    expect(plan.candidates[0]?.provider).not.toBe("gemma_hosted");
  });

  it("CRITIC-modus: samme kvalitetsprioritering som QUALITY", () => {
    const plan = newRouter().plan({ mode: "CRITIC" }, providers(ALL_CLOUD));
    expect(plan.reason).toBe("CRITIC_REQUIRED");
    expect(["openai", "anthropic"]).toContain(plan.candidates[0]?.provider);
  });

  it("VISION-purpose uten sensitivity: KUN anthropic er kvalifisert (gemma_hosted har ekte bilde-wiring (D-81) men ekskluderes av personvern-fail-safen for udefinert sensitivitet)", () => {
    const plan = newRouter().plan({ purpose: "VISION" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("anthropic");
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });

  it("VISION-purpose + eksplisitt PUBLIC_OR_LOW_SENSITIVITY: gemma_hosted er NÅ ekte kvalifisert (D-81 vision-wiring) og konkurrerer på kost/kvalitet - eksplisitt mode=QUALITY gir fortsatt anthropic", () => {
    const auto = newRouter().plan({ purpose: "VISION", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL_CLOUD));
    expect(auto.candidates.map((c) => c.provider)).toContain("gemma_hosted");
    expect(auto.candidates.map((c) => c.provider)).toContain("anthropic");
    const quality = newRouter().plan(
      { purpose: "VISION", mode: "QUALITY", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" },
      providers(ALL_CLOUD)
    );
    expect(quality.candidates[0]?.provider).toBe("anthropic");
  });

  it("eier-eksplisitt provider-valg (SPECIFIC_PROVIDER) respekteres når policy tillater det", () => {
    const plan = newRouter().plan({ provider: "anthropic" }, providers(ALL_CLOUD));
    expect(plan.reason).toBe("OWNER_OVERRIDE");
    expect(plan.candidates).toEqual([{ provider: "anthropic", model: "claude-sonnet-5" }]);
  });
});

describe("D-80 §3: personvern-grense - gratis-tier Gemma ekskluderes for sensitivt innhold", () => {
  it("PRIVATE: gemma_hosted er IKKE blant kandidatene", () => {
    const plan = newRouter().plan({ sensitivity: "PRIVATE" }, providers(ALL_CLOUD));
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });

  it("BUSINESS_CONFIDENTIAL: gemma_hosted er IKKE blant kandidatene, men allerede betrodde betalte providere forblir kvalifisert", () => {
    const plan = newRouter().plan({ sensitivity: "BUSINESS_CONFIDENTIAL" }, providers(ALL_CLOUD));
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(["openai", "anthropic", "gemini", "kimi"]).toContain(plan.candidates[0]?.provider);
  });

  it("reason=PRIVACY_RESTRICTED når sensitivitet faktisk ekskluderte en ellers-kvalifisert gratis-tier-kandidat", () => {
    const plan = newRouter().plan({ sensitivity: "BUSINESS_CONFIDENTIAL" }, providers(ALL_CLOUD));
    expect(plan.reason).toBe("PRIVACY_RESTRICTED");
  });

  it("reason=PRIVACY_RESTRICTED gjelder OGSÅ for udefinert sensitivitet når gratis-tier faktisk ble ekskludert", () => {
    const plan = newRouter().plan({}, providers(ALL_CLOUD));
    expect(plan.reason).toBe("PRIVACY_RESTRICTED");
  });
});

describe("D-80/D-81 §3/§8: eier-override kan ALDRI omgå personvernpolicyen (for noen sensitivitetsverdi)", () => {
  it("eier-override til gemma_hosted for PRIVATE-data feiler LUKKET, ALDRI stille gjennomføring", () => {
    expect(() => newRouter().plan({ provider: "gemma_hosted", sensitivity: "PRIVATE" }, providers(ALL_CLOUD))).toThrow(
      NoEligibleProviderError
    );
  });

  it("eier-override til gemma_hosted for BUSINESS_CONFIDENTIAL-data feiler LUKKET", () => {
    expect(() =>
      newRouter().plan({ provider: "gemma_hosted", sensitivity: "BUSINESS_CONFIDENTIAL" }, providers(ALL_CLOUD))
    ).toThrow(NoEligibleProviderError);
  });

  it("eier-override til gemma_hosted for SECRET_RESTRICTED-data feiler LUKKET", () => {
    expect(() =>
      newRouter().plan({ provider: "gemma_hosted", sensitivity: "SECRET_RESTRICTED" }, providers(ALL_CLOUD))
    ).toThrow(NoEligibleProviderError);
  });

  it("eier-override til gemma_hosted med UDEFINERT sensitivitet feiler OGSÅ LUKKET (P0-fiksen gjelder identisk for override)", () => {
    expect(() => newRouter().plan({ provider: "gemma_hosted" }, providers(ALL_CLOUD))).toThrow(NoEligibleProviderError);
  });

  it("eier-override til gemma_hosted MED eksplisitt PUBLIC_OR_LOW_SENSITIVITY LYKKES (policy tillater det)", () => {
    const plan = newRouter().plan(
      { provider: "gemma_hosted", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" },
      providers(ALL_CLOUD)
    );
    expect(plan.reason).toBe("OWNER_OVERRIDE");
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });
});

describe("D-80 §3/§6/§7: SECRET_RESTRICTED - kun lokal, fail-closed uten lokal", () => {
  it("SECRET_RESTRICTED + lokal tilgjengelig: KUN lokale providere kvalifisert", () => {
    const plan = newRouter().plan({ sensitivity: "SECRET_RESTRICTED" }, providers(ALL));
    for (const c of plan.candidates) {
      expect(["ollama", "local_llm"]).toContain(c.provider);
    }
  });

  it("SECRET_RESTRICTED + INGEN lokal konfigurert: fail-closed (NoEligibleProviderError), ALDRI en sky-fallback", () => {
    expect(() => newRouter().plan({ sensitivity: "SECRET_RESTRICTED" }, providers(ALL_CLOUD))).toThrow(
      NoEligibleProviderError
    );
  });

  it("§15 test-krav: 'no provider satisfies privacy+capability -> fail closed' - verifisert eksplisitt for tom providerliste", () => {
    expect(() => newRouter().plan({ sensitivity: "SECRET_RESTRICTED" }, providers({}))).toThrow(NoEligibleProviderError);
  });
});

describe("D-80 §7: sensitiv + lokal tilgjengelig foretrekkes fremfor sky (D-23), men er IKKE et hardt krav", () => {
  it("PRIVATE + lokal frisk/tilgjengelig: lokal_llm eller ollama rangeres FØRST (myk preferanse-bonus)", () => {
    const plan = newRouter().plan({ sensitivity: "PRIVATE" }, providers(ALL));
    expect(["ollama", "local_llm"]).toContain(plan.candidates[0]?.provider);
    expect(plan.reason).toBe("PRIVACY_PREFERS_LOCAL");
  });

  it("PRIVATE + lokal IKKE konfigurert: faller tilbake til en allerede betrodd betalt sky-provider (ALDRI gemma_hosted)", () => {
    const plan = newRouter().plan({ sensitivity: "PRIVATE" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).not.toBe("gemma_hosted");
    expect(["openai", "anthropic", "gemini", "kimi"]).toContain(plan.candidates[0]?.provider);
  });

  it("PUBLIC_OR_LOW_SENSITIVITY: INGEN lokal-preferanse-bonus - gemma_hosted vinner fortsatt selv om lokal er tilgjengelig", () => {
    const plan = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL));
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });
});
