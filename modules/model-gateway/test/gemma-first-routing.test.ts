import { describe, expect, it } from "vitest";
import { AiRouter, CapabilityRegistry, NoEligibleProviderError, ProviderHealthTracker } from "../src/index.ts";

/**
 * D-79 (AI Mesh Gemma-first kost-/personvernarkitektur): beviser den nye
 * sensitivitetsgaten og standard-rutingen deterministisk (§15 test-krav).
 * Ingen ekte nettverk/adapter her - ren routing-logikk mot registry+health,
 * samme mønster som `ua1-mesh.test.ts`.
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

describe("D-79: capability registry - nye providere", () => {
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

  it("D-79 bugfiks: gemini sin profil hevder IKKE lenger 'streaming' (adapteren har aldri hatt .stream())", () => {
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

describe("D-79 §1/§4: Gemma-first standard-ruting (ingen sensitivitet oppgitt)", () => {
  it("AUTO-modus uten purpose/sensitivity: gemma_hosted vinner over openai/anthropic/gemini/kimi (kost-optimalisert standard)", () => {
    const plan = newRouter().plan({}, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });

  it("BACKGROUND/QUICK_CLASSIFICATION (kost-vektet): gemma_hosted vinner fortsatt", () => {
    const plan = newRouter().plan({ purpose: "BACKGROUND" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("gemma_hosted");
  });

  it("udefinert sensitivity = EKSAKT samme ruting som PUBLIC_OR_LOW_SENSITIVITY (§23 migrasjonssikkerhet)", () => {
    const withUndefined = newRouter().plan({}, providers(ALL_CLOUD));
    const withPublic = newRouter().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, providers(ALL_CLOUD));
    expect(withUndefined.candidates).toEqual(withPublic.candidates);
  });
});

describe("D-79 §5: Claude/OpenAI som eskaleringsmål (kvalitet/kritikk slår kost)", () => {
  it("QUALITY-modus: gemma_hosted taper for quality_class=5-providere (openai/anthropic)", () => {
    const plan = newRouter().plan({ mode: "QUALITY" }, providers(ALL_CLOUD));
    expect(["openai", "anthropic"]).toContain(plan.candidates[0]?.provider);
    expect(plan.candidates[0]?.provider).not.toBe("gemma_hosted");
  });

  it("CRITIC-modus: samme kvalitetsprioritering som QUALITY", () => {
    const plan = newRouter().plan({ mode: "CRITIC" }, providers(ALL_CLOUD));
    expect(plan.reason).toBe("CRITIC_REQUIRED");
    expect(["openai", "anthropic"]).toContain(plan.candidates[0]?.provider);
  });

  it("VISION-purpose: KUN anthropic er kvalifisert (gemma_hosted mangler ekte bilde-wiring, ekskluderes helt)", () => {
    const plan = newRouter().plan({ purpose: "VISION" }, providers(ALL_CLOUD));
    expect(plan.candidates[0]?.provider).toBe("anthropic");
    expect(plan.candidates.map((c) => c.provider)).not.toContain("gemma_hosted");
  });

  it("eier-eksplisitt provider-valg (SPECIFIC_PROVIDER) respekteres når policy tillater det", () => {
    const plan = newRouter().plan({ provider: "anthropic" }, providers(ALL_CLOUD));
    expect(plan.reason).toBe("OWNER_OVERRIDE");
    expect(plan.candidates).toEqual([{ provider: "anthropic", model: "claude-sonnet-5" }]);
  });
});

describe("D-79 §3: personvern-grense - gratis-tier Gemma ekskluderes for sensitivt innhold", () => {
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

  it("eier-override til gemma_hosted for PRIVATE-data feiler LUKKET, ALDRI stille gjennomføring", async () => {
    expect(() => newRouter().plan({ provider: "gemma_hosted", sensitivity: "PRIVATE" }, providers(ALL_CLOUD))).toThrow(
      NoEligibleProviderError
    );
  });
});

describe("D-79 §3/§6/§7: SECRET_RESTRICTED - kun lokal, fail-closed uten lokal", () => {
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

describe("D-79 §7: sensitiv + lokal tilgjengelig foretrekkes fremfor sky (D-23), men er IKKE et hardt krav", () => {
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
