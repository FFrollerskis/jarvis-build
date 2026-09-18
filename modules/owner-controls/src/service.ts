import type pg from "pg";
import { writeAudit, withTenantTransaction, type SessionGrantService } from "@jarvis/core";
import { assertOwnerControlAuthorized, type KillSwitch, type OwnerControlAuthority, type OwnerControls } from "@jarvis/policy";
import type { DeviceRevocationResult, FrozenConnectorEntry, OwnerControlState, RevokedCredentialEntry } from "./types.ts";

/**
 * D-174 (B2): device-tilbakekallings-avhengighetene er BEVISST valgfrie
 * (samme mønster som `OwnerControls`/`KillSwitch` sitt eget valgfrie
 * `pool`/`authority`-par) - `k1-owner-control-authority-live.ts`-skriptet
 * og eksisterende enhetstester konstruerer `OwnerControlsService` UTEN
 * device-avhengigheter og skal fortsette å virke uendret; `revoke_device`
 * feiler LUKKET (`owner_controls_device_revocation_not_configured`), ALDRI
 * et stille no-op, når de ikke er koblet til (kun `apps/api/src/main.ts`
 * kobler dem til i dag - se der).
 */
export interface OwnerControlsDeviceRevocationDeps {
  pool: pg.Pool;
  grants: SessionGrantService;
  authority?: OwnerControlAuthority;
}

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
    private readonly ownerControls: OwnerControls,
    private readonly deviceRevocation?: OwnerControlsDeviceRevocationDeps
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

  /**
   * D-174 (B2, task F): eier-vendt tilbakekalling av ALLE utestående
   * `session_grants` for ÉN enhet - SAMME kanoniske primitiv
   * (`SessionGrantService.revokeForDeviceOn()`) og kalle-mønster (transaksjon
   * + audit i SAMME transaksjon) som `DeviceEnrollmentService` allerede
   * bruker ved nøkkelrotasjon (device-enrollment-service.ts). INGEN
   * duplikat session-grant-tilstand her - denne metoden er en tynn,
   * autoritets-sjekket ToolGateway-vendt innpakning rundt DEN samme
   * `session_grants`-tabellen.
   *
   * Fail-CLOSED for: (a) manglende device-avhengigheter (ikke koblet til -
   * se `OwnerControlsDeviceRevocationDeps`), (b) `actorPersonId` som ikke
   * matcher konfigurert `authority.owner_person_id`
   * (`assertOwnerControlAuthorized` - SAMME eier-autoritetsmodell som
   * `KillSwitch`/`OwnerControls` sine egne `*Durable()`-metoder, IKKE en ny
   * eller svakere sjekk). `tenantId`/`deviceId` kommer fra ToolGateway-
   * parametre (IKKE fra identitetskonteksten) - dette er BEVISST, fordi
   * eieren må kunne tilbakekalle EN ANNEN persons/enhets sesjon (f.eks. en
   * delegat sin telefon), ikke bare sin egen; selve autoritets-porten over
   * er UAVHENGIG av HVILKEN tenant/enhet som oppgis - en ikke-eier
   * identitet avvises uansett tenant/device-verdi.
   */
  async revokeDevice(tenantId: string, deviceId: string, reason: string, actorPersonId: string): Promise<DeviceRevocationResult> {
    if (!this.deviceRevocation) throw new Error("owner_controls_device_revocation_not_configured");
    const { pool, grants, authority } = this.deviceRevocation;
    assertOwnerControlAuthorized(pool, authority, actorPersonId);
    return withTenantTransaction(pool, tenantId, async (client) => {
      const revokedGrants = await grants.revokeForDeviceOn(client, tenantId, deviceId);
      await writeAudit(
        client,
        { tenant_id: tenantId, person_id: actorPersonId, device_id: deviceId },
        {
          type: "owner_controls.device_revoked",
          decision: "ALLOW",
          reason,
          payload: { revoked_grants: revokedGrants }
        }
      );
      return { tenant_id: tenantId, device_id: deviceId, revoked_grants: revokedGrants };
    });
  }
}
