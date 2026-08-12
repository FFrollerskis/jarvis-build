import { z } from "zod";

/**
 * Capability-klasser per SECURITY_MODEL §3:
 *  A - lesing og ufarlig analyse
 *  B - reversible interne handlinger
 *  C - eksterne handlinger innen uttrykkelig mandat
 *  D - betaling, kontrakt, sletting, publisering, lås, alarm, tilgangsendring
 */
export const CapabilityClassSchema = z.enum(["A", "B", "C", "D"]);
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;

/** JSON-verdier som kan valideres og kanonisk serialiseres. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)])
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Et verktøykall slik Policy Gateway ser det. Alle verktøykall - fra alle
 * baner - må gjennom Policy Gateway (CANONICAL_SPEC §2.1 punkt 8).
 */
export const ToolCallSchema = z
  .object({
    tool_id: z.string().min(1),
    action: z.string().min(1),
    capability_class: CapabilityClassSchema,
    parameters: z.record(JsonValueSchema)
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
