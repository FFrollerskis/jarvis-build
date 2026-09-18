import type { KillSwitch, OwnerControls } from "@jarvis/policy";
import type { FrozenConnectorEntry, OwnerControlState, RevokedCredentialEntry } from "./types.ts";

/**
 * K1 (Sovereign graduation, D-164): kanonisk owner-kontroll-tjeneste.
 * Konstruktøren tar de EKSISTERENDE `KillSwitch`/`OwnerControls`-
 * instansene direkte (SAMME instanser `apps/api/src/main.ts`/
 * `worker-main.ts` allerede konstruerer for `PolicyGateway`/`ToolGateway`)
 * - IKKE en egen, parallell kopi av tilstanden. Alle mutasjoner går via
 * `*Durable()` (aldri de rene synkrone metodene) - autoritets-sjekken
 * (`assertOwnerControlAuthorized`) skjer INNI disse metodene selv, mot
 * `actorPersonId` denne tjenesten ALLTID videresender uendret fra den
 * betrodde `ToolInvocationContext.identity.person_id` (D-68-disiplinen,
 * se transport.ts).
 */
export class OwnerControlsService {
  constructor(
    private readonly killSwitch: KillSwitch,
    private readonly ownerControls: OwnerControls
  ) {}

  async getControlState(): Promise<OwnerControlState> {
    const [killSwitchRow, frozen, revoked] = await Promise.all([
      this.killSwitch.currentStateDurable(),
      this.ownerControls.listFrozenConnectorsDurable(),
      this.ownerControls.listRevokedCredentialsDurable()
    ]);
    return {
      kill_switch: {
        active: killSwitchRow !== null,
        reason: killSwitchRow?.reason ?? null,
        actor_person_id: killSwitchRow?.actor_person_id ?? null,
        changed_at: killSwitchRow?.changed_at ?? null
      },
      frozen_connectors: frozen as FrozenConnectorEntry[],
      revoked_credentials: revoked as RevokedCredentialEntry[]
    };
  }

  async activateKillSwitch(reason: string, actorPersonId: string): Promise<void> {
    await this.killSwitch.activateDurable(reason, actorPersonId);
  }

  async deactivateKillSwitch(actorPersonId: string): Promise<void> {
    await this.killSwitch.deactivateDurable(actorPersonId);
  }

  async freezeConnector(connectorId: string, reason: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.freezeConnectorDurable(connectorId, reason, actorPersonId);
  }

  async unfreezeConnector(connectorId: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.unfreezeConnectorDurable(connectorId, actorPersonId);
  }

  async revokeCredential(credentialRef: string, reason: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.revokeCredentialDurable(credentialRef, reason, actorPersonId);
  }

  async restoreCredential(credentialRef: string, actorPersonId: string): Promise<void> {
    await this.ownerControls.restoreCredentialDurable(credentialRef, actorPersonId);
  }
}
