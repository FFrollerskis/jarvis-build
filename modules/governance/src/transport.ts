import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { GovernanceService } from "./service.ts";

/**
 * UA-11 Executive Mode "K2": eierens kontrollflate for decision log/
 * scenarios/risk register/goals-OKRs, eksponert som et vanlig ToolGateway-
 * verktøy (`tool_id: "governance"`). SAMME D-68-identitetsdisiplin som
 * `@jarvis/situations`/`@jarvis/executive`: identitet kommer UTELUKKENDE
 * fra `ToolInvocationContext.identity` (server-side-oppløst, samme
 * identitet `PolicyGateway.authorize()` allerede har vurdert) - ALDRI fra
 * `parameters`. Skjemaene er `strict()` og inneholder INGEN identitetsfelt,
 * så et parameterobjekt som prøver å oppgi `tenant_id`/`actor_person_id`
 * avvises av ToolGateway som `invalid_parameters` FØR denne transporten i
 * det hele tatt nås. Manglende context feiler lukket
 * (`governance_missing_invocation_context`).
 */
export class GovernanceTransport implements ToolTransport {
  constructor(private readonly service: GovernanceService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string" || typeof identity.person_id !== "string") {
      throw new Error("governance_missing_invocation_context");
    }
    const tenantId = identity.tenant_id;
    const memorySpace = identity.memory_space_id as MemorySpace;
    const actor = identity.person_id;

    switch (action) {
      case "create_decision": {
        const row = await this.service.createDecision(
          tenantId,
          memorySpace,
          {
            title: requireString(parameters, "title"),
            rationale: requireString(parameters, "rationale"),
            decision_maker: requireString(parameters, "decision_maker") as "owner" | "jarvis",
            ...(parameters["status"] !== undefined ? { status: parameters["status"] as "proposed" | "decided" } : {}),
            ...(parameters["related_situation_id"] !== undefined ? { related_situation_id: String(parameters["related_situation_id"]) } : {}),
            ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
          },
          actor
        );
        return { external_id: row.decision_id, data: row as unknown as JsonValue };
      }
      case "list_decisions": {
        const rows = await this.service.listDecisions(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as "proposed" | "decided" | "reversed" } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "reverse_decision": {
        const row = await this.service.reverseDecision(tenantId, memorySpace, requireString(parameters, "decision_id"));
        return { external_id: row.decision_id, data: row as unknown as JsonValue };
      }
      case "create_scenario": {
        const row = await this.service.createScenario(
          tenantId,
          memorySpace,
          {
            title: requireString(parameters, "title"),
            assumptions: requireString(parameters, "assumptions"),
            projected_outcome: requireString(parameters, "projected_outcome"),
            ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
          },
          actor
        );
        return { external_id: row.scenario_id, data: row as unknown as JsonValue };
      }
      case "list_scenarios": {
        const rows = await this.service.listScenarios(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined ? { status: parameters["status"] as "draft" | "active" | "archived" } : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "update_scenario_status": {
        const row = await this.service.updateScenarioStatus(
          tenantId,
          memorySpace,
          requireString(parameters, "scenario_id"),
          requireString(parameters, "status") as "draft" | "active" | "archived"
        );
        return { external_id: row.scenario_id, data: row as unknown as JsonValue };
      }
      case "create_risk": {
        const row = await this.service.createRisk(
          tenantId,
          memorySpace,
          {
            title: requireString(parameters, "title"),
            description: requireString(parameters, "description"),
            severity: requireString(parameters, "severity") as "low" | "medium" | "high" | "critical",
            probability: requireString(parameters, "probability") as "low" | "medium" | "high",
            ...(parameters["mitigation_plan"] !== undefined ? { mitigation_plan: String(parameters["mitigation_plan"]) } : {}),
            ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
          },
          actor
        );
        return { external_id: row.risk_id, data: row as unknown as JsonValue };
      }
      case "list_risks": {
        const rows = await this.service.listRisks(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined
            ? { status: parameters["status"] as "identified" | "mitigating" | "accepted" | "resolved" }
            : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "update_risk": {
        const row = await this.service.updateRisk(tenantId, memorySpace, {
          risk_id: requireString(parameters, "risk_id"),
          ...(parameters["severity"] !== undefined ? { severity: parameters["severity"] as "low" | "medium" | "high" | "critical" } : {}),
          ...(parameters["probability"] !== undefined ? { probability: parameters["probability"] as "low" | "medium" | "high" } : {}),
          ...(parameters["mitigation_plan"] !== undefined ? { mitigation_plan: String(parameters["mitigation_plan"]) } : {}),
          ...(parameters["status"] !== undefined
            ? { status: parameters["status"] as "identified" | "mitigating" | "accepted" | "resolved" }
            : {})
        });
        return { external_id: row.risk_id, data: row as unknown as JsonValue };
      }
      case "create_goal": {
        const row = await this.service.createGoal(
          tenantId,
          memorySpace,
          {
            title: requireString(parameters, "title"),
            ...(parameters["description"] !== undefined ? { description: String(parameters["description"]) } : {}),
            ...(parameters["target_date"] !== undefined ? { target_date: String(parameters["target_date"]) } : {}),
            ...(parameters["owner_person_id"] !== undefined ? { owner_person_id: String(parameters["owner_person_id"]) } : {})
          },
          actor
        );
        return { external_id: row.goal_id, data: row as unknown as JsonValue };
      }
      case "list_goals": {
        const rows = await this.service.listGoals(tenantId, memorySpace, {
          ...(parameters["status"] !== undefined
            ? { status: parameters["status"] as "not_started" | "in_progress" | "at_risk" | "achieved" | "abandoned" }
            : {})
        });
        return { data: rows as unknown as JsonValue };
      }
      case "update_goal_status": {
        const row = await this.service.updateGoalStatus(
          tenantId,
          memorySpace,
          requireString(parameters, "goal_id"),
          requireString(parameters, "status") as "not_started" | "in_progress" | "at_risk" | "achieved" | "abandoned"
        );
        return { external_id: row.goal_id, data: row as unknown as JsonValue };
      }
      case "add_key_result": {
        const row = await this.service.addKeyResult(tenantId, memorySpace, {
          goal_id: requireString(parameters, "goal_id"),
          title: requireString(parameters, "title")
        });
        return { external_id: row.key_result_id, data: row as unknown as JsonValue };
      }
      case "update_key_result_progress": {
        const progress = parameters["progress_percent"];
        if (typeof progress !== "number") throw new Error("missing_parameter:progress_percent");
        const row = await this.service.updateKeyResultProgress(
          tenantId,
          memorySpace,
          requireString(parameters, "key_result_id"),
          progress
        );
        return { external_id: row.key_result_id, data: row as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_governance_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

/** `strict()`: INGEN identitetsfelt i noe skjema - samme mønster som `situations`/`executive` sine transporter. */
const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * ToolGateway-definisjonene. ALLE klasse A (lesing) eller B (reversibel
 * intern skriving) - se `059_governance.sql` sitt filhode: dette er rene
 * journalposter, ALDRI en utløser for en ekstern mutasjon (ingen klasse
 * C/D-handling finnes i denne pakken).
 */
export function governanceToolDefinitions(transport: GovernanceTransport): ToolDefinition[] {
  const common = {
    credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF,
    output_trust: "internal" as const,
    transport,
    timeout_ms: 10_000,
    rate_limit_per_minute: 30
  };
  const read = (action: string, description: string, extra: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "governance", action, description, input_schema: record(extra),
    capability_class: "A", scopes: ["governance.read"], reversible: true,
    rollback_procedure: "ingen (lesing)", idempotent_external: true, ...common
  });
  const write = (action: string, description: string, extra: z.ZodRawShape, rollback: string): ToolDefinition => ({
    tool_id: "governance", action, description, input_schema: record(extra),
    capability_class: "B", scopes: ["governance.write"], reversible: true,
    rollback_procedure: rollback, idempotent_external: true, ...common
  });
  return [
    write("create_decision", "Loggfør en ny beslutning (eier eller Jarvis) med begrunnelse",
      {
        title: z.string(), rationale: z.string(), decision_maker: z.enum(["owner", "jarvis"]),
        status: z.enum(["proposed", "decided"]).optional(), related_situation_id: z.string().optional(),
        owner_person_id: z.string().optional()
      },
      "reverse_decision"),
    read("list_decisions", "Les beslutningsloggen, valgfritt filtrert på status", { status: z.enum(["proposed", "decided", "reversed"]).optional() }),
    write("reverse_decision", "Marker en tidligere beslutning som reversert", { decision_id: z.string() }, "ingen automatisk gjenoppretting - loggfør en ny beslutning i stedet"),
    write("create_scenario", "Opprett et nytt hva-hvis-scenario",
      { title: z.string(), assumptions: z.string(), projected_outcome: z.string(), owner_person_id: z.string().optional() },
      "update_scenario_status til 'archived'"),
    read("list_scenarios", "Les scenarier, valgfritt filtrert på status", { status: z.enum(["draft", "active", "archived"]).optional() }),
    write("update_scenario_status", "Sett status (draft/active/archived) for et scenario", { scenario_id: z.string(), status: z.enum(["draft", "active", "archived"]) }, "sett forrige status tilbake"),
    write("create_risk", "Legg til en ny risiko i risikoregisteret",
      {
        title: z.string(), description: z.string(), severity: z.enum(["low", "medium", "high", "critical"]),
        probability: z.enum(["low", "medium", "high"]), mitigation_plan: z.string().optional(), owner_person_id: z.string().optional()
      },
      "update_risk med forrige verdier"),
    read("list_risks", "Les risikoregisteret, valgfritt filtrert på status", { status: z.enum(["identified", "mitigating", "accepted", "resolved"]).optional() }),
    write("update_risk", "Oppdater alvorlighet/sannsynlighet/tiltak/status for en risiko",
      {
        risk_id: z.string(), severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        probability: z.enum(["low", "medium", "high"]).optional(), mitigation_plan: z.string().optional(),
        status: z.enum(["identified", "mitigating", "accepted", "resolved"]).optional()
      },
      "update_risk med forrige verdier"),
    write("create_goal", "Opprett et nytt mål (Objective)",
      { title: z.string(), description: z.string().optional(), target_date: z.string().optional(), owner_person_id: z.string().optional() },
      "update_goal_status til 'abandoned'"),
    read("list_goals", "Les mål med sine nøkkelresultater (Key Results), valgfritt filtrert på status", { status: z.enum(["not_started", "in_progress", "at_risk", "achieved", "abandoned"]).optional() }),
    write("update_goal_status", "Sett status for et mål", { goal_id: z.string(), status: z.enum(["not_started", "in_progress", "at_risk", "achieved", "abandoned"]) }, "sett forrige status tilbake"),
    write("add_key_result", "Legg til et nytt nøkkelresultat (Key Result) under et mål", { goal_id: z.string(), title: z.string() }, "ingen direkte - fjerning er ikke bygget i P0"),
    write("update_key_result_progress", "Oppdater fremdrift (0-100%) for et nøkkelresultat", { key_result_id: z.string(), progress_percent: z.number().min(0).max(100) }, "sett forrige fremdriftsprosent tilbake")
  ];
}
