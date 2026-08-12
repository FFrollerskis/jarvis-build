import { verify } from "node:crypto";
import {
  SignedApprovalSchema,
  approvalSigningBytes,
  jsonEquals,
  type JsonValue,
  type SignedApproval
} from "@jarvis/contracts";
import type { DeviceRegistry } from "./device-registry.js";

export type ApprovalCheck =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "malformed_approval"
        | "unknown_device"
        | "invalid_signature"
        | "action_mismatch"
        | "parameters_mismatch"
        | "expired";
    };

/**
 * Deterministisk verifisering av et signert godkjenningsobjekt mot den
 * faktiske handlingen. Nonce-forbruk skjer separat i PolicyGateway slik at
 * en godkjenning som feiler andre kontroller ikke brenner sin nonce.
 */
export function verifyApproval(
  approvalInput: unknown,
  expected: { action: string; parameters: Record<string, JsonValue> },
  devices: DeviceRegistry,
  now: Date
): ApprovalCheck {
  const parsed = SignedApprovalSchema.safeParse(approvalInput);
  if (!parsed.success) {
    return { valid: false, reason: "malformed_approval" };
  }
  const approval: SignedApproval = parsed.data;

  const publicKey = devices.publicKeyFor(approval.approving_device_id);
  if (!publicKey) {
    return { valid: false, reason: "unknown_device" };
  }

  let signatureOk = false;
  try {
    signatureOk = verify(
      null, // Ed25519: algoritmen ligger i nøkkelen
      approvalSigningBytes(approval),
      publicKey,
      Buffer.from(approval.signature, "base64")
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { valid: false, reason: "invalid_signature" };
  }

  // Signaturen er gyldig - kontroller at godkjenningen gjelder EKSAKT denne handlingen.
  if (approval.action !== expected.action) {
    return { valid: false, reason: "action_mismatch" };
  }
  if (!jsonEquals(approval.parameters, expected.parameters)) {
    return { valid: false, reason: "parameters_mismatch" };
  }
  if (new Date(approval.expires_at).getTime() <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true };
}
