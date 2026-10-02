import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { MemoryRetriever, MemoryWriter, MemoryType } from "@jarvis/memory";
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
/**
 * D-367: `propose` skriver KUN til karantene (aldri autoritativt). `approve_proposal`/`reject_proposal`/`list_proposals`
 * er EIER-handlinger: de står IKKE på modellens verktøyflate (`MODEL_SURFACE_*`), bare på den grant-baserte
 * dashbord-ruten `/memory/proposals` - modellen kan altså aldri godkjenne sine egne forslag.
 */
type ProposalWriter = Pick<MemoryWriter, "propose" | "listProposals" | "promoteFromQuarantine" | "rejectFromQuarantine">;

export class MemorySearchTransport implements ToolTransport {
  constructor(private readonly retriever: MemoryRetriever, private readonly writer?: ProposalWriter) {}

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
      case "propose": {
        if (!this.writer) throw new Error("memory_proposals_not_configured");
        const outcome = await this.writer.propose(identity, {
          subject: String(parameters["subject"] ?? ""),
          content: String(parameters["content"] ?? ""),
          ...(typeof parameters["type"] === "string" ? { type: parameters["type"] as MemoryType } : {})
        });
        const status = outcome.op === "NOOP" ? "already_known" : "quarantined";
        return {
          external_id: "memory_item_id" in outcome ? outcome.memory_item_id : undefined,
          data: {
            status,
            note: status === "quarantined"
              ? "Lagret som FORSLAG i karantene. Det brukes ikke som minne før Tobias godkjenner det i dashbordet."
              : "Dette er allerede lagret."
          }
        } as { external_id?: string; data?: JsonValue };
      }
      case "list_proposals": {
        if (!this.writer) throw new Error("memory_proposals_not_configured");
        return { data: (await this.writer.listProposals(identity)) as unknown as JsonValue };
      }
      case "approve_proposal":
      case "reject_proposal": {
        if (!this.writer) throw new Error("memory_proposals_not_configured");
        const id = parameters["memory_item_id"];
        if (typeof id !== "string" || id.length === 0) throw new Error("missing_parameter:memory_item_id");
        const space = identity.memory_space_id as Parameters<ProposalWriter["promoteFromQuarantine"]>[1];
        const done = action === "approve_proposal"
          ? await this.writer.promoteFromQuarantine(identity, space, id)
          : await this.writer.rejectFromQuarantine(identity, space, id);
        return { data: { done } };
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
    },
    {
      // D-367: modellens eneste skrivehandling mot minne - ALLTID karantene. Klasse B (reverserbar: forslaget kan avvises).
      tool_id: "memory",
      action: "propose",
      description:
        "Foreslå at noe lagres i langtidsminnet. Forslaget havner i KARANTENE og brukes ikke som minne før " +
        "Tobias godkjenner det i dashbordet.",
      input_schema: record({
        subject: z.string().min(1).max(120),
        content: z.string().min(1).max(1000),
        type: z.enum(["semantic", "episodic", "preference", "procedure", "relation", "project", "operational", "decision", "commitment"]).optional()
      }),
      capability_class: "B",
      scopes: ["memory.propose"],
      reversible: true,
      rollback_procedure: "avvis forslaget i dashbordet (invalideres, ikke slettet)",
      idempotent_external: true,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN",
      output_trust: "internal",
      transport,
      timeout_ms: 15_000,
      rate_limit_per_minute: 10
    },
    {
      tool_id: "memory", action: "list_proposals",
      description: "Eier-visning: åpne minneforslag i karantene.",
      input_schema: record({}), capability_class: "A", scopes: ["memory.read"], reversible: true,
      rollback_procedure: "ingen (lesing)", idempotent_external: true,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", output_trust: "internal", transport, timeout_ms: 10_000, rate_limit_per_minute: 30
    },
    {
      tool_id: "memory", action: "approve_proposal",
      description: "Eier-handling (kun dashbord-grant, ikke modellflaten): godkjenn et karantene-forslag så det blir aktivt minne.",
      input_schema: record({ memory_item_id: z.string().min(1) }), capability_class: "B", scopes: ["memory.approve"], reversible: true,
      rollback_procedure: "invalider minnet (memory.invalidate)", idempotent_external: true,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", output_trust: "internal", transport, timeout_ms: 15_000, rate_limit_per_minute: 30
    },
    {
      tool_id: "memory", action: "reject_proposal",
      description: "Eier-handling (kun dashbord-grant, ikke modellflaten): avvis et karantene-forslag.",
      input_schema: record({ memory_item_id: z.string().min(1) }), capability_class: "B", scopes: ["memory.approve"], reversible: false,
      rollback_procedure: "forslaget kan foreslås på nytt", idempotent_external: true,
      credential_ref: "JARVIS_BUSINESS_INTERNAL_TOKEN", output_trust: "internal", transport, timeout_ms: 10_000, rate_limit_per_minute: 30
    }
  ];
}
