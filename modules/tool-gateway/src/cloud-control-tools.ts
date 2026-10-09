import type { ToolDefinition, ToolTransport } from "./gateway.ts";
import { UnconfiguredHttpTransport } from "./integrations.ts";
import { cloudflareToolDefinitions } from "./cloudflare-tools.ts";

/**
 * WP-E1 (UA-5 Developer & Cloud Control Plane): ÉN komposisjons-inngang for de kontrollerte skymålene som kommer i tillegg til GitHub/Vercel/GCE/Docker
 * (Cloudflare, Langfuse, Infisical, Postgres-drift). `main.ts` sender resultatet inn i `additionalTools` (samme ENE `toolGateway.register(tool)`-løkke
 * som resten - ingen parallell registreringsvei), og `INFRA_GATED_TOOL_IDS` er den ENE sannheten om hvilke verktøy-id-er `InfraExecutionGate` gjelder for.
 *
 * Alle verktøyene er SOVENDE til eieren har satt sin credential (`credential_unavailable`), og uten en transport faller de gjennom til
 * `UnconfiguredHttpTransport` (kaster `<id>_not_configured`) - samme mønster som `firstWaveTools`.
 */
export interface CloudControlConfig {
  /** Eksakte sone-id-er eieren har autorisert for Cloudflare-skriving (`JARVIS_CLOUDFLARE_MUTATION_ZONES`, parset ved oppstart). Tom = ingen skriving. */
  cloudflareMutationZones?: ReadonlySet<string>;
}

export type CloudControlTransports = Partial<Record<"cloudflare" | "langfuse" | "infisical" | "postgres_ops", ToolTransport>>;

export function cloudControlToolDefinitions(transports: CloudControlTransports = {}, config: CloudControlConfig = {}): ToolDefinition[] {
  const transport = (key: keyof CloudControlTransports): ToolTransport => transports[key] ?? new UnconfiguredHttpTransport(key);
  return [
    ...cloudflareToolDefinitions(transport("cloudflare"), { mutationZones: config.cloudflareMutationZones ?? new Set<string>() })
  ];
}

/**
 * Verktøy-id-er `InfraExecutionGate` (NORMAL/DEGRADED/PAUSED) gjelder for: klasse A (lesing/diagnostikk) stanses ALDRI, DEGRADED stanser klasse D,
 * PAUSED stanser all skriving (B/C/D). WP-E1 utvidet mengden fra {github, docker}: `gce` og `vercel` hadde mutasjoner (start/stop, promote/rollback/env)
 * som en infra-pause IKKE stanset, og de nye skymålene hører hjemme her fra første dag.
 */
export const INFRA_GATED_TOOL_IDS: ReadonlySet<string> = new Set(["github", "docker", "gce", "vercel", "cloudflare", "langfuse", "infisical", "postgres_ops"]);
