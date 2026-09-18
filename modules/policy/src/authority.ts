import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import type { KillSwitch } from "./kill-switch.ts";
import {
  assertOwnerControlAuthorized,
  deleteControlState,
  listControlState,
  readControlState,
  writeControlState,
  type OwnerControlAuthority as OwnerControlMutationAuthority
} from "./owner-control-store.ts";

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

const FREEZE_KIND = "connector_freeze";
const REVOKE_KIND = "credential_revocation";

/**
 * Owner-kontroller (v4.0 §Owner Override): globale, deterministiske brytere
 * som håndheves i execution path - ikke approval-flow. Reversible.
 *
 * K1 (Sovereign graduation, D-164): de RENE synkrone metodene under er
 * BEVISST UENDRET (samme presedens som `KillSwitch`, se der sitt filhode) -
 * `*Durable()`-metodene legger til et VARIG, DELT (api-/worker-prosess ser
 * SAMME rad LIVE) lag mot `owner_control_state`
 * (058_owner_control_authority.sql) NÅR et `pool` er gitt ved konstruksjon.
 * `ToolGateway.execute()` kaller `isFrozenDurable()`/`isRevokedDurable()`
 * (ALDRI de rene synkrone) i produksjon - se gateway.ts.
 */
export class OwnerControls {
  private readonly frozenConnectors = new Set<string>();
  private readonly revokedCredentials = new Set<string>();

  constructor(
    readonly killSwitch: KillSwitch,
    private readonly pool?: pg.Pool,
    private readonly authority?: OwnerControlMutationAuthority
  ) {}

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

  /** Den AUTORITATIVE, LIVE sjekken - se `KillSwitch.isActiveDurable()` sitt filhode for identisk begrunnelse (cross-prosess-konsistens > billig cache). */
  async pauseAllDurable(reason: string, actorPersonId?: string): Promise<void> {
    return this.killSwitch.activateDurable(`owner_pause: ${reason}`, actorPersonId);
  }
  async resumeAllDurable(actorPersonId?: string): Promise<void> {
    return this.killSwitch.deactivateDurable(actorPersonId);
  }

  async isFrozenDurable(connectorId: string): Promise<boolean> {
    if (!this.pool) return this.isFrozen(connectorId);
    return (await readControlState(this.pool, FREEZE_KIND, connectorId)) !== null;
  }
  async freezeConnectorDurable(connectorId: string, reason: string, actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await writeControlState(this.pool, FREEZE_KIND, connectorId, reason, actorPersonId);
    }
    this.freezeConnector(connectorId);
  }
  async unfreezeConnectorDurable(connectorId: string, actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await deleteControlState(this.pool, FREEZE_KIND, connectorId);
    }
    this.unfreezeConnector(connectorId);
  }
  async listFrozenConnectorsDurable(): Promise<{ connector_id: string; reason: string; actor_person_id: string | null; changed_at: string }[]> {
    if (!this.pool) return [...this.frozenConnectors].map((connector_id) => ({ connector_id, reason: "", actor_person_id: null, changed_at: new Date().toISOString() }));
    return (await listControlState(this.pool, FREEZE_KIND)).map((r) => ({ connector_id: r.control_target, reason: r.reason, actor_person_id: r.actor_person_id, changed_at: r.changed_at }));
  }

  async isRevokedDurable(ref: string): Promise<boolean> {
    if (!this.pool) return this.isRevoked(ref);
    return (await readControlState(this.pool, REVOKE_KIND, ref)) !== null;
  }
  async revokeCredentialDurable(ref: string, reason: string, actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await writeControlState(this.pool, REVOKE_KIND, ref, reason, actorPersonId);
    }
    this.revokeCredential(ref);
  }
  async restoreCredentialDurable(ref: string, actorPersonId?: string): Promise<void> {
    assertOwnerControlAuthorized(this.pool, this.authority, actorPersonId);
    if (this.pool) {
      await deleteControlState(this.pool, REVOKE_KIND, ref);
    }
    this.restoreCredential(ref);
  }
  async listRevokedCredentialsDurable(): Promise<{ credential_ref: string; reason: string; actor_person_id: string | null; changed_at: string }[]> {
    if (!this.pool) return [...this.revokedCredentials].map((credential_ref) => ({ credential_ref, reason: "", actor_person_id: null, changed_at: new Date().toISOString() }));
    return (await listControlState(this.pool, REVOKE_KIND)).map((r) => ({ credential_ref: r.control_target, reason: r.reason, actor_person_id: r.actor_person_id, changed_at: r.changed_at }));
  }

  /** Fail-CLOSED oppstartsgjenoppretting for frys/tilbakekall - se `KillSwitch.restore()` sitt filhode. `killSwitch.restore()` kalles SEPARAT (denne metoden rører aldri killSwitch). */
  async restore(): Promise<void> {
    if (!this.pool) return;
    this.frozenConnectors.clear();
    for (const row of await listControlState(this.pool, FREEZE_KIND)) this.frozenConnectors.add(row.control_target);
    this.revokedCredentials.clear();
    for (const row of await listControlState(this.pool, REVOKE_KIND)) this.revokedCredentials.add(row.control_target);
  }
}
