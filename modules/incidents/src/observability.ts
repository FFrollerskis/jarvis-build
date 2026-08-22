import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { redactSecrets } from "./redact.ts";
import type { IncidentService } from "./service.ts";
import type { IncidentEvidence } from "./types.ts";

export interface AcquireContainerLogsInput {
  container: string;
  since?: string;
  until?: string;
  tail?: number;
}

export type AcquisitionOutcome =
  | { status: "acquired"; evidence: IncidentEvidence[] }
  | { status: "unavailable"; reason: string };

/**
 * D-105 Part D/E: reell observability-innhenting - går UTELUKKENDE gjennom
 * `ToolGateway.execute()` (`docker.get_logs`, klasse A), ALDRI et direkte
 * transport-kall (samme "ingen bypass"-prinsipp som D-104s `attemptRecovery`).
 * Bundet (hard `tail`-grense håndheves ALLEREDE i selve transporten, se
 * docker-transport.ts) - INGEN ubegrenset rå loggdumping inn i kanonisk
 * minne. Redigert TO ganger (transport + her) - forsvar-i-dybden. En
 * leverandørfeil (docker utilgjengelig/timeout) gir et EKSPLISITT
 * `unavailable`-utfall, ALDRI en stille "ingen bevis funnet"/fabrikkert
 * "healthy" (byggeordrens §R).
 */
export async function acquireContainerLogs(
  deps: { gateway: ToolGateway; incidents: IncidentService },
  identity: IdentityContext,
  memorySpace: MemorySpace,
  incidentId: string,
  input: AcquireContainerLogsInput
): Promise<AcquisitionOutcome> {
  const result = await deps.gateway.execute({
    identity,
    tool_id: "docker",
    action: "get_logs",
    parameters: {
      name: input.container,
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.tail !== undefined ? { tail: input.tail } : {})
    }
  });
  if (!result.ok) {
    return { status: "unavailable", reason: result.reason };
  }
  const lines = (result.data ?? []) as unknown as Array<{ timestamp: string; message: string }>;
  const evidence: IncidentEvidence[] = [];
  for (const line of lines) {
    const row = await deps.incidents.addEvidence(identity.tenant_id, memorySpace, incidentId, {
      source_type: "log",
      source_ref: input.container,
      summary: redactSecrets(line.message).slice(0, 2000),
      observed_at: line.timestamp
    });
    evidence.push(row);
  }
  return { status: "acquired", evidence };
}

/** Byggeordrens §S: enkel leverandørhelse-sjekk (list_containers, klasse A) - samme ToolGateway-vei, ingen egen probe-mekanisme. */
export async function dockerProviderStatus(
  gateway: ToolGateway,
  identity: IdentityContext
): Promise<{ available: boolean; reason?: string; containers?: JsonValue }> {
  const result = await gateway.execute({ identity, tool_id: "docker", action: "list_containers", parameters: {} });
  if (!result.ok) {
    return { available: false, reason: result.reason };
  }
  return { available: true, containers: result.data ?? null };
}
