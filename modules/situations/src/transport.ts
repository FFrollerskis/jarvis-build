import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { DomainPauseRegistry } from "./domain-pause.ts";
import type { SituationEngine } from "./service.ts";

/**
 * UA-10 P1 AKTIVERING (D-160): eierens KONTROLLFLATE for Situation Engine,
 * eksponert som et vanlig ToolGateway-verktøy (`tool_id: "situations"`).
 *
 * IDENTITET KOMMER UTELUKKENDE FRA `ToolInvocationContext` (D-68) - ALDRI
 * fra `parameters`. Arkitekt-review runde 1 på PR #86 (5229219808, funn 2):
 * den første versjonen leste `tenant_id`/`memory_space`/`actor_person_id`
 * (og hele `identity` for `release_stuck_act_claim`) fra verktøyparametrene
 * (D-49-mønsteret fra `BusinessTransport`). Disse feltene lå i tool-
 * skjemaet og var dermed KALLER-supplerte: en kaller kunne oppgi eierens
 * `person_id` og riktig tenant/space selv, og motorens "uavhengige"
 * sovereign-port (`DomainPauseRegistry.assertAuthorized()`,
 * `SituationEngine.assertAutonomyAuthority()`, `releaseStuckActClaim()`)
 * ville sammenlignet mot forfalskede data - ikke en separat autoritetsgrense.
 *
 * Nå: tenant/space/aktør avledes KUN fra `context.identity`, som
 * `ToolGateway.execute()` selv setter fra den server-side-oppløste
 * `request.identity` (samme identitet `PolicyGateway.authorize()` allerede
 * har vurdert). Skjemaene er `strict()` og inneholder INGEN identitets-
 * felter, så et parameterobjekt som prøver å oppgi `actor_person_id`/
 * `tenant_id` avvises av ToolGateway som `invalid_parameters` FØR denne
 * transporten i det hele tatt nås. Manglende `context` feiler lukket
 * (`situations_missing_invocation_context`) - samme mønster som
 * `ConversationGraphTransport` (D-119 FINAL AUTHORITY HARDENING).
 *
 * To UAVHENGIGE porter per muterende handling: `PolicyGateway.authorize()`
 * (sovereign eier-modus, KillSwitch, freeze) inne i `execute()`, OG motorens
 * egen eier-autoritet mot den SAMME server-side-identiteten.
 *
 * Dette lukker masterplanens "Owner can pause a domain or entire Situation
 * Engine instantly" i PRAKSIS (P0 beviste mekanismen, men hadde ingen flate)
 * og er den ene, stabile kontrakten UA-11 sin samlede kontrollflate skal
 * KOMPONERE - ikke omgå.
 */
export class SituationsTransport implements ToolTransport {
  constructor(
    private readonly engine: SituationEngine,
    private readonly domainPauses: DomainPauseRegistry
  ) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string" || typeof identity.person_id !== "string") {
      throw new Error("situations_missing_invocation_context");
    }
    const tenantId = identity.tenant_id;
    const memorySpace = identity.memory_space_id as MemorySpace;
    const actor = identity.person_id;

    switch (action) {
      case "get_queue": {
        const filter: { domain?: string; statusOpenOnly?: boolean } = {};
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
          actor_person_id: actor
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
            ...(parameters["enabled"] !== undefined ? { enabled: parameters["enabled"] === true } : {}),
            // WP-G4: valgfri utløpstid. Feltet finnes KUN i skjemaet når `JARVIS_SITUATION_SIGNALS=on` (se `situationsToolDefinitions`); uten flagget avvises det som `invalid_parameters` før denne koden nås.
            ...(typeof parameters["expires_at"] === "string" ? { expires_at: parameters["expires_at"] } : {}),
            // WP-G4b K2: valgfritt skop (én regel ELLER én kategori); samme gating (kun med hovedbryteren). Utelatt = hele domenet (som før).
            ...(typeof parameters["rule"] === "string" ? { rule: parameters["rule"] } : {}),
            ...(typeof parameters["category"] === "string" ? { category: parameters["category"] } : {})
          },
          actor
        );
        return { external_id: `${row.tenant_id}:${row.memory_space_id}:${row.domain}`, data: row as unknown as JsonValue };
      }
      case "clear_autonomy_policy": {
        // WP-G4b K2: uten `rule`/`category` fjernes den DOMENEBREDE bindingen (som før); med ett av dem akkurat den regel-/kategoribindingen.
        const scope = {
          ...(typeof parameters["rule"] === "string" ? { rule: parameters["rule"] } : {}),
          ...(typeof parameters["category"] === "string" ? { category: parameters["category"] } : {})
        };
        const removed = await this.engine.clearAutonomyPolicy(tenantId, memorySpace, requireString(parameters, "domain"), actor, scope);
        return { data: { removed } };
      }
      case "release_stuck_act_claim": {
        // Hele identiteten er den betrodde context-identiteten - motoren sjekker scope + sovereign-eier mot DEN, aldri mot parametre.
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

/** `strict()`: INGEN identitetsfelt (`tenant_id`/`memory_space`/`actor_person_id`/`identity`) finnes i noe skjema - et parameterobjekt som prøver, avvises som `invalid_parameters` av ToolGateway. */
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene for kontrollflaten. Lese-handlinger er klasse A; pause/policy er klasse C (eier-kontroll med varig effekt - reversibel via motstykket); frigjøring av en fastlåst claim er klasse C (gjenoppretting).
 *
 * HOST-FUNN (UA-10 P1 runtime-gate, live-akseptanse `ua10-p1-situation-sweep-live.ts`,
 * run_id `cf8b750d`): den opprinnelige P1-definisjonen brukte en OPPFUNNET
 * `credential_ref: "JARVIS_SITUATIONS_INTERNAL_TOKEN"` som INGEN provider i
 * produksjonens secret-kjede (`FallbackSecretProvider(EnvSecretProvider,
 * BusinessInternalSecretProvider)` i main.ts/worker-main.ts) leverer - hele
 * eier-kontrollflaten (`pause_domain`/`set_autonomy_policy`/`get_queue`/
 * `release_stuck_act_claim`...) var `credential_unavailable` i drift, usynlig
 * for `activation.test.ts` fordi test-provideren returnerte en verdi for
 * ENHVER ref. Nå: SAMME Jarvis-interne sentinel som alle øvrige interne
 * domeneverktøy (`business.*`, `finance_spend.*`, ...) - `BUSINESS_INTERNAL_
 * CREDENTIAL_REF` løses av `BusinessInternalSecretProvider`, aldri av en env-
 * variabel. Regresjonsvakt: `ua10-p1-situation-sweep-host-run-wiring.test.ts`
 * beviser løsning mot den EKTE kjeden uten noen env satt.
 */
export interface SituationsToolOptions {
  /** WP-G4: gi `set_autonomy_policy` et valgfritt `expires_at` (utløpstid på eierens binding). Standard (utelatt) = skjemaet er identisk med main. */
  autonomyExpiry?: boolean;
  /** WP-G4b K2: gi `set_autonomy_policy` og `clear_autonomy_policy` valgfrie `rule`/`category` (skop for bindingen). Standard (utelatt) = skjemaene er identiske med main. */
  autonomyScope?: boolean;
}

export function situationsToolDefinitions(transport: SituationsTransport, options: SituationsToolOptions = {}): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record(extra),
    capability_class: "A", scopes: ["situations.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const control = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "situations", action, description, input_schema: record(extra),
    capability_class: "C", scopes: ["situations.control"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  return [
    read("get_queue", "Les åpne situasjoner (prioritert kø) i kallerens tenant/space, valgfritt per domene", { domain: z.string().optional(), include_resolved: z.boolean().optional() }),
    read("get_pause_state", "Les hvilke situasjonsdomener som er pauset akkurat nå"),
    read("get_notification_policy", "Les eierens varslingspolicy (stille timer / re-suppress)"),
    read("list_autonomy_policies", "Les eierens auto-ACT-bindinger per domene"),
    {
      tool_id: "situations", action: "resolve", description: "Løs en situasjon manuelt",
      input_schema: record({ situation_id: z.string() }),
      capability_class: "B", scopes: ["situations.write"], reversible: true,
      rollback_procedure: "en ny deteksjon gjenåpner situasjonen automatisk", idempotent_external: true, ...common
    },
    control("pause_domain", "Pause auto-ACT for ETT situasjonsdomene umiddelbart (aktør = kallerens betrodde identitet)", { domain: z.string(), reason: z.string() }, "unpause_domain"),
    control("unpause_domain", "Opphev pause for ETT situasjonsdomene", { domain: z.string() }, "pause_domain"),
    control("pause_all", "Pause HELE Situation Engine (alle domener) umiddelbart", { reason: z.string() }, "unpause_all"),
    control("unpause_all", "Opphev pausen for hele Situation Engine", {}, "pause_all"),
    control("set_notification_policy", "Sett stille timer / re-suppress-vindu for varsler",
      { quiet_hours_start_utc: z.number().nullable().optional(), quiet_hours_end_utc: z.number().nullable().optional(), resuppress_hours: z.number().optional() },
      "sett forrige verdier tilbake"),
    control("set_autonomy_policy", "Bind (eller erstatt) eierens auto-ACT-handling for ett domene",
      { domain: z.string(), tool_id: z.string(), action: z.string(), parameters: z.record(z.unknown()).optional(), enabled: z.boolean().optional(), ...(options.autonomyExpiry === true ? { expires_at: z.string().optional() } : {}), ...(options.autonomyScope === true ? { rule: z.string().optional(), category: z.string().optional() } : {}) },
      "clear_autonomy_policy"),
    control("clear_autonomy_policy", "Fjern eierens auto-ACT-binding for ett domene", { domain: z.string(), ...(options.autonomyScope === true ? { rule: z.string().optional(), category: z.string().optional() } : {}) }, "set_autonomy_policy med forrige verdier"),
    control("release_stuck_act_claim", "Frigjør en fastlåst ACT-claim (kun sovereign eier, kun uten bevis)",
      { situation_id: z.string() }, "ingen - frigjøring skjer kun når ingen ekstern effekt er bevist")
  ];
}
