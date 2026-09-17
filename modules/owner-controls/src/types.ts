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
