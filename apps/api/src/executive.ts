// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { DataSensitivitySchema, ModelPurposeSchema } from "@jarvis/contracts";
import { NoEligibleProviderError, classifyContentSensitivity, type ModelGateway, type ToolExecutor } from "@jarvis/model-gateway";
import { ProviderError } from "@jarvis/provider-adapters";
import type { ClaimedTask, JobContext } from "@jarvis/tasks";
import { filterMeshToolsForJob, financeToolIntent, type MeshToolMapping } from "@jarvis/tool-gateway";
import { cloudScreenedExecutor, jobWithheldNote } from "./cloud-tool-screen.ts";
import { financeIntentOptions } from "./control-center/shared.ts";
import { LOCAL_FALLBACK_ERROR_KINDS, claudeBudgetRouteNote, jobDayCapNote } from "./tool-turn-route.ts";

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
  /**
   * D-449 (Q-50, eierens ja 2026-10-08): samme verktøyrute som chatten (D-431, `JARVIS_TOOL_TURN_MODEL`, standard Sonnet 5.5; egen bryter `JARVIS_JOB_TOOL_TURN_MODEL`) for DELEGERTE chat-jobber med
   * verktøy. En 8B-modell bruker verktøy upålitelig (NAS-test 4: GitHub 404 med `llama3.1:8b`). Gjelder KUN en jobb som er delegert fra chat OG hvis kontrakt eksplisitt tillater det
   * (`cloud_tool_turns_allowed`, satt av `TasksDelegateTransport` kun når oppgaveteksten og minnerommet ikke er `SECRET_RESTRICTED` og innholdets opphav er betrodd; avvist i innsendte kontrakter
   * på `POST /tasks/submit`); alle andre jobber har uendret ruting. På skyruten skjermes verktøyresultater (`cloud-tool-screen.ts`). `null`/udefinert = av.
   */
  toolTurnRoute?: { provider: string; model?: string } | null;
  /** D-432/D-449: samme dagstak som chatten (øre per døgn, tenant-bred). Nådd eller ulesbart tak = jobben kjører lokalt med en merknad i svaret (aldri ubegrenset sky). */
  toolTurnDayCap?: { cap_ore: number; spentToday(tenantId: string): Promise<number> } | null;
}

/** D-449: hvilken rute et verktøykjøring faktisk tok. `default` = uendret ruting (ingen skyrute forespurt). */
export type ExecutiveToolRoute = "default" | "cloud" | "local_cap" | "local_fallback";

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
      sensitivity?: unknown;
      paid_models_allowed?: unknown;
      delegated_from_chat?: unknown;
      cloud_tool_turns_allowed?: unknown;
    };
    if (input.command !== undefined && input.command !== null) {
      throw new ExecutiveCommandDisabledError();
    }
    if (input.prompt) {
      await ctx.assertNotCancelled();
      const purpose = ModelPurposeSchema.safeParse(input.purpose);
      // D-416: delegerte chat-jobber setter sensitivitet og «ingen betalte modeller» i kontrakten (lokal først). Andre jobber uendret.
      const sensitivity = DataSensitivitySchema.safeParse(input.sensitivity);
      const meshInput = {
        ...(sensitivity.success ? { sensitivity: sensitivity.data } : {}),
        ...(typeof input.paid_models_allowed === "boolean" ? { paid_models_allowed: input.paid_models_allowed } : {}),
        tenant_id: task.tenant_id,
        task_id: task.task_id,
        purpose: purpose.success ? purpose.data : ("BACKGROUND" as const),
        // WP-B4 (D-476): en jobb delegert fra chat er en jobb EIEREN bestilte (VIKTIG for Claude-kreditten, selv om kontrakten merker den BACKGROUND som køetikett). Kun med Claude-kreditten på - ellers uendret innputt.
        ...(opts.gateway.claudeBudgetActive === true && input.delegated_from_chat === true ? { budget_origin: "owner_task" as const } : {}),
        request: { messages: [{ role: "user" as const, content: input.prompt }], max_tokens: 1024 }
      };
      // BO-11 (§29) + Del 3: tools=true gir modellen KUN verktøyene kontrakten eksplisitt tillater, med kontraktens egen identitet.
      let result;
      let route: ExecutiveToolRoute = "default";
      // D-449: merknader som står FORAN svaret (leveringsvisningen avkorter svaret bakfra, så en merknad bakerst kunne forsvunnet).
      const notes: string[] = [];
      if (input.tools && opts.tools) {
        if (task.contract.allowed_tools.length === 0) throw new ExecutiveToolsDeniedError("job_tools_require_allowlist");
        if (task.contract.input.trust_level === "untrusted") throw new ExecutiveToolsDeniedError("job_tools_untrusted_contract");
        const allowed = filterMeshToolsForJob(opts.tools.all, task.contract);
        if (allowed.length === 0) throw new ExecutiveToolsDeniedError("job_tools_none_permitted");
        const tools = allowed.map((m) => m.def);
        const executor = opts.tools.executorFor(task, allowed);
        // D-449 (Q-50): skyrute for verktøykjøring kun når ALT dette stemmer - konfigurert rute, delegert fra chat, kontrakten tillater det (trusted kode satte flagget fordi oppgaveteksten og minnerommet
        // ikke er SECRET_RESTRICTED og innholdets opphav er betrodd), og kontraktens sensitivitet er eksplisitt lest og ikke SECRET_RESTRICTED (forsvar i dybden: helse/økonomi/hemmeligheter går aldri til sky, D-378).
        const toolRoute = opts.toolTurnRoute ?? null;
        const cloudWanted =
          toolRoute !== null &&
          input.delegated_from_chat === true &&
          input.cloud_tool_turns_allowed === true &&
          sensitivity.success &&
          sensitivity.data !== "SECRET_RESTRICTED" &&
          // Forsvar i dybden: oppgaveteksten, tittelen (`goal`) og minnerommene jobben får lese klassifiseres OGSÅ her, uavhengig av hvordan kontrakten ble sendt inn (en kontrakt kan i prinsippet bygges av andre enn chatten).
          classifyContentSensitivity({ texts: [input.prompt, task.contract.goal], memory_spaces: task.contract.allowed_memory_spaces }).sensitivity !== "SECRET_RESTRICTED" &&
          // D-381-paritet (gjennomgang nr. 3): ord som får chatten til å velge et finansverktøy holder jobben lokal.
          !financeToolIntent(`${task.contract.goal}\n${input.prompt}`, financeIntentOptions());
        if (toolRoute !== null && cloudWanted) {
          // Dagstaket sjekkes kun når jobben faktisk ville gått til sky. Kan kostnaden ikke leses, feiler vi lukket (lokalt), som chatten (D-432).
          const dayCap = opts.toolTurnDayCap ?? null;
          let capped = false;
          if (dayCap !== null) {
            try {
              capped = (await dayCap.spentToday(task.tenant_id)) >= dayCap.cap_ore;
            } catch (err) {
              capped = true;
              console.error(JSON.stringify({ msg: "d449_job_day_cap_spend_unreadable_local", task_id: task.task_id, error: (err as Error).message.slice(0, 120) }));
            }
          }
          if (capped && dayCap !== null) {
            route = "local_cap";
            notes.push(jobDayCapNote(dayCap.cap_ore));
            result = await opts.gateway.completeWithTools(meshInput, { tools, executor });
          } else {
            // Samme inputform som chatten: ingen `paid_models_allowed`-nekt (kontraktens `false` gjelder lokal-først-ruten), men en HARD preferanse for skyleverandøren og modellen.
            const { paid_models_allowed: omittedPaidFlag, ...cloudBase } = meshInput;
            void omittedPaidFlag;
            const cloudInput = {
              ...cloudBase,
              providerPreference: [toolRoute.provider],
              request: { ...cloudBase.request, ...(toolRoute.model ? { model: toolRoute.model } : {}) }
            };
            let toolsExecuted = false;
            let withheldFromCloud = 0;
            // Verktøyresultatene sendes videre til skymodellen: minnetreff merket særlig sensitive holdes tilbake (revisjonsfunn, se cloud-tool-screen.ts).
            const screened = cloudScreenedExecutor(executor, ({ tool, withheld }) => {
              withheldFromCloud += withheld;
              console.log(JSON.stringify({ msg: "d449_job_cloud_tool_output_withheld", task_id: task.task_id, tool, withheld }));
            });
            const trackedExecutor: ToolExecutor = {
              execute: async (call, callCtx) => {
                toolsExecuted = true;
                return screened.execute(call, callCtx);
              }
            };
            try {
              result = await opts.gateway.completeWithTools(cloudInput, { tools, executor: trackedExecutor });
              route = "cloud";
              if (withheldFromCloud > 0) notes.push(jobWithheldNote());
            } catch (err) {
              // Skyen er nede (tidsavbrudd, nett, kvote, ikke konfigurert, ubrukelig svar) FØR noe verktøy er utført → kjør på lokal modell (samme sensitivitetsregler, ingen stille skylekkasje) i stedet
              // for en feil. Etter et utført verktøy gjentas aldri jobben (verktøykall kan ha hatt virkning/kost): feilen går videre og jobben feiler ærlig.
              const providerDown = err instanceof ProviderError && err.provider === toolRoute.provider && LOCAL_FALLBACK_ERROR_KINDS.includes(err.kind);
              const preferenceExhausted = err instanceof NoEligibleProviderError && err.message.includes("provider_preference_exhausted");
              if (toolsExecuted || !(providerDown || preferenceExhausted)) throw err;
              console.error(JSON.stringify({
                msg: "d449_job_cloud_tools_failed_fallback_local", task_id: task.task_id,
                kind: err instanceof ProviderError ? err.kind : "provider_preference_exhausted"
              }));
              route = "local_fallback";
              result = await opts.gateway.completeWithTools(meshInput, { tools, executor });
            }
          }
        } else {
          result = await opts.gateway.completeWithTools(meshInput, { tools, executor });
        }
        // Observerbarhet: workeren logget tidligere ingenting om en jobbs modellrute (NAS-test 4 kunne ikke se hvilken modell som kjørte).
        console.log(JSON.stringify({ msg: "d449_job_tool_route", task_id: task.task_id, route, provider: result.provider, model: result.model }));
      } else {
        result = await opts.gateway.complete(meshInput);
      }
      // WP-B4 (D-476): jobben kjørte lokalt fordi Claude-kreditten stengte Anthropic - sagt rett ut i svaret (tom uten Claude-kreditten).
      const budgetNote = claudeBudgetRouteNote(result.metadata, "jobben", result);
      if (budgetNote !== "") notes.push(budgetNote);
      const header = notes.length > 0 ? `${notes.join(" ")}\n\n` : "";
      return {
        text: `${header}${result.text.slice(0, Math.max(0, 4000 - header.length))}`,
        provider: result.provider,
        model: result.model,
        tool_rounds: (result.metadata?.["tool_rounds"] as number | undefined) ?? 0,
        tokens: { in: result.usage.input_tokens, out: result.usage.output_tokens },
        ...(route !== "default" ? { route } : {})
      };
    }
    throw new ExecutiveNoExecutableInputError();
  };
}
