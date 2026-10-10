import { describe, expect, it } from "vitest";
import { AiRouter, CapabilityRegistry, NoEligibleProviderError, ProviderHealthTracker } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, L6): `excludeProviders` fjerner leverandører som allerede er forsøkt i turen fra den SCOREDE ruten (samtalemotorens siste reserve, D-354/D-404). Det kan bare gjøre utvalget mindre:
 * alle porter (sensitivitet, betaling, LOCAL) gjelder som før, og eierens eksplisitte valg (`provider`, `providerPreference`) berøres ikke.
 */
const MODELS: Record<string, string> = { gemma_local: "gemma-local", gemma_hosted: "gemma-4-26b-a4b-it", anthropic: "claude-sonnet-5-5", openai: "gpt-5" };
const runtimes = (configured: string[]) => new Map(Object.keys(MODELS).map((n) => [n, { configured: configured.includes(n), model: MODELS[n] as string }]));
const router = () => new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
const ALL = Object.keys(MODELS);

describe("excludeProviders i den scorede ruten", () => {
  it("uten utelukking er planen uendret; med utelukking forsvinner de forsøkte, resten beholder rekkefølgen", () => {
    const full = router().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" }, runtimes(ALL)).candidates.map((c) => c.provider);
    expect(full).toEqual(["gemma_hosted", "gemma_local", "openai", "anthropic"]);
    const excluded = router().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", excludeProviders: ["gemma_local", "gemma_hosted"] }, runtimes(ALL)).candidates.map((c) => c.provider);
    expect(excluded).toEqual(["openai", "anthropic"]);
    expect(router().plan({ sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", excludeProviders: [] }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(full);
  });

  it("alt som ellers kvalifiserer er allerede forsøkt → NoEligibleProviderError(already_attempted), ikke en stille gjentakelse", () => {
    expect(() => router().plan({ excludeProviders: ["gemma_local", "gemma_hosted", "anthropic", "openai"] }, runtimes(ALL))).toThrow(/already_attempted/);
    expect(() => router().plan({ excludeProviders: ["gemma_local"] }, runtimes(["gemma_local"]))).toThrow(NoEligibleProviderError);
    // SECRET_RESTRICTED: kun lokal er kvalifisert; er den forsøkt, finnes ingenting mer - og skyen åpnes aldri av utelukkingen.
    expect(() => router().plan({ sensitivity: "SECRET_RESTRICTED", excludeProviders: ["gemma_local"] }, runtimes(ALL))).toThrow(/already_attempted/);
    expect(router().plan({ sensitivity: "SECRET_RESTRICTED", excludeProviders: ["anthropic"] }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
  });

  it("utelukking åpner aldri noe: gratis delt sky forblir stengt for PRIVATE, og mode LOCAL forblir lokal", () => {
    const privateRoute = router().plan({ sensitivity: "PRIVATE", excludeProviders: ["gemma_local"] }, runtimes(ALL)).candidates.map((c) => c.provider);
    expect(privateRoute).not.toContain("gemma_hosted");
    expect(privateRoute).toEqual(["openai", "anthropic"]);
    expect(() => router().plan({ mode: "LOCAL", excludeProviders: ["gemma_local"] }, runtimes(ALL))).toThrow(/already_attempted/);
    expect(router().plan({ mode: "LOCAL", excludeProviders: ["anthropic"] }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
  });

  it("eierens eksplisitte valg påvirkes ikke: eksakt provider og providerPreference ignorerer utelukkingen", () => {
    expect(router().plan({ provider: "gemma_local", excludeProviders: ["gemma_local"] }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(["gemma_local"]);
    expect(router().plan({ providerPreference: ["gemma_local", "anthropic"], preferenceFailover: true, sensitivity: "PUBLIC_OR_LOW_SENSITIVITY", excludeProviders: ["gemma_local"] }, runtimes(ALL)).candidates.map((c) => c.provider)).toEqual(["gemma_local", "anthropic"]);
  });

  it("ikke-konfigurerte leverandører i utelukkelseslisten teller ikke som «forsøkt» (feilen forblir den vanlige)", () => {
    expect(() => router().plan({ excludeProviders: ["openai"] }, runtimes([]))).toThrow(/ingen konfigurert provider/);
  });
});
