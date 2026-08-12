import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "./capability.js";
import { canonicalStringify } from "./canonical.js";

/**
 * Signert godkjenningsobjekt for klasse D-handlinger (SECURITY_MODEL §3).
 * LLM-en kan be om en godkjenning, men kan aldri opprette, endre eller omgå den.
 * Verifiseres deterministisk i Policy Gateway; nonce er engangs (replay-vern).
 */
export const SignedApprovalSchema = z
  .object({
    /** Handlingen godkjenningen gjelder - må matche verktøykallet eksakt. */
    action: z.string().min(1),
    /** Parametrene godkjenningen gjelder - må matche verktøykallet eksakt. */
    parameters: z.record(JsonValueSchema),
    /** Utløpstid, ISO 8601. Etter dette er godkjenningen ugyldig. */
    expires_at: z.string().datetime(),
    /** Engangs-ID. Én gyldig bruk; deretter avvises den (replay-vern). */
    nonce: z.string().min(16),
    /** Enheten som signerte (må være registrert i enhetsregisteret). */
    approving_device_id: z.string().min(1),
    /** Ed25519-signatur (base64) over kanonisk payload. */
    signature: z.string().min(1)
  })
  .strict();
export type SignedApproval = z.infer<typeof SignedApprovalSchema>;

/** Payloaden som signeres/verifiseres: alt unntatt selve signaturen. */
export type ApprovalPayload = Omit<SignedApproval, "signature">;

/** Kanoniske bytes som signeres. Stabil uavhengig av nøkkelrekkefølge. */
export function approvalSigningBytes(payload: ApprovalPayload): Buffer {
  const canonical: JsonValue = {
    action: payload.action,
    approving_device_id: payload.approving_device_id,
    expires_at: payload.expires_at,
    nonce: payload.nonce,
    parameters: payload.parameters
  };
  return Buffer.from(canonicalStringify(canonical), "utf8");
}
