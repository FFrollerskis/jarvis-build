import type { IdentityContext } from "@jarvis/contracts";
import type { KillSwitch } from "./kill-switch.ts";

/**
 * Execution Authority Engine (Masterplan v4.0 / UA0-AUTHORITY).
 * A-D er RISIKOKLASSER, ikke permission-klasser: for owner-tenant med
 * owner-tilkoblet capability gis authority_mode = SOVEREIGN og autonom
 * utførelse - sikkerheten leveres av preflight/readback/idempotens/
 * before-after-evidens/recovery + owner-kontroller (pause/freeze/revoke/kill),
 * ikke av obligatorisk menneskelig approval. Andre tenants/delegater er scoped.
 */
export type AuthorityMode = "SOVEREIGN" | "SCOPED" | "DENIED";

export interface ExecutionContext {
  tenant_id: string;
  owner_id: string;
  actor_type: "owner" | "agent" | "delegate";
  agent_id?: string;
  connector_id: string;
  capability: string;
  action: string;
  risk_class: "A" | "B" | "C" | "D";
  authority_source: string;
  trace_id: string;
}

export interface AuthorityConfig {
  owner_person_id: string;
  /** Tenants der eieren har full sovereign authority. */
  owner_tenants: readonly string[];
}

export function resolveAuthorityMode(config: AuthorityConfig | undefined, identity: IdentityContext): AuthorityMode {
  if (!config) {
    return "SCOPED"; // legacy-modus: eksisterende approval-regler gjelder
  }
  if (
    identity.person_id === config.owner_person_id &&
    config.owner_tenants.includes(identity.tenant_id) &&
    identity.delegation_id === undefined // delegat arver ALDRI owner authority implisitt
  ) {
    return "SOVEREIGN";
  }
  return "SCOPED";
}

/**
 * Owner-kontroller (v4.0 §Owner Override): globale, deterministiske brytere
 * som håndheves i execution path - ikke approval-flow. Reversible.
 */
export class OwnerControls {
  private readonly frozenConnectors = new Set<string>();
  private readonly revokedCredentials = new Set<string>();

  constructor(readonly killSwitch: KillSwitch) {}

  pauseAll(reason: string): void {
    this.killSwitch.activate(`owner_pause: ${reason}`);
  }
  resumeAll(): void {
    this.killSwitch.deactivate();
  }
  freezeConnector(connectorId: string): void {
    this.frozenConnectors.add(connectorId);
  }
  unfreezeConnector(connectorId: string): void {
    this.frozenConnectors.delete(connectorId);
  }
  isFrozen(connectorId: string): boolean {
    return this.frozenConnectors.has(connectorId);
  }
  revokeCredential(ref: string): void {
    this.revokedCredentials.add(ref);
  }
  restoreCredential(ref: string): void {
    this.revokedCredentials.delete(ref);
  }
  isRevoked(ref: string): boolean {
    return this.revokedCredentials.has(ref);
  }
}
