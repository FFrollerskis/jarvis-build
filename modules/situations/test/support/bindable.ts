import type { ToolGateway } from "@jarvis/tool-gateway";
import type { AutonomyDefinitionLookup } from "../../src/autonomy-guard.ts";

/**
 * WP-G4b K1 (D-484): bindbarhet til autonom ACT er DEFAULT-DENY (en egenskap på verktøydefinisjonen). Testverktøyene som bindes til autonom ACT i situasjonstestene erklærer den eksplisitt med denne (testbare) begrunnelsen;
 * et testverktøy UTEN den er ikke bindbart (nettopp det som er testet i `wpg4b-bindability.test.ts`).
 */
export const TEST_BINDABLE = { reason: "testverktøy uten ekstern effekt: brukes kun til å bevise situasjonsmotorens autonomi-vakter" } as const;

/** Motorens bind-tid-oppslag mot «den siste gatewayen testen bygde» (motoren konstrueres før gatewayen, som i produksjon der oppslaget er `toolGateway.get`). */
export function lookupFrom(current: () => Pick<ToolGateway, "get"> | undefined): AutonomyDefinitionLookup {
  return (toolId, action) => current()?.get(toolId, action);
}
