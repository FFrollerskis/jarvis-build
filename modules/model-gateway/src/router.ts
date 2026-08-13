import type { ModelPurpose, RouterMode, RoutingReason } from "@jarvis/contracts";
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
      return { mode, reason: "OWNER_OVERRIDE", candidates: [{ provider: name, model: rt.model }] };
    }

    const required = new Set<ModelCapability>(input.required_capabilities ?? []);
    if (input.purpose === "VISION") required.add("vision");
    if (input.purpose && REASONING_PURPOSES.includes(input.purpose)) required.add("reasoning");
    if (input.needs_structured) required.add("structured_output");

    const eligible: Array<{ profile: ModelProfile; model: string; state: string }> = [];
    for (const [name, rt] of providers) {
      if (!rt.configured) continue;
      const profile = this.registry.profileOrGeneric(name, rt.model);
      if (mode === "LOCAL" && profile.locality !== "local") continue;
      if (![...required].every((c) => profile.capabilities.includes(c))) continue;
      eligible.push({ profile, model: rt.model, state: this.health.state(name, true) });
    }
    if (eligible.length === 0) {
      if (mode === "LOCAL") throw new LocalModelUnavailableError();
      throw new NoEligibleProviderError(
        `ingen konfigurert provider dekker [${[...required].join(",")}]`
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
          return p.quality_class * quality * 10 + cheap * cost * 10 + latency;
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
