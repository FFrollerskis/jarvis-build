import { z } from "zod";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import type { JsonValue } from "@jarvis/contracts";
import type { ToolDefinition, ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { SelfModificationService } from "./service.ts";

/**
 * Task #121 (D-214): `self_modification.*`-navnerommet. KUN
 * `propose_personality_change` er eksponert som en ToolGateway-handling i
 * denne sliceen - selve automergen (`sweepPendingRequests()`) og
 * godkjenningsoppløsningen (`resolveApproval()`) er BEVISST IKKE
 * chat-kallbare handlinger (de kjøres av en periodisk sveip/Telegram-
 * kommando-håndtering, se apps/api/src/main.ts - å eksponere dem som
 * chat-verktøy ville åpnet en vei for en samtaletur til å trigge en merge
 * direkte, utenom CI-portvakten).
 */
export class SelfModificationTransport implements ToolTransport {
  constructor(private readonly service: SelfModificationService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const identity = context?.identity;
    if (!identity) {
      throw new Error("self_modification_missing_invocation_context");
    }
    switch (action) {
      case "propose_personality_change": {
        const toneDescriptors = requireStringArray(parameters, "tone_descriptors");
        const styleNotes = requireString(parameters, "style_notes");
        const result = await this.service.proposePersonalityChange(identity, {
          tone_descriptors: toneDescriptors,
          style_notes: styleNotes
        });
        return { external_id: result.request_id, data: result as unknown as JsonValue };
      }
      default:
        throw new Error(`unknown_self_modification_action:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_parameter:${key}`);
  return value;
}

function requireStringArray(parameters: Record<string, JsonValue>, key: string): string[] {
  const value = parameters[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    throw new Error(`missing_parameter:${key}`);
  }
  return value as string[];
}

const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

/**
 * Klasse B: reversibel (git-sporet, `git revert` av en enkelt commit),
 * INTERN handling (påvirker kun hvordan Charlie snakker, ALDRI faktisk
 * tilgang/kapabilitet - Policy/Execution Authority er UBERØRT). SAMME
 * begrunnelse som andre klasse B-handlinger i repoet (f.eks. `operations.
 * set_due_at`) - "reversibel intern tilstandsendring", ikke ekstern/
 * betaling/sletting/lås/tilgangsendring. Eksplisitt IKKE klasse D: DENNE
 * navngitte handlingen kaller ALDRI `github.merge_pr` (se github-client.ts
 * sitt filhode) - selve merget skjer i en STRUKTURELT smalere, separat
 * kodevei (sweepPendingRequests()) med sine egne, deterministiske garantier.
 */
export function selfModificationToolDefinitions(transport: SelfModificationTransport): ToolDefinition[] {
  return [
    {
      tool_id: "self_modification", action: "propose_personality_change",
      description: "Foreslå en ny tone/stil for Charlie sin personlighet - skjemavalidert, automerges av CI-portvakten uten manuell gjennomgang (task #121, D-214) siden den ENESTE endrede filen er config/charlie-personality.json",
      input_schema: record({ tone_descriptors: z.array(z.string()), style_notes: z.string() }),
      capability_class: "B", scopes: ["self_modification.personality"],
      reversible: true, rollback_procedure: "git revert av selvendrings-commiten (eller en ny propose_personality_change)",
      idempotent_external: false, timeout_ms: 60_000, rate_limit_per_minute: 5,
      credential_ref: BUSINESS_INTERNAL_CREDENTIAL_REF, output_trust: "internal", transport
    }
  ];
}
