import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { ExecutiveService } from "./service.ts";

/**
 * UA-11 Executive Mode (P0, D-162): eierens SAMLEDE kontrollflate, eksponert
 * som et vanlig ToolGateway-verktøy (`tool_id: "executive"`) - SAMME mønster
 * som `SituationsTransport` (D-160). IDENTITET KOMMER UTELUKKENDE FRA
 * `ToolInvocationContext` (D-68), ALDRI fra `parameters` - identisk
 * disiplin og identisk feilmodus (`executive_missing_invocation_context`)
 * som `SituationsTransport`. Skjemaene er `strict()` og inneholder INGEN
 * identitetsfelt.
 *
 * Denne transporten implementerer INGEN pause-/policy-/autoritetslogikk
 * selv - `ExecutiveService` videresender hvert muterende kall til
 * `situations.*` via `ToolGateway.execute()` (nøstet, med den SAMME
 * `context.identity`). Se `service.ts` sitt filhode.
 */
export class ExecutiveTransport implements ToolTransport {
  constructor(private readonly service: ExecutiveService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string" || typeof identity.person_id !== "string") {
      throw new Error("executive_missing_invocation_context");
    }
    switch (action) {
      case "get_attention_queue": {
        const filter = parameters["domain"] !== undefined ? { domain: String(parameters["domain"]) } : {};
        const items = await this.service.getAttentionQueue(identity, filter);
        return { data: items as unknown as JsonValue };
      }
      case "get_attention_item": {
        const item = await this.service.getAttentionItem(identity, requireString(parameters, "situation_id"));
        if (!item) throw new Error("attention_item_not_found");
        return { external_id: item.situation_id, data: item as unknown as JsonValue };
      }
      case "get_pause_state": {
        const result = await this.service.getPauseState(identity);
        return toolResultToTransportResult(result);
      }
      case "pause_domain": {
        const result = await this.service.pauseDomain(identity, requireString(parameters, "domain"), requireString(parameters, "reason"));
        return toolResultToTransportResult(result);
      }
      case "resume_domain": {
        const result = await this.service.resumeDomain(identity, requireString(parameters, "domain"));
        return toolResultToTransportResult(result);
      }
      case "resolve_situation": {
        const result = await this.service.resolveSituation(identity, requireString(parameters, "situation_id"));
        return toolResultToTransportResult(result);
      }
      default:
        throw new Error(`unknown_executive_action:${action}`);
    }
  }
}

/**
 * `ExecutiveService`s passthrough-metoder returnerer den nøstede
 * `situations.*`-kallets EGEN `ToolResult` (inkl. `ok:false`-avslag fra
 * PolicyGateway/motoren). Denne transporten KASTER på avslag (i stedet for
 * å returnere `{data:{ok:false,...}}`) slik at det ytre `ToolGateway.execute
 * ("executive", ...)`-kallet selv blir `ok:false` med SAMME `reason` -
 * avslaget forplanter seg gjennomsiktig, det blir ALDRI en stille "ok:true"
 * på executive-laget for en handling situations-laget faktisk nektet.
 */
function toolResultToTransportResult(result: { ok: boolean; reason?: string; external_id?: string; data?: JsonValue }): {
  external_id?: string;
  data?: JsonValue;
} {
  if (!result.ok) throw new Error(result.reason ?? "situations_call_denied");
  return { ...(result.external_id !== undefined ? { external_id: result.external_id } : {}), ...(result.data !== undefined ? { data: result.data } : {}) };
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene for den samlede kontrollflaten. Lese-handlinger
 * er klasse A (samme som `situations.get_queue`/`get_pause_state` selv);
 * pause/resume/resolve er klasse C (samme klasse som de underliggende
 * `situations.*`-handlingene de videresender til - IKKE lavere, IKKE
 * høyere, ALDRI en egen risikoklassifisering for samme reelle mutasjon).
 * `credential_ref` er SAMME interne sentinel som `situations`/`business`/...
 * (se `situations/transport.ts` sitt HOST-FUNN-avsnitt for hele
 * begrunnelsen for hvorfor dette MÅ løses av produksjonens ekte kjede).
 */
export function executiveToolDefinitions(transport: ExecutiveTransport): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "executive", action, description, input_schema: record(extra),
    capability_class: "A", scopes: ["executive.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const control = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "executive", action, description, input_schema: record(extra),
    capability_class: "C", scopes: ["executive.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  return [
    read("get_attention_queue", "Les eierens rangerte attention-kø (åpne, attention-verdige situasjoner, forklart og prioritert)", { domain: z.string().optional() }),
    read("get_attention_item", "Les full detalj/begrunnelse for ETT attention-item, inkl. kilde-situasjonen", { situation_id: z.string() }),
    read("get_pause_state", "Les hvilke situasjonsdomener som er pauset akkurat nå (gjennomslag til situations.get_pause_state)"),
    control("pause_domain", "Pause ETT situasjonsdomene umiddelbart (gjennomslag til situations.pause_domain)", { domain: z.string(), reason: z.string() }, "resume_domain"),
    control("resume_domain", "Opphev pause for ETT situasjonsdomene (gjennomslag til situations.unpause_domain)", { domain: z.string() }, "pause_domain"),
    {
      tool_id: "executive", action: "resolve_situation", description: "Løs et attention-item manuelt (gjennomslag til situations.resolve)",
      input_schema: record({ situation_id: z.string() }),
      capability_class: "B", scopes: ["executive.write"], reversible: true,
      rollback_procedure: "en ny deteksjon gjenåpner situasjonen automatisk", idempotent_external: true, ...common
    }
  ];
}
