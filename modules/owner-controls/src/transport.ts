import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "./service.ts";

/**
 * K1 (Sovereign graduation, D-164): eierens SAMLEDE kill-switch-/frys-/
 * tilbakekalls-kontrollflate, eksponert som et vanlig ToolGateway-verktøy
 * (`tool_id: "owner_controls"`) - SAMME identitets-/skjema-disiplin som
 * `SituationsTransport` (D-160)/`ExecutiveTransport` (D-162): identitet
 * KOMMER UTELUKKENDE FRA `ToolInvocationContext` (D-68), ALDRI fra
 * `parameters`. `strict()`-skjemaer uten identitetsfelt - en kaller som
 * prøver å oppgi `actor_person_id` selv blir avvist som `invalid_parameters`
 * FØR denne transporten nås. Manglende context feiler lukket
 * (`owner_controls_missing_invocation_context`).
 *
 * Selve autoritets-porten (er kalleren FAKTISK eieren?) håndheves INNI
 * `KillSwitch`/`OwnerControls` sine `*Durable()`-metoder
 * (`assertOwnerControlAuthorized`, samme mønster som `DomainPauseRegistry`)
 * - denne transporten videresender kun `context.identity.person_id`
 * uendret, den fabrikkerer eller eskalerer ALDRI en identitet selv.
 */
export class OwnerControlsTransport implements ToolTransport {
  constructor(private readonly service: OwnerControlsService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.person_id !== "string") {
      throw new Error("owner_controls_missing_invocation_context");
    }
    const actor = identity.person_id;

    switch (action) {
      case "get_control_state": {
        const state = await this.service.getControlState();
        return { data: state as unknown as JsonValue };
      }
      case "activate_kill_switch": {
        await this.service.activateKillSwitch(requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "deactivate_kill_switch": {
        await this.service.deactivateKillSwitch(actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "freeze_connector": {
        await this.service.freezeConnector(requireString(parameters, "connector_id"), requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "unfreeze_connector": {
        await this.service.unfreezeConnector(requireString(parameters, "connector_id"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "revoke_credential": {
        await this.service.revokeCredential(requireString(parameters, "credential_ref"), requireString(parameters, "reason"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      case "restore_credential": {
        await this.service.restoreCredential(requireString(parameters, "credential_ref"), actor);
        return { data: (await this.service.getControlState()) as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_owner_controls_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene. `get_control_state` er klasse A (les - MÅ
 * ALLTID være tilgjengelig, også når kill switch er aktiv - se
 * `PolicyGateway.authorize()` sitt eksplisitte unntak). `activate_kill_switch`/
 * `deactivate_kill_switch` er klasse D (den ENE, mest alvorlige bryteren i
 * hele systemet - blokkerer/gjenåpner ALT, uansett capability-klasse eller
 * tool_id - samme severity-nivå som betaling/sletting/lås/alarm i
 * CapabilityClass sin egen doc). `freeze_connector`/`unfreeze_connector`/
 * `revoke_credential`/`restore_credential` er klasse C (samme nivå som
 * `situations.pause_domain` - en enkelt, navngitt, reversibel begrensning,
 * IKKE systemomfattende). Sovereign eier får INSTANT utførelse for BÅDE C
 * og D (ingen approval-friksjon, masterplanens "one-tap pause/override/
 * revoke") - alle andre identiteter går gjennom vanlig mandat-/godkjennings-
 * logikk i `PolicyGateway.authorize()`, UENDRET av denne pakken.
 */
export function ownerControlsToolDefinitions(transport: OwnerControlsTransport): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  return [
    {
      tool_id: "owner_controls", action: "get_control_state",
      description: "Les samlet eier-kontroll-tilstand: kill switch, frosne connectorer, tilbakekalte credentials",
      input_schema: record({}), capability_class: "A", scopes: ["owner_controls.read"],
      reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "activate_kill_switch",
      description: "Stans HELE systemet umiddelbart, uansett capability-klasse eller tool_id",
      input_schema: record({ reason: z.string() }), capability_class: "D", scopes: ["owner_controls.kill_switch"],
      reversible: true, rollback_procedure: "deactivate_kill_switch", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "deactivate_kill_switch",
      description: "Opphev kill switch og gjenoppta normal drift",
      input_schema: record({}), capability_class: "D", scopes: ["owner_controls.kill_switch"],
      reversible: true, rollback_procedure: "activate_kill_switch", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "freeze_connector",
      description: "Frys ÉN navngitt connector/tool_id umiddelbart",
      input_schema: record({ connector_id: z.string(), reason: z.string() }), capability_class: "C", scopes: ["owner_controls.freeze"],
      reversible: true, rollback_procedure: "unfreeze_connector", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "unfreeze_connector",
      description: "Opphev frys for ÉN navngitt connector/tool_id",
      input_schema: record({ connector_id: z.string() }), capability_class: "C", scopes: ["owner_controls.freeze"],
      reversible: true, rollback_procedure: "freeze_connector", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "revoke_credential",
      description: "Tilbakekall ÉN navngitt credential_ref umiddelbart",
      input_schema: record({ credential_ref: z.string(), reason: z.string() }), capability_class: "C", scopes: ["owner_controls.revoke"],
      reversible: true, rollback_procedure: "restore_credential", idempotent_external: true, ...common
    },
    {
      tool_id: "owner_controls", action: "restore_credential",
      description: "Gjenopprett ÉN navngitt, tidligere tilbakekalt credential_ref",
      input_schema: record({ credential_ref: z.string() }), capability_class: "C", scopes: ["owner_controls.revoke"],
      reversible: true, rollback_procedure: "revoke_credential", idempotent_external: true, ...common
    }
  ];
}
