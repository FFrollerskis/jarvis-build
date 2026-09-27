import type { ToolCallRequest, ToolDefinition as MeshToolDefinition, ToolResultMessage } from "@jarvis/provider-adapters";
import { zodToJsonSchema } from "zod-to-json-schema";
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
  /**
   * D-30 live-funn: gateway-verktøyenes skjema krever felter (from/to, max, repo)
   * som mesh-definisjonene bevisst IKKE eksponerer for modellen. Parametrene
   * bygges derfor HER i trusted lag (samme presedens som daily-brief) - modellen
   * bestemmer aldri gateway-parametre. Uten dette ga tomme model-args
   * `invalid_parameters`-DENY i ToolGateway for alle tre read-verktøyene.
   */
  parameters?: (modelArgs: Record<string, unknown>) => Record<string, unknown>;
}

const MESH_TOOLS: MeshToolMapping[] = [
  {
    def: {
      name: "read_recent_email",
      description: "Les de nyeste e-postene i eierens innboks (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "email",
    action: "read_inbox",
    parameters: () => ({ max: 10 })
  },
  {
    def: {
      name: "read_calendar_today",
      description: "Les dagens kalenderhendelser (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "calendar",
    action: "read_events",
    parameters: () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
    }
  },
  {
    def: {
      name: "read_github_issues",
      description: "Les åpne GitHub-issues i prosjektrepoet (kun lesing).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "github",
    action: "read_issues",
    parameters: () => ({ repo: process.env["JARVIS_GITHUB_REPO"] ?? "tsworkflow/jarvisbuild" })
  },
  /**
   * D-209 ("Charlie"-selv-bevissthet): eneste sanne kilde for "hva har jeg
   * faktisk tilgang til akkurat nå" - se `@jarvis/executive` sitt
   * `getCapabilityStatus()`. BEVISST inkludert i DENNE listen (ikke bare
   * registrert i gateway) - uten en mesh-mapping ville verktøyet vært
   * registrert i ToolGateway, men ALDRI reelt kallbart fra selve samtalen,
   * nøyaktig det samme gapet som gjorde at Charlie konfabulerte om egne
   * evner i utgangspunktet.
   */
  {
    def: {
      name: "check_my_capabilities",
      description:
        "Sjekk hvilke verktøy du FAKTISK har tilgang til i denne samtalen akkurat nå, hvilken modell/" +
        "leverandør som FAKTISK genererer dette svaret, og siste kjente helsetilstand for tilkoblede " +
        "systemer. Bruk DETTE FØR du sier noe om egne evner, tilkoblinger eller hvilken modell du er " +
        "- gjett ALDRI.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
    },
    tool_id: "executive",
    action: "get_capability_status"
  },
  /**
   * Task #118 ("Charlie"-minne-verifisering): `MemoryRetriever` (se
   * `memory-transport.ts`) var allerede den kanoniske, kildebelagte
   * søkemotoren `contextFor()` bruker for stille bakgrunnskontekst - men
   * Charlie hadde INGEN måte å EKSPLISITT spørre "hva vet du om X" og få et
   * fullt svar tilbake, kun det den stille konteksten tilfeldigvis traff.
   * `query` kommer FRA MODELLEN (ikke en trusted-lag-konstant som de andre
   * mappingene over) - trygt fordi ToolGateway sitt `strict()`-Zod-skjema
   * (`memory-transport.ts`) validerer typen FØR noe når databasen, og selve
   * søket er parameterisert (ingen SQL bygges av fritekst).
   */
  {
    def: {
      name: "search_my_memory",
      description:
        "Søk i det du faktisk har lagret om Tobias/familien for DENNE samtalens memory space (hybrid " +
        "fulltekst+vektor, med kildeangivelse per treff). Bruk dette for å svare kildebelagt på " +
        "'hva vet du om...'/'husker du...'-spørsmål i stedet for å gjette.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Hva du leter etter, på naturlig norsk." } },
        required: ["query"],
        additionalProperties: false
      }
    },
    tool_id: "memory",
    action: "search",
    parameters: (modelArgs) => ({ query: String(modelArgs["query"] ?? "") })
  }
];

/**
 * D-237 (Charlie-selv-bevissthet, funn i faktisk bruk): `meshToolDefinitions()`
 * alene eksponerer KUN navn/beskrivelse - ingen vei til å slå opp det
 * underliggende `tool_id`/`action`-paret og dermed `credential_ref`.
 * `ExecutiveService.getCapabilityStatus()` (D-209, "check_my_capabilities")
 * trengte nettopp DET for å kunne svare "har jeg faktisk credential for
 * dette, akkurat nå" - uten denne eksporten kunne `chat_accessible_tools`
 * kun liste STRUKTURELT eksisterende mesh-verktøy, ALDRI om de faktisk var
 * brukbare (samme konfabulasjonsgap D-209 selv ble bygget for å lukke, bare
 * for credential-dimensjonen i stedet for tool-eksistens-dimensjonen).
 * `parameters`-closuren (trusted-lag-internt, ALDRI modell-styrt) er
 * BEVISST IKKE med her.
 */
export interface MeshToolBinding {
  name: string;
  description: string;
  tool_id: string;
  action: string;
}
export function meshToolBindings(tools: MeshToolMapping[] = MESH_TOOLS): MeshToolBinding[] {
  return tools.map((t) => ({ name: t.def.name, description: t.def.description, tool_id: t.tool_id, action: t.action }));
}

export function meshToolDefinitions(tools: MeshToolMapping[] = MESH_TOOLS): MeshToolDefinition[] {
  return tools.map((t) => t.def);
}

/**
 * D-289 (Tobias direkte i chat, 2026-09-26: "vil ha alt at han har full
 * kontroll" - eksplisitt retningsvalg på D-288 sitt funn om at
 * samtaleflaten strukturelt KUN kunne kalle de 5 kuraterte `MESH_TOOLS`,
 * mens `ToolGateway` hadde ~28 fullt registrerte `tool_id`-er).
 *
 * Genererer ÉN mesh-mapping PER FAKTISK REGISTRERT `tool_id:action`-par
 * (`gateway.list()`) i stedet for en håndskrevet, kuratert liste - samtalen
 * (chat OG tale, BEGGE via `/chat`) kan derfor be Charlie om AKKURAT det
 * dashbordet allerede kan gjøre, ingen mer og ingen mindre. `input_schema`
 * konverteres fra den REGISTRERTE Zod-typen (`zod-to-json-schema`) - modellen
 * ser ALLTID nøyaktig det samme skjemaet `ToolGateway.execute()` selv
 * validerer mot (`input_schema.safeParse()`, `gateway.ts`), ALDRI en egen,
 * potensielt avvikende kopi (samme "aldri en egen avvikende liste"-disiplin
 * som `getCapabilityStatus()` allerede fulgte for de 5 - se D-209/D-237).
 *
 * INGEN ny godkjenningssperre lagt til for klasse C/D her - undersøkt FØR
 * bygging (D-41-disiplin): `ua1-p1a-dclass-mesh.test.ts` beviser allerede at
 * et klasse D-mesh-kall for SOVEREIGN-eieren kjører hele D-pipelinen
 * (preflight → execute → readback → before/after-evidens → audit) UTEN et
 * eksplisitt godkjenningsobjekt, PRESIST slik D-41 (CLAUDE.md regel 12)
 * krever ("ingen kunstig godkjenningssperre for eier" for klasse D) - en NY
 * to-turns bekreftelsesmekanisme for samtaleflaten alene ville vært
 * nettopp den kunstige sperren regelen forbyr, OG en inkonsistens mellom
 * dashbord (utfører umiddelbart) og samtale (venter på bekreftelse) for
 * IDENTISK handling. Autorisasjon/D-pipeline/audit håndheves UENDRET,
 * UANSETT kallende flate - `MeshToolExecutor` går gjennom SAMME
 * `toolGateway.execute()` som dashbordets egne transportlag (§17).
 *
 * Verktøynavn er `${tool_id}__${action}` (dobbel understreking - `tool_id`
 * kan selv inneholde enkel understreking, f.eks. `finance_stripe`) - unikt
 * per konstruksjon (samme `Map`-nøkkel-invariant som `ToolGateway.register()`
 * selv bruker, `${tool_id}:${action}`). INGEN `parameters`-bygger-closure her
 * (i motsetning til `MESH_TOOLS`) - modellens rå argumenter går RETT til
 * `gateway.execute()`, validert DETERMINISTISK av `input_schema.safeParse()`
 * der (§17, CLAUDE.md regel 2 - aldri kun promptregler).
 */
export function allMeshTools(gateway: ToolGateway): MeshToolMapping[] {
  return gateway.list().map((definition) => ({
    def: {
      name: `${definition.tool_id}__${definition.action}`,
      description: `[klasse ${definition.capability_class}] ${definition.description}`,
      input_schema: zodToJsonSchema(definition.input_schema, { target: "openApi3" }) as Record<string, unknown>
    },
    tool_id: definition.tool_id,
    action: definition.action
  }));
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
      // Trusted parameterbygging når mappingen definerer den - ellers model-args.
      parameters: (mapped.parameters ? mapped.parameters(call.arguments) : call.arguments) as never,
      idempotency_key: ctx.idempotency_key,
      // D-317: `call.provider`/`.model` er stemplet av selve adapteren som genererte
      // DENNE turen (se ToolCallRequest sitt filhode i provider-adapters) - ALDRI fra
      // modell-oppgitte argumenter, SAMME trusted-lag-kanal som identity/approval.
      servingModel: { provider: call.provider, model: call.model }
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
