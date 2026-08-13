import type { ToolCallRequest, ToolDefinition as MeshToolDefinition, ToolResultMessage } from "@jarvis/provider-adapters";
import type { ToolGateway } from "./gateway.ts";

/**
 * UA-1 P1A (§13, §16-§17): trusted bro mellom AI Mesh og Tool Gateway.
 * Definisjonene kommer HERFRA (trusted lag) - modellen definerer aldri egne
 * verktøy/permissions. Utførelse går alltid gjennom ToolGateway.execute →
 * Policy/Execution Authority/idempotens/audit, uansett provider.
 * P1A eksponerer kun ufarlige A/B-klasse READ-verktøy (§14).
 */
/** Kobling mesh-verktøynavn → registrert Tool Gateway-handling. */
export interface MeshToolMapping {
  def: MeshToolDefinition;
  tool_id: string;
  action: string;
}

const MESH_TOOLS: MeshToolMapping[] = [
  {
    def: {
      name: "read_recent_email",
      description: "Les de nyeste e-postene i eierens innboks (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "email",
    action: "read_inbox"
  },
  {
    def: {
      name: "read_calendar_today",
      description: "Les dagens kalenderhendelser (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "calendar",
    action: "read_events"
  },
  {
    def: {
      name: "read_github_issues",
      description: "Les åpne GitHub-issues i prosjektrepoet (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "github",
    action: "read_issues"
  }
];

export function meshToolDefinitions(tools: MeshToolMapping[] = MESH_TOOLS): MeshToolDefinition[] {
  return tools.map((t) => t.def);
}

/**
 * Strukturelt kompatibel med ModelGateway.ToolExecutor. Resultatet trimmes før
 * det går tilbake til modellen - aldri credentials/intern metadata (§22).
 */
export class MeshToolExecutor {
  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: unknown,
    private readonly maxOutputChars = 4000,
    /**
     * Default: kun A/B-read-verktøyene over. Tester/senere faser kan eksponere
     * flere mappinger - autorisasjon (inkl. D-pipeline) håndheves UANSETT i
     * Tool Gateway/Policy per kall, aldri av denne listen (§17).
     */
    private readonly tools: MeshToolMapping[] = MESH_TOOLS
  ) {}

  async execute(
    call: ToolCallRequest,
    ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
  ): Promise<ToolResultMessage> {
    const at = new Date().toISOString();
    const mapped = this.tools.find((t) => t.def.name === call.tool_name);
    if (!mapped) {
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: "TOOL_NOT_FOUND", at
      };
    }
    const result = await this.toolGateway.execute({
      identity: this.identity as never,
      tool_id: mapped.tool_id,
      action: mapped.action,
      parameters: call.arguments as never,
      idempotency_key: ctx.idempotency_key
    });
    if (!result.ok) {
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: ctx.idempotency_key,
        success: false, output: null, error_category: result.reason, at
      };
    }
    let output: unknown = result.data ?? null;
    const serialized = JSON.stringify(output);
    if (serialized && serialized.length > this.maxOutputChars) {
      output = { truncated: true, preview: serialized.slice(0, this.maxOutputChars) };
    }
    return {
      tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: ctx.idempotency_key,
      success: true, output, at
    };
  }
}
