// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { ModelPurposeSchema } from "@jarvis/contracts";
import type { ModelGateway, ToolExecutor } from "@jarvis/model-gateway";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import { filterMeshToolsForJob, type MeshToolMapping } from "@jarvis/tool-gateway";

export interface ExecutiveHandlerOptions {
  gateway: ModelGateway;
  /**
   * BO-11 §29 + Del 3 (JARVIS-005/012): mesh-verktøy via trusted executor (Tool Gateway) - aldri bypass.
   * `all` er KANDIDATENE; handleren filtrerer dem mot jobbkontraktens `allowed_tools` (skjemaliste) og `executorFor` bygges per jobb med
   * kontraktens egen identitet + kontrakten (så gatewayen håndhever det samme ved utførelse).
   */
  tools?: {
    all: ReadonlyArray<MeshToolMapping>;
    executorFor(task: ClaimedTask, allowed: ReadonlyArray<MeshToolMapping>): ToolExecutor;
  };
}

/** `tools:true` uten eksplisitt verktøyliste, eller på en ubetrodd kontrakt, avvises deterministisk (Del 3). */
export class ExecutiveToolsDeniedError extends Error {
  constructor(readonly reason: "job_tools_require_allowlist" | "job_tools_untrusted_contract" | "job_tools_none_permitted") {
    super(reason);
    this.name = "ExecutiveToolsDeniedError";
  }
}

/**
 * D-396 (JARVIS-062): en jobb uten `prompt` (og uten `command`) har ingenting å utføre. Tidligere ble målet «kvittert» med `{echo: goal}`
 * og jobben markert som FERDIG - brukeren så «Jobb opprettet», deretter «ferdig», uten at noe var gjort. Nå feiler jobben eksplisitt og
 * lesbart i stedet for å late som den utførte noe.
 */
export class ExecutiveNoExecutableInputError extends Error {
  constructor() {
    super("executive_no_executable_input");
    this.name = "ExecutiveNoExecutableInputError";
  }
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
 * (se `ExecutiveCommandDisabledError`); ellers feiler jobben med `ExecutiveNoExecutableInputError` (D-396: aldri en falsk «ferdig»-kvittering).
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
      // BO-11 (§29) + Del 3: tools=true gir modellen KUN verktøyene kontrakten eksplisitt tillater, med kontraktens egen identitet.
      let result;
      if (input.tools && opts.tools) {
        if (task.contract.allowed_tools.length === 0) throw new ExecutiveToolsDeniedError("job_tools_require_allowlist");
        if (task.contract.input.trust_level === "untrusted") throw new ExecutiveToolsDeniedError("job_tools_untrusted_contract");
        const allowed = filterMeshToolsForJob(opts.tools.all, task.contract);
        if (allowed.length === 0) throw new ExecutiveToolsDeniedError("job_tools_none_permitted");
        result = await opts.gateway.completeWithTools(meshInput, {
          tools: allowed.map((m) => m.def),
          executor: opts.tools.executorFor(task, allowed)
        });
      } else {
        result = await opts.gateway.complete(meshInput);
      }
      return {
        text: result.text.slice(0, 4000),
        provider: result.provider,
        model: result.model,
        tool_rounds: (result.metadata?.["tool_rounds"] as number | undefined) ?? 0,
        tokens: { in: result.usage.input_tokens, out: result.usage.output_tokens }
      };
    }
    throw new ExecutiveNoExecutableInputError();
  };
}
