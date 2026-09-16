import { z } from "zod";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "@jarvis/tool-gateway";
import type { DomainPauseRegistry } from "./domain-pause.ts";
import type { SituationEngine } from "./service.ts";

/**
 * UA-10 P1 AKTIVERING (D-160): eierens KONTROLLFLATE for Situation Engine,
 * eksponert som et vanlig ToolGateway-verktøy (`tool_id: "situations"`) -
 * SAMME mønster som `BusinessTransport` (D-49): identitet/tenant/space/aktør
 * kommer via zod-validerte `parameters` bygget av et BETRODD kallerlag
 * (API-handler/MeshToolExecutor-mapping), ALDRI av modell-output.
 *
 * Hver handling går gjennom `ToolGateway.execute()` -> `PolicyGateway.
 * authorize()` (sovereign eier-modus, KillSwitch, freeze) FØR den når hit,
 * og de muterende handlingene håndhever i tillegg motorens EGEN
 * sovereign-autoritet (`DomainPauseRegistry.assertAuthorized()`,
 * `SituationEngine.assertAutonomyAuthority()`) - to uavhengige porter,
 * ingen av dem alene.
 *
 * Dette lukker masterplanens "Owner can pause a domain or entire Situation
 * Engine instantly" i PRAKSIS (P0 beviste mekanismen, men hadde ingen
 * flate) og er samtidig den ene, stabile kontrakten UA-11 sin samlede
 * kontrollflate skal KOMPONERE - ikke omgå.
 */
export class SituationsTransport implements ToolTransport {
  constructor(
    private readonly engine: SituationEngine,
    private readonly domainPauses: DomainPauseRegistry
  ) {}

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;
    const actor = parameters["actor_person_id"] !== undefined ? String(parameters["actor_person_id"]) : undefined;

    switch (action) {
      case "get_queue": {
        const filter: { domain?: string; stage?: never; statusOpenOnly?: boolean } = {};
        if (parameters["domain"] !== undefined) filter.domain = String(parameters["domain"]);
        if (parameters["include_resolved"] === true) filter.statusOpenOnly = false;
        const rows = await this.engine.getQueue(tenantId, memorySpace, filter);
        return { data: rows as unknown as JsonValue };
      }
      case "resolve": {
        const row = await this.engine.resolve(tenantId, memorySpace, requireString(parameters, "situation_id"));
        return { external_id: row.situation_id, data: row as unknown as JsonValue };
      }
      case "pause_domain": {
        await this.domainPauses.pauseDurable(requireString(parameters, "domain"), requireString(parameters, "reason"), actor);
        return { data: { paused: this.domainPauses.pausedDomains() } };
      }
      case "unpause_domain": {
        await this.domainPauses.unpauseDurable(requireString(parameters, "domain"), actor);
        return { data: { paused: this.domainPauses.pausedDomains() } };
      }
      case "pause_all": {
        await this.domainPauses.pauseAllDurable(requireString(parameters, "reason"), actor);
        return { data: { paused: this.domainPauses.pausedDomains() } };
      }
      case "unpause_all": {
        await this.domainPauses.unpauseAllDurable(actor);
        return { data: { paused: this.domainPauses.pausedDomains() } };
      }
      case "get_pause_state": {
        return { data: { paused: this.domainPauses.pausedDomains() } };
      }
      case "get_notification_policy": {
        const policy = await this.engine.getNotificationPolicy(tenantId, memorySpace);
        return { data: (policy ?? null) as unknown as JsonValue };
      }
      case "set_notification_policy": {
        const policy = await this.engine.setNotificationPolicy(tenantId, memorySpace, {
          ...(parameters["quiet_hours_start_utc"] !== undefined ? { quiet_hours_start_utc: parameters["quiet_hours_start_utc"] as number | null } : {}),
          ...(parameters["quiet_hours_end_utc"] !== undefined ? { quiet_hours_end_utc: parameters["quiet_hours_end_utc"] as number | null } : {}),
          ...(parameters["resuppress_hours"] !== undefined ? { resuppress_hours: Number(parameters["resuppress_hours"]) } : {}),
          ...(actor !== undefined ? { actor_person_id: actor } : {})
        });
        return { data: policy as unknown as JsonValue };
      }
      case "list_autonomy_policies": {
        const rows = await this.engine.listAutonomyPolicies(tenantId, memorySpace);
        return { data: rows as unknown as JsonValue };
      }
      case "set_autonomy_policy": {
        const row = await this.engine.setAutonomyPolicy(
          tenantId,
          memorySpace,
          {
            domain: requireString(parameters, "domain"),
            tool_id: requireString(parameters, "tool_id"),
            action: requireString(parameters, "action"),
            ...(parameters["parameters"] !== undefined ? { parameters: parameters["parameters"] as Record<string, JsonValue> } : {}),
            ...(parameters["enabled"] !== undefined ? { enabled: parameters["enabled"] === true } : {})
          },
          actor
        );
        return { external_id: `${row.tenant_id}:${row.memory_space_id}:${row.domain}`, data: row as unknown as JsonValue };
      }
      case "clear_autonomy_policy": {
        const removed = await this.engine.clearAutonomyPolicy(tenantId, memorySpace, requireString(parameters, "domain"), actor);
        return { data: { removed } };
      }
      case "release_stuck_act_claim": {
        const identity = requireIdentity(parameters);
        const row = await this.engine.releaseStuckActClaim(tenantId, memorySpace, requireString(parameters, "situation_id"), identity);
        return { external_id: row.situation_id, data: row as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_situations_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

/** `release_stuck_act_claim` krever HELE identiteten (motoren sjekker scope + sovereign-eier selv) - bygget av det betrodde kallerlaget, aldri av modellen. */
function requireIdentity(parameters: Record<string, JsonValue>): IdentityContext {
  const raw = parameters["identity"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("missing_parameter:identity");
  const obj = raw as Record<string, JsonValue>;
  return {
    person_id: requireString(obj, "person_id"),
    tenant_id: requireString(obj, "tenant_id"),
    memory_space_id: requireString(obj, "memory_space_id") as MemorySpace,
    session_id: requireString(obj, "session_id"),
    device_id: requireString(obj, "device_id"),
    channel: requireString(obj, "channel") as IdentityContext["channel"],
    auth_strength: requireString(obj, "auth_strength") as IdentityContext["auth_strength"]
  };
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;
const base = { tenant_id: z.string(), memory_space: z.string().optional() };
const actor = { actor_person_id: z.string().optional() };

/** ToolGateway-definisjonene for kontrollflaten. Lese-handlinger er klasse A; pause/policy er klasse C (eier-kontroll med varig effekt - reversibel via motstykket); frigjøring av en fastlåst claim er klasse C (gjenoppretting). */
export function situationsToolDefinitions(transport: SituationsTransport): ToolDefinition[] {
  const common = {
    credential_ref: "JARVIS_SITUATIONS_INTERNAL_TOKEN",
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record({ ...base, ...extra }),
    capability_class: "A", scopes: ["situations.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const control = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record({ ...base, ...actor, ...extra }),
    capability_class: "C", scopes: ["situations.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  return [
    read("get_queue", "Les åpne situasjoner (prioritert kø), valgfritt per domene", { domain: z.string().optional(), include_resolved: z.boolean().optional() }),
    read("get_pause_state", "Les hvilke situasjonsdomener som er pauset akkurat nå"),
    read("get_notification_policy", "Les eierens varslingspolicy (stille timer / re-suppress)"),
    read("list_autonomy_policies", "Les eierens auto-ACT-bindinger per domene"),
    {
      tool_id: "situations", action: "resolve", description: "Løs en situasjon manuelt",
      input_schema: record({ ...base, situation_id: z.string() }),
      capability_class: "B", scopes: ["situations.write"], reversible: true,
      rollback_procedure: "en ny deteksjon gjenåpner situasjonen automatisk", idempotent_external: true, ...common
    },
    control("pause_domain", "Pause auto-ACT for ETT situasjonsdomene umiddelbart", { domain: z.string(), reason: z.string() }, "unpause_domain"),
    control("unpause_domain", "Opphev pause for ETT situasjonsdomene", { domain: z.string() }, "pause_domain"),
    control("pause_all", "Pause HELE Situation Engine (alle domener) umiddelbart", { reason: z.string() }, "unpause_all"),
    control("unpause_all", "Opphev pausen for hele Situation Engine", {}, "pause_all"),
    control("set_notification_policy", "Sett stille timer / re-suppress-vindu for varsler",
      { quiet_hours_start_utc: z.number().nullable().optional(), quiet_hours_end_utc: z.number().nullable().optional(), resuppress_hours: z.number().optional() },
      "sett forrige verdier tilbake"),
    control("set_autonomy_policy", "Bind (eller erstatt) eierens auto-ACT-handling for ett domene",
      { domain: z.string(), tool_id: z.string(), action: z.string(), parameters: z.record(z.unknown()).optional(), enabled: z.boolean().optional() },
      "clear_autonomy_policy"),
    control("clear_autonomy_policy", "Fjern eierens auto-ACT-binding for ett domene", { domain: z.string() }, "set_autonomy_policy med forrige verdier"),
    control("release_stuck_act_claim", "Frigjør en fastlåst ACT-claim (kun sovereign eier, kun uten bevis)",
      { situation_id: z.string(), identity: z.record(z.unknown()) }, "ingen - frigjøring skjer kun når ingen ekstern effekt er bevist")
  ];
}
