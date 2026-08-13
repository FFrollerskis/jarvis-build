/**
 * UA-1 capability registry (BO-08 §7): konfigurerbart og testbart - routing
 * skjer mot registry-data, aldri som if/else-blokker per provider i koden.
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
}

/** Defaults matcher adapterens env-defaults; overstyres via konstruktør/konfig. */
export const DEFAULT_PROFILES: ModelProfile[] = [
  {
    provider: "openai",
    model: "gpt-5",
    capabilities: ["text", "reasoning", "vision", "tool_calling", "structured_output", "streaming"],
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
    capabilities: ["text", "reasoning", "vision", "structured_output", "streaming"],
    context_tokens: 1_000_000,
    locality: "cloud",
    cost_class: 2,
    quality_class: 4,
    latency_class: "fast"
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
