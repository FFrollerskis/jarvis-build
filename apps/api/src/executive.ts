// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { ModelPurposeSchema } from "@jarvis/contracts";
import type { ModelGateway, ToolExecutor } from "@jarvis/model-gateway";
import type { ToolDefinition } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext, SandboxRunner } from "@jarvis/tasks";

export interface ExecutiveHandlerOptions {
  gateway: ModelGateway;
  /** BO-11 §29: mesh-verktøy via trusted executor (Tool Gateway) - aldri bypass. */
  tools?: { definitions: ToolDefinition[]; executor: ToolExecutor };
  /** Kun worker-containeren har sandbox; uten sandbox kvitteres command-jobber. */
  sandbox?: SandboxRunner;
}

/**
 * BO-11.1 §9: ÉN delt executive-handler for api-workeren og worker-containeren.
 * Begge drenerer samme durable kø og MÅ ha identisk kontrakt (BO-10-læringen):
 * prompt → AI Mesh m/purpose; prompt+tools → mesh-tool-løkke via trusted
 * executor; command → sandbox (kun der sandbox finnes); ellers kvitteres målet.
 * Ingen gammel echo-/provider-direkte-handler kan vinne queue-racet igjen.
 */
export function executiveHandler(opts: ExecutiveHandlerOptions) {
  return async (task: ClaimedTask, ctx: JobContext): Promise<Record<string, unknown>> => {
    const input = task.contract.input.data as {
      command?: string[];
      timeout_ms?: number;
      prompt?: string;
      purpose?: string;
      tools?: boolean;
    };
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
    if (!input.command || input.command.length === 0 || !opts.sandbox) {
      return { echo: task.contract.goal, done_at: new Date().toISOString() };
    }
    const sb = await opts.sandbox.create();
    try {
      await ctx.assertNotCancelled();
      const res = sb.exec(input.command[0] as string, input.command.slice(1), input.timeout_ms ?? 60_000);
      if (res.code !== 0) {
        throw new Error(`sandbox_exit_${res.code}: ${res.stderr.slice(0, 200)}`);
      }
      return { stdout: res.stdout.slice(0, 4000), code: res.code, sandbox: opts.sandbox.name };
    } finally {
      await sb.dispose();
    }
  };
}
