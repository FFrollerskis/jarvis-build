/**
 * K1 (Sovereign graduation, D-164): JsonValue-vennlige speilinger av
 * `@jarvis/policy` sine `*Durable()`-returtyper, brukt av transporten sitt
 * grensesnitt mot ToolGateway (som krever `JsonValue`, ikke rike TS-typer -
 * samme grensekrysnings-mønster som `@jarvis/situations`/`@jarvis/executive`
 * sine egne `types.ts`).
 */
export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  actor_person_id: string | null;
  changed_at: string | null;
}

export interface FrozenConnectorEntry {
  connector_id: string;
  reason: string;
  actor_person_id: string | null;
  changed_at: string;
}

export interface RevokedCredentialEntry {
  credential_ref: string;
  reason: string;
  actor_person_id: string | null;
  changed_at: string;
}

/** Full, samlet snapshot for `owner_controls.get_control_state` OG for `executive.get_control_surface_status` sin komposisjon (D-164). */
export interface OwnerControlState {
  kill_switch: KillSwitchState;
  frozen_connectors: FrozenConnectorEntry[];
  revoked_credentials: RevokedCredentialEntry[];
}

/** D-174 (B2): resultat av `owner_controls.revoke_device` - antall grants tilbakekalt er kanonisk bevis, ALDRI antatt > 0. */
export interface DeviceRevocationResult {
  tenant_id: string;
  device_id: string;
  revoked_grants: number;
}

/**
 * D-175 (arkitekt-review 5250409538, BLOKKER B4): kastet av
 * `OwnerControlsService.revokeDevice()` når `device_id` IKKE finnes i den
 * AUTENTISERTE tenanten (`identity.tenant_id` - ALDRI et kaller-oppgitt
 * `tenant_id`-parameter, se service.ts sitt filhode). Fail-CLOSED, SAMME
 * navnekonvensjon som `CardNotFoundError`/`VendorNotFoundError` (ALDRI et
 * stille `ok:true`/`revoked_grants:0`-resultat for en enhet som hører til
 * EN ANNEN tenant eller aldri har eksistert i det hele tatt).
 */
export class DeviceNotFoundError extends Error {
  constructor(readonly deviceId: string) {
    super(`device_not_found:${deviceId}`);
    this.name = "DeviceNotFoundError";
  }
}
