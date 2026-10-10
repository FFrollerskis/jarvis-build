import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolTransport } from "./gateway.ts";

/**
 * WP-E1 (UA-5, D-41, regel 11): `ToolDefinition`-ene for Langfuse som kontrollert mål. ALT er klasse A (helse, prosjekt-/nøkkel-metadata, trace-telling): ingenting
 * her endrer noe i Langfuse, og INGEN handling returnerer trace-innhold. Slette traces og nøkkelrotasjon er DEFERRED med begrunnelse (`LANGFUSE_CAPABILITIES` i
 * `langfuse-transport.ts`) - aldri stille utelatt. Verktøy-id `langfuse` er et eier-eksklusivt navnerom (aldri på en modellflate) og står i `INFRA_GATED_TOOL_IDS`
 * (lesing stanses aldri av infra-gaten). Credential = `LANGFUSE_SECRET_KEY` (samme som trace-sinken); uten verdi er alle handlinger `credential_unavailable`.
 */
export const LANGFUSE_CREDENTIAL_REF = "LANGFUSE_SECRET_KEY";

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

export function langfuseToolDefinitions(transport: ToolTransport): ToolDefinition[] {
  const read = (action: string, description: string, shape: z.ZodRawShape = {}): ToolDefinition => ({
    tool_id: "langfuse", action, description, input_schema: record(shape), capability_class: "A", scopes: ["langfuse:read"],
    reversible: true, rollback_procedure: "ingen (lesing)", idempotent_external: true, timeout_ms: 25_000, rate_limit_per_minute: 30,
    credential_ref: LANGFUSE_CREDENTIAL_REF, output_trust: "untrusted", transport
  });
  return [
    read("get_health", "Helse for Langfuse (selvhostet eller sky): 200/503 fra /api/public/health inkl. databasekontroll, og versjon hvis den oppgis"),
    read("get_project", "Prosjekt- og nøkkel-metadata: hvilket prosjekt/organisasjon nøkkelen tilhører og en MASKERT public key (aldri secret key) - bekrefter også at nøkkelparet er gyldig"),
    read("get_trace_counts", "Antall traces/observasjoner og kost per dag siste N dager (maks 31) - KUN tall, aldri innholdet i en trace", { window_days: z.number().int().min(1).max(31).optional() })
  ];
}
