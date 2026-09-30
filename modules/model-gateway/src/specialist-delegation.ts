import type { ToolCallRequest, ToolDefinition, ToolResultMessage } from "@jarvis/provider-adapters";
import type { ModelGateway, ToolExecutor } from "./model-gateway.ts";

/**
 * D-355 (Steg 2 av Tobias sitt D-354-oppdrag, direkte i chat: "gemma skal
 * være standar for tekst og tale siden den er gratis ... først ved større
 * forespørsler kode enringer eller bilde genereing osv osv så skal den
 * spinne opp agenter som antropic eller grok for å få de til og gjøre
 * oppgaven også kommer de tilbake til gemma med svaret" - avklart via
 * `AskUserQuestion`: kun Anthropic/OpenAI/Gemini, konkrete kategorier
 * avgjør eskalering, ikke fri modell-dømmekraft om NÅR).
 *
 * "Konkrete kategorier": DENNE filen eksponerer ETT enkelt, navngitt
 * verktøy (`delegate_code_task`) - IKKE en fri-tekst "eskaler av en eller
 * annen grunn"-mekanisme. Gemma (den ordinære samtalemodellen, D-354) VELGER
 * fortsatt SELV når den kaller verktøyet (samme agentiske mønster som alle
 * andre ~56 mesh-verktøy den allerede kan kalle, IKKE routerens egen
 * provider-valg som §35 i `router.ts` eksplisitt forbyr en modell å gjøre
 * selv) - men HVA den kan eskalere TIL er en lukket, auditerbar liste, aldri
 * en fritt valgt leverandør/prompt.
 *
 * Bilde-generering trenger INGEN ny kode her: `openai_images.generate_image`
 * (modules/tool-gateway/src/integrations.ts) er ALLEREDE et registrert
 * mesh-verktøy, ALLEREDE eksponert til Gemma via `allMeshTools()` i
 * `apps/api/src/main.ts` (D-289 "full kapabilitet") - Gemma kan already
 * kalle det direkte, ingen egen delegerings-vei trengs for den kategorien.
 *
 * Dette er en NESTET, uavhengig `ModelGateway.complete()`-kall inni en
 * verktøy-executor - IKKE en endring av selve routeren/`completeWithTools()`-
 * løkken. Bekreftet trygt (kildekode lest FØR bygging, model-gateway.ts
 * linje 592-596): `completeWithTools()` sin `roundInput` bygges hver runde
 * fra det YTRE, faste `input`-objektet - `providerPreference` satt INNI
 * denne executoren for DETTE nestede kallet lekker ALDRI ut til neste runde
 * av den ytre løkken, som fortsatt bruker `conversation.ts` sin
 * Gemma-preferanse. Gemma synter derfor AUTOMATISK det endelige svaret til
 * eieren fra verktøyresultatet - "tilbakelevering til Gemma" er en direkte
 * konsekvens av EKSISTERENDE tool-loop-arkitektur, ikke ny mekanikk.
 *
 * Ingen automatisk fallback til Gemma selv hvis alle tre spesialister feiler
 * her (i motsetning til D-354s default-fallback i `conversation.ts`) - en
 * eksplisitt eskalering som ikke kan fullføres skal feile ÆRLIG tilbake til
 * Gemma (som verktøyfeil, `success: false`), aldri late som spesialist-
 * arbeidet ble gjort av Gemma selv.
 */
export const DELEGATE_CODE_TASK_TOOL_NAME = "delegate_code_task";

/** D-106s EKSISTERENDE `providerPreference`-mekanisme (router.ts) - ingen ny routing-logikk. */
const SPECIALIST_PROVIDER_PREFERENCE = ["anthropic", "openai", "gemini"];

const SPECIALIST_SYSTEM_PROMPT =
  "Du er en spesialist-modell kalt inn av Jarvis sin primære samtalemodell for å løse ÉN konkret, avgrenset kodeoppgave via et internt verktøykall. Svaret ditt blir lest og videreformidlet av den primære modellen, IKKE direkte av sluttbrukeren - svar derfor presist og direkte på selve oppgaven (bruk kodeblokker der det passer), uten høflighetsfraser/innledninger/avslutninger.";

export const SPECIALIST_DELEGATION_TOOLS: ToolDefinition[] = [
  {
    name: DELEGATE_CODE_TASK_TOOL_NAME,
    description:
      "Deleger en konkret, avgrenset kode-/teknisk deloppgave (f.eks. skrive eller endre et kodeutdrag, feilsøke en stack trace/feilmelding, forklare eller sammenligne teknisk API-bruk) til en sterkere spesialist-modell (Anthropic/OpenAI/Gemini). Bruk KUN for genuint krevende tekniske oppgaver - IKKE for vanlige spørsmål, småprat, eller noe du (den ordinære samtalemodellen) allerede kan svare godt på selv. Resultatet kommer tilbake til deg som verktøyoutput - DU leverer det endelige svaret til eieren, aldri spesialisten direkte.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Den konkrete, selvstendige kodeoppgaven spesialisten skal løse. Inkluder ALL nødvendig kontekst selv (relevant kode, feilmelding, språk/rammeverk) - spesialisten ser IKKE resten av samtalen, kun denne teksten."
        }
      },
      required: ["task"]
    }
  }
];

/**
 * Strukturelt kompatibel med `ModelGateway.ToolExecutor` (samme grensesnitt
 * som `MeshToolExecutor`, `modules/tool-gateway/src/mesh-bridge.ts`) - en
 * ukjent `tool_name` returnerer `TOOL_NOT_FOUND` i stedet for å kaste, slik
 * at en kallside trygt kan komponere denne SAMMEN MED `MeshToolExecutor` (se
 * `apps/api/src/main.ts`), aldri i stedet for den.
 */
export function createSpecialistDelegationExecutor(gateway: ModelGateway): ToolExecutor {
  return {
    async execute(
      call: ToolCallRequest,
      ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
    ): Promise<ToolResultMessage> {
      const at = new Date().toISOString();
      if (call.tool_name !== DELEGATE_CODE_TASK_TOOL_NAME) {
        return {
          tool_call_id: call.tool_call_id,
          tool_name: call.tool_name,
          execution_id: "none",
          success: false,
          output: null,
          error_category: "TOOL_NOT_FOUND",
          at
        };
      }
      const rawTask = call.arguments["task"];
      const task = typeof rawTask === "string" ? rawTask.trim() : "";
      if (task.length === 0) {
        return {
          tool_call_id: call.tool_call_id,
          tool_name: call.tool_name,
          execution_id: ctx.idempotency_key,
          success: false,
          output: null,
          error_category: "INVALID_ARGUMENTS:task_kreves_som_ikke-tom_streng",
          at
        };
      }
      try {
        const result = await gateway.complete({
          tenant_id: ctx.tenant_id,
          ...(ctx.session_id !== undefined ? { session_id: ctx.session_id } : {}),
          ...(ctx.task_id !== undefined ? { task_id: ctx.task_id } : {}),
          purpose: "CODE",
          sensitivity: "PUBLIC_OR_LOW_SENSITIVITY",
          providerPreference: [...SPECIALIST_PROVIDER_PREFERENCE],
          request: {
            system: SPECIALIST_SYSTEM_PROMPT,
            messages: [{ role: "user", content: task }],
            max_tokens: 4096
          }
        });
        return {
          tool_call_id: call.tool_call_id,
          tool_name: call.tool_name,
          execution_id: ctx.idempotency_key,
          success: true,
          output: { specialist_provider: result.provider, specialist_model: result.model, answer: result.text },
          at
        };
      } catch (err) {
        return {
          tool_call_id: call.tool_call_id,
          tool_name: call.tool_name,
          execution_id: ctx.idempotency_key,
          success: false,
          output: null,
          error_category: `SPECIALIST_DELEGATION_FAILED:${err instanceof Error ? err.message : String(err)}`,
          at
        };
      }
    }
  };
}
