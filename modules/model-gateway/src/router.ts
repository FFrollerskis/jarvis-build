import type { DataSensitivity, ModelPurpose, RouterMode, RoutingReason } from "@jarvis/contracts";
import type { CapabilityRegistry, ModelCapability, ModelProfile } from "./capability-registry.ts";
import type { ProviderHealthTracker } from "./provider-health.ts";

/**
 * UA-1 AI Router (BO-08 §8-§10): deterministisk/scoret valg av provider fra
 * capability registry + health. Ingen LLM brukes for å velge LLM. Modellvalg
 * skjer KUN her (trusted layer) - en modell kan aldri velge seg selv (§35).
 */
export interface RouteInput {
  purpose?: ModelPurpose;
  mode?: RouterMode;
  required_capabilities?: ModelCapability[];
  /** Owner/system-override (§10): eksakt provider. Ingen stille fallback til andre. */
  provider?: string;
  needs_structured?: boolean;
  /**
   * D-80/D-81 (AI Mesh Gemma-first §3/§23, P0-sikkerhetsfiks): VALGFRITT.
   * `hosted_free_tier`-providere (i dag kun `gemma_hosted`) krever et
   * EKSPLISITT `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å være
   * kvalifisert - udefinert/ukjent sensitivitet blir ALDRI tolket som
   * "public" (fail-safe, D-81). For ALLE ANDRE, allerede betrodde providere
   * (openai/anthropic/gemini/kimi/ollama/local_llm) er ruting UENDRET fra FØR
   * D-80 når feltet er udefinert (§23 migrasjonssikkerhet - ingen eksisterende
   * kalleside mister tilgang til en tidligere kvalifisert provider). Når
   * kalleren eksplisitt klassifiserer dataen:
   *  - PUBLIC_OR_LOW_SENSITIVITY: `hosted_free_tier`-providere blir kvalifisert;
   *    ingen ekstra filtrering for øvrige.
   *  - PRIVATE / BUSINESS_CONFIDENTIAL: `hosted_free_tier`-providere
   *    EKSKLUDERES helt; lokale providere foretrekkes (scoring-bonus), men er
   *    IKKE et hardt krav - en allerede betrodd betalt sky-provider forblir
   *    kvalifisert (D-23: "preferably local... or an approved paid/private
   *    provider configuration").
   *  - SECRET_RESTRICTED: KUN lokale providere er kvalifisert (gjelder for
   *    ALLE providere, inkl. `hosted_free_tier`). Ingen lokal tilgjengelig =>
   *    fail-closed (`NoEligibleProviderError`), ALDRI stille fallback til en
   *    sky-provider - gjelder OGSÅ eksplisitt eier-override.
   */
  sensitivity?: DataSensitivity;
}

export interface RouteCandidate {
  provider: string;
  model: string;
}

export interface RoutePlan {
  mode: RouterMode;
  reason: RoutingReason;
  /** Primær først; resten er deterministisk fallback-rekkefølge. */
  candidates: RouteCandidate[];
}

/** LOCAL krevd men ingen egnet lokal modell live → tydelig feil, aldri sky bak ryggen (§26). */
export class LocalModelUnavailableError extends Error {
  constructor() {
    super("local_model_unavailable: LOCAL krevd, ingen egnet lokal modell er konfigurert/live");
    this.name = "LocalModelUnavailableError";
  }
}

export class NoEligibleProviderError extends Error {
  constructor(detail: string) {
    super(`no_eligible_provider: ${detail}`);
    this.name = "NoEligibleProviderError";
  }
}

const REASONING_PURPOSES: ModelPurpose[] = ["CODE", "REASON", "PLAN", "RESEARCH", "CRITIQUE"];
const CHEAP_PURPOSES: ModelPurpose[] = ["QUICK_CLASSIFICATION", "BACKGROUND"];

/**
 * D-80/D-81: sensitivitetsgate - kjøres FØR capability-filtrering.
 *
 * D-81 P0-SIKKERHETSFIKS: `hosted_free_tier`-providere (i dag KUN `gemma_hosted`)
 * krever et EKSPLISITT `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for å være
 * kvalifisert - udefinert/ukjent sensitivitet blir ALDRI tolket som "public"
 * (fail-safe, ikke fail-open). Dette er en BEVISST innstramming fra den
 * opprinnelige D-80-implementasjonen, som feilaktig lot udefinert sensitivitet
 * forbli kvalifisert for gratis-tier - se D-81 i DECISIONS_AND_ASSUMPTIONS.md
 * for full begrunnelse og den konkrete risikoen dette lukker.
 *
 * For ALLE ANDRE providere (uten `hosted_free_tier`) er migrasjonssikkerheten
 * fra D-80 uendret: udefinert `sensitivity` ELLER `PUBLIC_OR_LOW_SENSITIVITY`
 * = ingen ekstra filtrering (samme ruting som FØR D-80 for disse - INGEN
 * eksisterende kalleside mister tilgang til en tidligere kvalifisert provider).
 * `SECRET_RESTRICTED` = kun lokale providere kvalifisert (fail-closed, aldri
 * stille sky-fallback) - gjelder for ALLE providere, inkl. `hosted_free_tier`.
 * `PRIVATE`/`BUSINESS_CONFIDENTIAL` = `hosted_free_tier`-providere ekskluderes
 * (dekket av førstesjekken over); øvrige, allerede betrodde betalte
 * sky-providere forblir kvalifisert, uendret fra D-80.
 */
function isSensitivityEligible(profile: ModelProfile, sensitivity: DataSensitivity | undefined): boolean {
  if (profile.hosted_free_tier && sensitivity !== "PUBLIC_OR_LOW_SENSITIVITY") return false;
  if (!sensitivity || sensitivity === "PUBLIC_OR_LOW_SENSITIVITY") return true;
  if (sensitivity === "SECRET_RESTRICTED") return profile.locality === "local";
  return true;
}

interface ProviderRuntime {
  configured: boolean;
  model: string;
}

export class AiRouter {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly health: ProviderHealthTracker
  ) {}

  plan(input: RouteInput, providers: Map<string, ProviderRuntime>): RoutePlan {
    const mode: RouterMode = input.provider ? "SPECIFIC_PROVIDER" : (input.mode ?? "AUTO");

    // Owner override: eksakt provider, ingen stille fallback (forutsigbarhet > resiliens her).
    // §38 (P1A): manglende påkrevd capability gir tydelig feil - aldri stille ignorering.
    if (mode === "SPECIFIC_PROVIDER") {
      const name = input.provider as string;
      const rt = providers.get(name);
      if (!rt?.configured) {
        throw new NoEligibleProviderError(`override-provider '${name}' er ikke konfigurert`);
      }
      const requiredForOverride = new Set<ModelCapability>(input.required_capabilities ?? []);
      if (input.needs_structured) requiredForOverride.add("structured_output");
      const profile = this.registry.profileOrGeneric(name, rt.model);
      const missing = [...requiredForOverride].filter((c) => !profile.capabilities.includes(c));
      if (missing.length > 0) {
        throw new NoEligibleProviderError(
          `override_capability_missing: '${name}' mangler [${missing.join(",")}]`
        );
      }
      // D-79 §3: eksplisitt eier-valg er ALDRI en fritakelse fra sensitivitetsloven -
      // et gratis-tier/sky-valg for SECRET_RESTRICTED/PRIVATE-data feiler fortsatt lukket.
      if (!isSensitivityEligible(profile, input.sensitivity)) {
        throw new NoEligibleProviderError(
          `override_sensitivity_blocked: '${name}' er ikke godkjent for sensitivitet ${input.sensitivity}`
        );
      }
      return { mode, reason: "OWNER_OVERRIDE", candidates: [{ provider: name, model: rt.model }] };
    }

    const required = new Set<ModelCapability>(input.required_capabilities ?? []);
    if (input.purpose === "VISION") required.add("vision");
    if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) required.add("reasoning");
    if (input.needs_structured) required.add("structured_output");

    const eligible: Array<{ profile: ModelProfile; model: string; state: string }> = [];
    let sensitivityExcludedCount = 0;
    for (const [name, rt] of providers) {
      if (!rt.configured) continue;
      const profile = this.registry.profileOrGeneric(name, rt.model);
      if (mode === "LOCAL" && profile.locality !== "local") continue;
      if (![...required].every((c) => profile.capabilities.includes(c))) continue;
      if (!isSensitivityEligible(profile, input.sensitivity)) {
        sensitivityExcludedCount++;
        continue;
      }
      eligible.push({ profile, model: rt.model, state: this.health.state(name, true) });
    }
    if (eligible.length === 0) {
      if (mode === "LOCAL") throw new LocalModelUnavailableError();
      throw new NoEligibleProviderError(
        `ingen konfigurert provider dekker [${[...required].join(",")}]` +
          (input.sensitivity ? ` (sensitivity=${input.sensitivity})` : "")
      );
    }

    const score = (e: { profile: ModelProfile }): number => {
      const p = e.profile;
      const latency = p.latency_class === "fast" ? 3 : p.latency_class === "medium" ? 2 : 1;
      const cheap = 6 - p.cost_class;
      switch (mode) {
        case "FAST":
          return latency * 30 + p.quality_class;
        case "CHEAP":
          return cheap * 30 + p.quality_class;
        case "QUALITY":
        case "CRITIC":
          return p.quality_class * 30 + latency;
        default: {
          // AUTO/LOCAL: balansert, purpose-justert (§15: kost som signal, ikke hard cap).
          let quality = 2;
          let cost = 1;
          if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) quality = 3;
          if (input.purpose && CHEAP_PURPOSES.includes(input.purpose)) {
            cost = 3;
            quality = 1;
          }
          // D-79 §3/§7: PRIVATE/BUSINESS_CONFIDENTIAL foretrekker lokal MYK (bonus,
          // ikke et hardt krav - D-23 "preferably local... or an approved paid
          // provider") - lokal vinner AUTO-ranking når faktisk tilgjengelig/frisk,
          // men blokkerer ALDRI en allerede kvalifisert betrodd sky-provider.
          const localBonus =
            p.locality === "local" &&
            (input.sensitivity === "PRIVATE" || input.sensitivity === "BUSINESS_CONFIDENTIAL")
              ? 1000
              : 0;
          return p.quality_class * quality * 10 + cheap * cost * 10 + latency + localBonus;
        }
      }
    };

    // Health-sortering (§11): UNAVAILABLE ekskluderes, RATE_LIMITED bakerst.
    const rankedIgnoringHealth = [...eligible].sort((a, b) => score(b) - score(a));
    const healthy = eligible.filter((e) => e.state !== "UNAVAILABLE");
    if (healthy.length === 0) {
      throw new NoEligibleProviderError("alle kvalifiserte providere er UNAVAILABLE");
    }
    const ranked = healthy.sort((a, b) => {
      const aLimited = a.state === "RATE_LIMITED" ? 1 : 0;
      const bLimited = b.state === "RATE_LIMITED" ? 1 : 0;
      if (aLimited !== bLimited) return aLimited - bLimited;
      return score(b) - score(a);
    });

    const top = ranked[0] as (typeof ranked)[number];
    const idealTop = rankedIgnoringHealth[0] as (typeof ranked)[number];
    let reason: RoutingReason;
    if (top.profile.provider !== idealTop.profile.provider) {
      reason = idealTop.state === "RATE_LIMITED" ? "RATE_LIMIT_FALLBACK" : "PRIMARY_UNHEALTHY";
    } else if (mode === "LOCAL") {
      reason = "LOCAL_REQUIRED";
    } else if (mode === "CRITIC") {
      reason = "CRITIC_REQUIRED";
    } else if (required.has("vision")) {
      reason = "VISION_REQUIRED";
    } else if (input.needs_structured) {
      reason = "STRUCTURED_REQUIRED";
    } else if (
      (input.sensitivity === "PRIVATE" || input.sensitivity === "BUSINESS_CONFIDENTIAL") &&
      top.profile.locality === "local"
    ) {
      // D-80 §7: sensitiv + lokal tilgjengelig/frisk => lokal-bonusen avgjorde valget.
      reason = "PRIVACY_PREFERS_LOCAL";
    } else if (input.sensitivity !== "PUBLIC_OR_LOW_SENSITIVITY" && sensitivityExcludedCount > 0) {
      // D-81 P0-fiks: minst én ellers-kvalifisert kandidat (typisk gratis-tier) ble
      // ekskludert - GJELDER OGSÅ udefinert sensitivitet (fail-safe, se isSensitivityEligible()).
      reason = "PRIVACY_RESTRICTED";
    } else if (mode === "FAST") {
      reason = "LOW_LATENCY";
    } else if (mode === "CHEAP" || (input.purpose && CHEAP_PURPOSES.includes(input.purpose))) {
      reason = "LOW_COST";
    } else if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) {
      reason = "REASONING_REQUIRED";
    } else if (ranked.length === 1) {
      reason = "ONLY_AVAILABLE";
    } else {
      reason = "DEFAULT_BALANCED";
    }

    return {
      mode,
      reason,
      candidates: ranked.map((e) => ({ provider: e.profile.provider, model: e.model }))
    };
  }
}
