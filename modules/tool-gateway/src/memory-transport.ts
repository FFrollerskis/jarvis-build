import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { MemoryRetriever } from "@jarvis/memory";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "./gateway.ts";

/**
 * "Charlie"-minne-verifisering (D-208-linjen, task #118): chat-vendt
 * lesetilgang til DEN SAMME `MemoryRetriever` `ConversationEngine` allerede
 * bruker for bakgrunns-kontekst (`contextFor()`, apps/api/src/
 * conversation.ts) - ALDRI en egen, parallell spørremotor. Samme rotårsak-
 * klasse som D-209 (chat-vendt selv-bevissthet): kapabiliteten (hybrid
 * fulltekst+vektor+relasjon+tid-søk MED kildeangivelse per treff, se
 * `MemoryRetriever.search()`) fantes allerede, men var KUN wiret inn som en
 * stille bakgrunns-kontekst - Tobias hadde INGEN måte å eksplisitt SPØRRE
 * "hva vet du om X" og få et fullt, kildebelagt svar tilbake på.
 *
 * BEVISST HER, IKKE i `@jarvis/memory`: `@jarvis/memory` kan IKKE selv
 * avhenge av `@jarvis/tool-gateway` (ville vært en sirkulær avhengighet -
 * DENNE pakken avhenger ALLEREDE av `@jarvis/memory` for `MemoryWriter`, se
 * `integrations.ts` sin `IngestionService`) - transporten lever derfor her,
 * SAMME retning som den eksisterende presedensen.
 *
 * Identitet UTELUKKENDE fra `ToolInvocationContext.identity` (D-68) - søket
 * skopes ALLTID til `identity.memory_space_id` (SAMME default som
 * `contextFor()` selv bruker). BEVISST INGEN cross-space-søk i P0 - det
 * ville krevd en egen eier-autoritetsvurdering for å hindre utilsiktet
 * space-lekkasje (f.eks. `business`-samtale som utilsiktet avslører
 * `health`-minner) og er derfor utenfor omfanget her.
 *
 * `credential_ref` er den SAMME interne sentinelen som resten av interne
 * verktøy bruker (`"JARVIS_BUSINESS_INTERNAL_TOKEN"`) - literalen brukes
 * HER, ikke importert fra `@jarvis/business`, av SAMME sirkulær-avhengighet-
 * grunn som over (`@jarvis/business` avhenger av `@jarvis/tool-gateway`) -
 * samme presedens som `integrations.ts` sine egne eksisterende
 * verktøydefinisjoner allerede etablerer.
 */
export class MemorySearchTransport implements ToolTransport {
  constructor(private readonly retriever: MemoryRetriever) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity || typeof identity.tenant_id !== "string" || typeof identity.memory_space_id !== "string") {
      throw new Error("memory_missing_invocation_context");
    }
    switch (action) {
      case "search": {
        const query = parameters["query"];
        if (typeof query !== "string" || query.length === 0) throw new Error("missing_parameter:query");
        const limit = parameters["limit"];
        const items = await this.retriever.search(identity, {
          spaces: [identity.memory_space_id],
          query,
          ...(typeof limit === "number" ? { limit } : {})
        });
        return { data: items as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_memory_action:${action}`);
    }
  }
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

export function memoryToolDefinitions(transport: MemorySearchTransport): ToolDefinition[] {
  return [
    {
      tool_id: "memory",
      action: "search",
      description:
        "Søk i lagret minne (hybrid fulltekst+vektor+relasjon, MED kildeangivelse per treff) for denne " +
        "samtalens memory space. Bruk dette for å svare presist og kildebelagt på 'hva vet du om...'/" +
        "'husker du...'-spørsmål - ALDRI gjett på hva som er lagret.",
      input_schema: record({ query: z.string().min(1), limit: z.number().min(1).max(20).optional() }),
      capability_class: "A",
      scopes: ["memory.read"],
      reversible: true,
      rollback_procedure: "ingen (lesing)",
      idempotent_external: true,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal",
      transport,
      timeout_ms: 10_000,
      rate_limit_per_minute: 30
    }
  ];
}
