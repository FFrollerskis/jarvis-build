import { z } from "zod";
import { MemorySpaceSchema, type JsonValue } from "@jarvis/contracts";

/**
 * Q-20 (docs/DATA_ERASURE.md §3): sentralt, typed scope-uttrykk for
 * data-erasure. `tenant_id` er ALLTID eksplisitt til stede - ingen
 * cross-tenant purge er uttrykkbart i denne typen.
 */
export const ErasureScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tenant"), tenant_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("person"), tenant_id: z.string().min(1), person_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("memory_space"), tenant_id: z.string().min(1), memory_space_id: MemorySpaceSchema }).strict(),
  z
    .object({
      type: z.literal("knowledge_source"),
      tenant_id: z.string().min(1),
      source_type: z.string().min(1),
      source_instance_id: z.string().min(1)
    })
    .strict(),
  z.object({ type: z.literal("knowledge_document"), tenant_id: z.string().min(1), knowledge_document_id: z.string().min(1) }).strict(),
  z.object({ type: z.literal("conversation"), tenant_id: z.string().min(1), session_id: z.string().min(1) }).strict()
]);

export type ErasureScope = z.infer<typeof ErasureScopeSchema>;

/** Trygt sammendrag for ledger/receipt (§6) - scope-objektet ER allerede kun identifiers, ingen innhold. */
export function scopeSummary(scope: ErasureScope): Record<string, JsonValue> {
  return { ...scope };
}
