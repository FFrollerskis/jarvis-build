// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { ModelPurposeSchema } from "@jarvis/contracts";
import type { ModelGateway, ToolExecutor } from "@jarvis/model-gateway";
import type { ToolDefinition } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";

export interface ExecutiveHandlerOptions {
  gateway: ModelGateway;
  /** BO-11 §29: mesh-verktøy via trusted executor (Tool Gateway) - aldri bypass. */
  tools?: { definitions: ToolDefinition[]; executor: ToolExecutor };
}

/**
 * Remediering del 1 (JARVIS-001/010/062): executive-`command`-grenen (vilkårlig
 * kommando i prosess-sandbox som root i worker-containeren med hele `.env`) er
 * FJERNET. En kontrakt med `input.data.command` avvises deterministisk - både
 * ved innsending (`TaskService.submit`) og her ved kjøring (rader som allerede
 * står i køen).
 */
export class ExecutiveCommandDisabledError extends Error {
  constructor() {
    super("executive_command_disabled");
    this.name = "ExecutiveCommandDisabledError";
  }
}

/**
 * BO-11.1 §9: ÉN delt executive-handler for api-workeren og worker-containeren.
 * Begge drenerer samme durable kø og MÅ ha identisk kontrakt (BO-10-læringen):
 * prompt → AI Mesh m/purpose; prompt+tools → mesh-tool-løkke via trusted
 * executor (kun det eksplisitte lese-minimumssettet); command → AVVIST
 * (se `ExecutiveCommandDisabledError`); ellers kvitteres målet.
 * Ingen gammel echo-/provider-direkte-handler kan vinne queue-racet igjen.
 */
export function executiveHandler(opts: ExecutiveHandlerOptions) {
  return async (task: ClaimedTask, ctx: JobContext): Promise<Record<string, unknown>> => {
    const input = task.contract.input.data as {
      command?: unknown;
      timeout_ms?: number;
      prompt?: string;
      purpose?: string;
      tools?: boolean;
    };
    if (input.command !== undefined && input.command !== null) {
      throw new ExecutiveCommandDisabledError();
    }
    if (input.prompt) {
      await ctx.assertNotCancelled();
      const purpose = ModelPurposeSchema.safeParse(input.purpose);
      const meshInput = {
        tenant_id: task.tenant_id,
        task_id: task.task_id,
        purpose: purpose.success ? purpose.data : ("BACKGROUND" as const),
        request: { messages: [{ role: "user" as const, content: input.prompt }], max_tokens: 1024 }
      };
      // BO-11 (§29): tools=true gir modellen mesh-verktøy via trusted executor.
      const result =
        input.tools && opts.tools
          ? await opts.gateway.completeWithTools(meshInput, {
              tools: opts.tools.definitions,
              executor: opts.tools.executor
            })
          : await opts.gateway.complete(meshInput);
      return {
        text: result.text.slice(0, 4000),
        provider: result.provider,
        model: result.model,
        tool_rounds: (result.metadata?.["tool_rounds"] as number | undefined) ?? 0,
        tokens: { in: result.usage.input_tokens, out: result.usage.output_tokens }
      };
    }
    return { echo: task.contract.goal, done_at: new Date().toISOString() };
  };
}
