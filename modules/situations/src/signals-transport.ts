import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { SituationEngine } from "./service.ts";
import type { SimulationService } from "./simulation.ts";
import type { FeedbackService } from "./tuning.ts";
import { SignalLogService } from "./signal-log.ts";
import type { SituationSignalRunner } from "./signal-runner.ts";
import { isSignalSource } from "./signal-types.ts";
import type { SubscriptionRegistry } from "./subscriptions.ts";

/**
 * WP-G4 (D-466), UA-10: eierens KONTROLLFLATE for det samlede hendelsesabonnementet, som tilleggshandlinger på det EKSISTERENDE `situations`-verktøyet (eier-eksklusivt navnerom - aldri en modellflate).
 * Registreres KUN med `JARVIS_SITUATION_SIGNALS=on` (flagg AV = verktøylisten er identisk med main). Samme regler som `SituationsTransport` (D-68/D-160):
 *  - tenant, memory space og aktør kommer UTELUKKENDE fra den betrodde `ToolInvocationContext.identity` - aldri fra parametre (skjemaene er `strict()` uten identitetsfelt; manglende context feiler lukket). Abonnementets
 *    memory space ER identitetens space (kilden må tilhøre et tillatt rom, se `SOURCE_SPACES`).
 *  - To uavhengige porter per muterende handling: `PolicyGateway.authorize()` inne i `execute()` og registerets/motorens EGEN sovereign-eier-sjekk mot samme server-side-identitet.
 *  - Svar er avledede og minimerte (abonnementsrader, loggfakta); aldri rå kildedata.
 * Lese-handlinger er klasse A, tilbakekallelige eier-valg (abonnement, kutt av stille timer) er klasse C.
 */
export interface SituationSignalsTransportDeps {
  registry: SubscriptionRegistry;
  engine: SituationEngine;
  logs: SignalLogService;
  runner?: Pick<SituationSignalRunner, "status">;
  /** Tilbakemelding/tuning (`JARVIS_SITUATION_FEEDBACK`). Utelatt = handlingene finnes ikke. */
  feedback?: FeedbackService;
  /** Kontrafaktisk simulering (ren lesing). Utelatt = handlingen finnes ikke. */
  simulation?: SimulationService;
}

export class SituationSignalsTransport implements ToolTransport {
  constructor(private readonly deps: SituationSignalsTransportDeps) {}

  async invoke(action: string, parameters: Record<string, JsonValue>, _credential: string, context?: ToolInvocationContext): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string" || typeof identity.person_id !== "string") {
      throw new Error("situations_missing_invocation_context");
    }
    const tenantId = identity.tenant_id;
    const space = identity.memory_space_id as MemorySpace;
    const actor = { person_id: identity.person_id, session_id: identity.session_id };

    switch (action) {
      case "list_subscriptions":
        return { data: (await this.deps.registry.list(tenantId, space)) as unknown as JsonValue };
      case "subscribe": {
        const row = await this.deps.registry.subscribe(tenantId, space, {
          source: requireString(parameters, "source"), event_type: requireString(parameters, "event_type"), filter: parameters["filter"] ?? {}, ...(parameters["enabled"] !== undefined ? { enabled: parameters["enabled"] === true } : {})
        }, actor);
        return { external_id: row.subscription_id, data: row as unknown as JsonValue };
      }
      case "set_subscription_enabled": {
        const row = await this.deps.registry.setEnabled(tenantId, space, requireString(parameters, "subscription_id"), parameters["enabled"] === true, actor);
        return { external_id: row.subscription_id, data: row as unknown as JsonValue };
      }
      case "remove_subscription":
        return { data: { removed: await this.deps.registry.remove(tenantId, space, requireString(parameters, "subscription_id"), actor) } };
      case "list_signals": {
        const source = parameters["source"];
        if (source !== undefined && !isSignalSource(source)) throw new Error("invalid_source");
        const rows = await this.deps.logs.list(tenantId, space, {
          ...(typeof parameters["situation_id"] === "string" ? { situation_id: parameters["situation_id"] } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(typeof parameters["limit"] === "number" ? { limit: parameters["limit"] } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "set_critical_quiet_bypass": {
        const row = await this.deps.engine.setCriticalQuietBypass(tenantId, space, parameters["enabled"] === true, identity.person_id, { session_id: identity.session_id });
        return { data: row as unknown as JsonValue };
      }
      case "record_feedback": {
        if (!this.deps.feedback) throw new Error(`unknown_situations_signals_action:${action}`);
        const out = await this.deps.feedback.submit(tenantId, space, requireString(parameters, "situation_id"), requireString(parameters, "verdict"), actor);
        return { external_id: out.feedback_id, data: out as unknown as JsonValue };
      }
      case "get_rule_tuning": {
        if (!this.deps.feedback) throw new Error(`unknown_situations_signals_action:${action}`);
        return { data: (await this.deps.feedback.listTuning(tenantId, space)) as unknown as JsonValue };
      }
      case "reset_rule_tuning": {
        if (!this.deps.feedback) throw new Error(`unknown_situations_signals_action:${action}`);
        return { data: { reset: await this.deps.feedback.resetTuning(tenantId, space, requireString(parameters, "rule_key"), actor) } };
      }
      case "get_situation_simulation": {
        if (!this.deps.simulation) throw new Error(`unknown_situations_signals_action:${action}`);
        return { data: (await this.deps.simulation.simulate(tenantId, space, requireString(parameters, "situation_id"))) as unknown as JsonValue };
      }
      case "list_assessments":
        return { data: (await this.deps.logs.assessments(tenantId, space, requireString(parameters, "situation_id"))) as unknown as JsonValue };
      case "get_signal_status": {
        const status = this.deps.runner?.status();
        return { data: (status === undefined ? { enabled: false } : { enabled: true, running: status.running, tick: status.tick, last: status.last }) as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_situations_signals_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

/** `strict()`: INGEN identitetsfelt finnes i noe skjema - et parameterobjekt som prøver, avvises som `invalid_parameters` av ToolGateway før transporten nås. */
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

export interface SituationSignalsToolOptions {
  /** Tilbakemelding/tuning-handlingene (`JARVIS_SITUATION_FEEDBACK`). Standard: uten. */
  feedback?: boolean;
}

export function situationSignalsToolDefinitions(transport: SituationSignalsTransport, options: SituationSignalsToolOptions = {}): ToolDefinition[] {
  const common = { credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, output_trust: "internal" as const, transport, timeout_ms: 10_000, rate_limit_per_minute: 30 };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record(extra), capability_class: "A", scopes: ["situations.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const control = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record(extra), capability_class: "C", scopes: ["situations.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  const feedbackTools: ToolDefinition[] = options.feedback !== true ? [] : [
    {
      tool_id: "situations", action: "record_feedback", description: "Gi tilbakemelding på en situasjon (nyttig/støy). Tre like svar på rad justerer regelens terskel ett steg innenfor harde grenser (revidert, tilbakestillbart)",
      input_schema: record({ situation_id: z.string(), verdict: z.enum(["useful", "noise"]) }), capability_class: "B", scopes: ["situations.write"], reversible: true,
      rollback_procedure: "reset_rule_tuning for regelen; en ny tilbakemelding gjelder", idempotent_external: true, ...common
    },
    read("get_rule_tuning", "Les regelterskler (standard, harde grenser, gjeldende verdi) etter tilbakemelding"),
    control("reset_rule_tuning", "Tilbakestill én regel til standardterskel (revidert)", { rule_key: z.string() }, "ny tilbakemelding kan justere regelen igjen")
  ];
  return [
    ...feedbackTools,
    read("get_situation_simulation", "Kontrafaktisk simulering («hva om vi hadde handlet/ikke handlet») over registrerte hendelser. Ingen sideeffekt; SUGGEST-bevis med antakelser og forbehold", { situation_id: z.string() }),
    { ...read("list_assessments", "Les modellens vurderinger for en situasjon (UBETRODD modelltekst: vis som sitert data)", { situation_id: z.string() }), output_trust: "untrusted" as const },
    read("list_subscriptions", "Les eierens hendelsesabonnementer (kilde, hendelsestype, filter, på/av) i kallerens tenant/space"),
    read("list_signals", "Les signalloggen (minimerte fakta, aldri rå kildedata) for en situasjon eller kilde", { situation_id: z.string().optional(), source: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
    read("get_signal_status", "Les status for hendelsesløperen (siste tikk: antall lest/evaluert/ignorert, aldri innhold)"),
    control("subscribe", "Registrer (eller slå på) et hendelsesabonnement for en kilde og hendelsestype med et LUKKET filter. Fravær av abonnement = signalet forkastes",
      { source: z.string(), event_type: z.string(), filter: z.record(z.unknown()).optional(), enabled: z.boolean().optional() }, "remove_subscription"),
    control("set_subscription_enabled", "Slå ett hendelsesabonnement av/på", { subscription_id: z.string(), enabled: z.boolean() }, "set_subscription_enabled med motsatt verdi"),
    control("remove_subscription", "Fjern ett hendelsesabonnement (situasjonene og loggen består)", { subscription_id: z.string() }, "subscribe med samme kilde/type/filter"),
    control("set_critical_quiet_bypass", "Velg om sikkerhetssignaler (vannlekkasje, utløst alarm) får bryte stille timer (standard: nei)", { enabled: z.boolean() }, "set_critical_quiet_bypass med motsatt verdi")
  ];
}
