/**
 * UA-1 capability registry (BO-08 §7): konfigurerbart og testbart - routing
 * skjer mot registry-data, aldri som if/else-blokker per provider i koden.
 *
 * UA-2 P1B-A (D-43 §3): `vision`-flagget må reflektere FAKTISK wiret
 * bildestøtte i den tilhørende adapteren (`packages/provider-adapters`),
 * ALDRI et informativt/aspirasjonelt leverandør-fakta. `anthropic` og (D-81)
 * `gemma_hosted` har ekte bilde-mapping (se `anthropic.ts` sin
 * `toAnthropicContent()` og `gemma.ts` sin `toGemmaParts()`) - `openai`/
 * `gemini`/`local_llm` støtter i praksis vision hos leverandøren, men
 * adapteren her bruker fortsatt `textOnly()` og ville stille droppet
 * bildedata; å beholde `vision` i profilen ville latt routeren sende et
 * vision-krevd kall til en adapter som degraderer det til ren tekst. Rettes
 * når disse adapterne faktisk får bilde-mapping (egen fremtidig runde).
 *
 * D-80 (samme regel, samme rigiditet): `streaming` er FJERNET fra `gemini`
 * sin profil her - adapteren (`gemini.ts`) har ALDRI hatt en `.stream()`-
 * metode (kun `generateContent`, ikke `streamGenerateContent`), så den
 * tidligere `streaming: true`-påstanden var en registry/adapter-mismatch
 * (fanget under D-80 sin arkitekturgjennomgang - `ModelGateway.executePlan()`
 * degraderer allerede trygt til enkelt-delta for adaptere uten `.stream()`,
 * så dette var ALDRI en krasj-bug, kun en unøyaktig capability-påstand som
 * brøt filens egen regel over). Samme grense gjelder de NYE `gemma_hosted`/
 * `local_llm`-profilene - INGEN av dem hevder `streaming` (D-81: bekreftet
 * `PROVIDER_SUPPORT=true`/`ADAPTER_SUPPORT=false` for `gemma_hosted` via
 * offisiell Gemini API-dokumentasjon - `streamGenerateContent` er en generisk
 * metode leverandøren støtter, men adapteren implementerer den bevisst ikke
 * ennå, se `gemma.ts`).
 */
export type ModelCapability =
  | "text"
  | "reasoning"
  | "vision"
  | "tool_calling"
  | "structured_output"
  | "streaming";

export interface ModelProfile {
  provider: string;
  /** Informativ default-modell (adapterens konfigurerte modell vinner runtime). */
  model: string;
  capabilities: ModelCapability[];
  context_tokens: number;
  locality: "local" | "cloud";
  /** Relativ kost 1 (billigst) - 5 (dyrest). */
  cost_class: 1 | 2 | 3 | 4 | 5;
  /** Relativ kvalitet 1 (svakest) - 5 (best). */
  quality_class: 1 | 2 | 3 | 4 | 5;
  latency_class: "fast" | "medium" | "slow";
  /**
   * D-80/D-81 (§3 personvern-grense): `true` KUN for hostede sky-providere som
   * kjører på et delt gratis-tier-kvotebasseng (i dag: `gemma_hosted`).
   * Routeren (`router.ts`) krever et EKSPLISITT
   * `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for at denne providertypen
   * skal være kvalifisert (D-81 P0-fiks: udefinert/ukjent sensitivitet blir
   * ALDRI tolket som "public") - se `DataSensitivity` i `@jarvis/contracts`.
   * Default `false` for ALLE eksisterende betalte/lokale providere (uendret
   * tillit - denne sliceen innfører INGEN ny begrensning på allerede
   * konfigurerte betalte leverandører, kun på det NYE gratis-tier-tillegget).
   */
  hosted_free_tier?: boolean;
}

/** Defaults matcher adapterens env-defaults; overstyres via konstruktør/konfig. */
export const DEFAULT_PROFILES: ModelProfile[] = [
  {
    provider: "openai",
    model: "gpt-5",
    capabilities: ["text", "reasoning", "tool_calling", "structured_output", "streaming"],
    context_tokens: 272_000,
    locality: "cloud",
    cost_class: 3,
    quality_class: 5,
    latency_class: "medium"
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    capabilities: ["text", "reasoning", "vision", "tool_calling", "streaming"],
    context_tokens: 200_000,
    locality: "cloud",
    cost_class: 4,
    quality_class: 5,
    latency_class: "medium"
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    // D-80: `streaming` fjernet - adapteren har aldri hatt `.stream()` (se filkommentaren over).
    capabilities: ["text", "reasoning", "structured_output"],
    context_tokens: 1_000_000,
    locality: "cloud",
    cost_class: 2,
    quality_class: 4,
    latency_class: "fast"
  },
  {
    // D-80 (AI Mesh Gemma-first): hostet Gemma via Gemini API - standard
    // rimelig/rask kandidat for ordinære 24/7-oppgaver (§4) NÅR
    // personvernpolicyen tillater det. `hosted_free_tier: true` er den
    // eneste mekanismen som beskytter sensitivt innhold fra gratis-tieret
    // (§3, D-81 P0-fiks: udefinert sensitivitet ekskluderer OGSÅ) - se
    // `router.ts` for hvordan dette faktisk håndheves. `vision` lagt til i
    // D-81 - `gemma.ts` sin `toGemmaParts()` har EKTE bilde-mapping
    // (bekreftet mot Gemini API-dokumentasjon at Gemma 4 støtter
    // bildeforståelse), samme personvern-gate gjelder UENDRET for
    // vision-forespørsler til denne provideren.
    provider: "gemma_hosted",
    model: "gemma-4-26b-a4b-it",
    capabilities: ["text", "reasoning", "vision", "tool_calling", "structured_output"],
    context_tokens: 128_000,
    locality: "cloud",
    cost_class: 1,
    quality_class: 4,
    latency_class: "fast",
    hosted_free_tier: true
  },
  {
    // D-80 §6: provider-nøytral lokal-inferens (OpenAI-kompatibelt
    // endepunkt). `quality_class` er en konservativ default inntil en ekte
    // lokal modell er konfigurert og evaluert - IKKE en påstand om en
    // spesifikk modells faktiske kvalitet (kalleren styrer selv hvilken
    // modell som faktisk kjører via `LOCAL_LLM_MODEL`).
    provider: "local_llm",
    model: "local-model",
    capabilities: ["text", "tool_calling", "structured_output"],
    context_tokens: 32_000,
    locality: "local",
    cost_class: 1,
    quality_class: 3,
    latency_class: "medium",
    hosted_free_tier: false
  },
  {
    provider: "kimi",
    model: "kimi-latest",
    capabilities: ["text", "reasoning", "tool_calling"],
    context_tokens: 256_000,
    locality: "cloud",
    cost_class: 2,
    quality_class: 4,
    latency_class: "medium"
  },
  {
    provider: "ollama",
    model: "llama3.1",
    capabilities: ["text", "structured_output"],
    context_tokens: 128_000,
    locality: "local",
    cost_class: 1,
    quality_class: 2,
    latency_class: "medium"
  },
  {
    // Deterministisk testprovider - generisk tekstprofil så eksisterende
    // oppsett uten registry-endringer fortsetter å fungere. P1A: streamer og
    // skripter tool calls deterministisk (matcher ScriptedAdapter).
    provider: "scripted",
    model: "scripted-1",
    capabilities: ["text", "structured_output", "reasoning", "streaming", "tool_calling"],
    context_tokens: 32_000,
    locality: "local",
    cost_class: 1,
    quality_class: 1,
    latency_class: "fast"
  }
];

export class CapabilityRegistry {
  private readonly byProvider = new Map<string, ModelProfile>();

  constructor(profiles: ModelProfile[] = DEFAULT_PROFILES) {
    for (const p of profiles) {
      this.byProvider.set(p.provider, p);
    }
  }

  get(provider: string): ModelProfile | undefined {
    return this.byProvider.get(provider);
  }

  list(): ModelProfile[] {
    return [...this.byProvider.values()];
  }

  /** Ukjent provider behandles som generisk tekstmodell (bakoverkompatibelt). */
  profileOrGeneric(provider: string, model: string): ModelProfile {
    return (
      this.byProvider.get(provider) ?? {
        provider,
        model,
        capabilities: ["text"],
        context_tokens: 32_000,
        locality: "cloud",
        cost_class: 3,
        quality_class: 3,
        latency_class: "medium"
      }
    );
  }
}
