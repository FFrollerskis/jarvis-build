// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  summarizeSubmitChild,
  summarizeSubmitPaymentIntent,
  validateSubmitPaymentIntent,
  validateSubmitStripeRefund,
  validateSubmitVippsCapture,
  validateSubmitVippsRefund,
  type ToolGateway
} from "@jarvis/tool-gateway";

/**
 * WP-F1 (D-453, Q-47 a): EIERENS VEI TIL PENGEHANDLINGENE. De fire handlingene (`finance.submit_payment_intent`, `finance_stripe.submit_refund`,
 * `finance_vipps.submit_capture`/`submit_refund`) står på INGEN modellflate og kan ikke utføres av modellen. Eieren når dem slik:
 *   1. `POST /finance/actions` `preview`: fersk, redigert tilstandslesing + målvalidering - «kan dette sendes nå, og hvorfor ikke?» (ingen mutasjon).
 *   2. `POST /finance/actions` `request`: samme validering; er den OK opprettes en BUNDET, engangs, utløpende bekreftelse (`ConfirmationStore.requestPending`) for
 *      NØYAKTIG dette kallet. Ingenting utføres.
 *   3. `POST /confirmations` `decide approve`: eieren godkjenner med en enhetssignert økt (step-up) - først da kjører det lagrede kallet gjennom ToolGateway
 *      (klasse D-pipelinen: ny fersk lesing + validering, reservasjon, leverandørkall med Idempotency-Key, readback, varsel) med bekreftelses-id som idempotensnøkkel.
 * Step-up kreves i alle tre trinn (preview/request/approve) OG håndheves på nytt av ToolGateway selv (`ToolDefinition.step_up_required`).
 * Denne filen er bevisst ren logikk uten I/O utover gateway-lesingen - ruten i `server.ts` eier HTTP, grant og step-up.
 */

export interface FinanceMoneyActionSpec {
  readonly tool_id: string;
  readonly action: string;
  /** Navnet på id-parameteren handlingen retter seg mot (aldri en fri nøkkel fra klienten). */
  readonly idParam: "payment_intent_id" | "refund_id" | "capture_id";
  /** Den ferske, read-only tilstandslesingen (klasse A) som både forhåndsvisning og klasse D-preflight bygger på. */
  readonly checkAction: string;
  readonly validate: (data: JsonValue, parameters: Record<string, JsonValue>) => string | null;
  readonly summarize: (data: JsonValue | null) => string | null;
  /** Kun intensjoner kan ha en mulig duplikat som eieren kvitterer for. */
  readonly acceptsDuplicateAck: boolean;
}

export const FINANCE_MONEY_ACTIONS: ReadonlyArray<FinanceMoneyActionSpec> = [
  { tool_id: "finance", action: "submit_payment_intent", idParam: "payment_intent_id", checkAction: "check_submit_payment_intent", validate: validateSubmitPaymentIntent, summarize: summarizeSubmitPaymentIntent, acceptsDuplicateAck: true },
  { tool_id: "finance_stripe", action: "submit_refund", idParam: "refund_id", checkAction: "check_submit_refund", validate: validateSubmitStripeRefund, summarize: summarizeSubmitChild, acceptsDuplicateAck: false },
  { tool_id: "finance_vipps", action: "submit_capture", idParam: "capture_id", checkAction: "check_submit_capture", validate: validateSubmitVippsCapture, summarize: summarizeSubmitChild, acceptsDuplicateAck: false },
  { tool_id: "finance_vipps", action: "submit_refund", idParam: "refund_id", checkAction: "check_submit_refund", validate: validateSubmitVippsRefund, summarize: summarizeSubmitChild, acceptsDuplicateAck: false }
];

/** Handlingene ruten `POST /finance/actions` tilbyr - hardkodet, aldri «alt finance.* tilbyr». */
export const FINANCE_ACTION_ROUTE_ACTIONS = ["preview", "request"] as const;
export type FinanceActionRouteAction = (typeof FINANCE_ACTION_ROUTE_ACTIONS)[number];

export function financeMoneyActionSpec(tool: string): FinanceMoneyActionSpec | undefined {
  return FINANCE_MONEY_ACTIONS.find((s) => `${s.tool_id}.${s.action}` === tool);
}

export function isFinanceMoneyAction(tool_id: string, action: string): boolean {
  return FINANCE_MONEY_ACTIONS.some((s) => s.tool_id === tool_id && s.action === action);
}

/** Id-er i denne modulen er `fin-pi-<uuid>`/`fin-rf-<uuid>`/`fin-vc-<uuid>`/`fin-vr-<uuid>` - tillat et trygt tegnsett og en fornuftig lengde, aldri fri tekst. */
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export interface ParsedFinanceActionRequest {
  readonly spec: FinanceMoneyActionSpec;
  readonly targetId: string;
  readonly confirmPossibleDuplicateOf: string[];
}

/** Streng validering av `parameters` i forespørselen: nøyaktig `tool`, riktig id-parameter og (for intensjoner) valgfri duplikat-kvittering. Alt annet avvises. */
export function parseFinanceActionRequest(parameters: Record<string, unknown>): { ok: true; request: ParsedFinanceActionRequest } | { ok: false; reason: string } {
  const tool = parameters["tool"];
  if (typeof tool !== "string") return { ok: false, reason: "tool_required" };
  const spec = financeMoneyActionSpec(tool);
  if (!spec) return { ok: false, reason: "tool_not_allowed" };
  const allowed = new Set<string>(["tool", spec.idParam, ...(spec.acceptsDuplicateAck ? ["confirm_possible_duplicate_of"] : [])]);
  for (const key of Object.keys(parameters)) if (!allowed.has(key)) return { ok: false, reason: `unknown_parameter:${key.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, "_")}` };
  const target = parameters[spec.idParam];
  if (typeof target !== "string" || !TARGET_ID.test(target)) return { ok: false, reason: `${spec.idParam}_invalid` };
  const ack = parameters["confirm_possible_duplicate_of"];
  let confirm: string[] = [];
  if (ack !== undefined) {
    if (!Array.isArray(ack) || ack.length > 10 || !ack.every((x) => typeof x === "string" && TARGET_ID.test(x))) return { ok: false, reason: "confirm_possible_duplicate_of_invalid" };
    confirm = [...new Set(ack as string[])];
  }
  return { ok: true, request: { spec, targetId: target, confirmPossibleDuplicateOf: confirm } };
}

/** Parametrene til selve pengehandlingen - `tenant_id` kommer ALLTID fra den autentiserte identiteten, aldri fra klienten. */
export function moneyActionParameters(identity: Pick<IdentityContext, "tenant_id">, request: ParsedFinanceActionRequest): Record<string, JsonValue> {
  return {
    tenant_id: identity.tenant_id,
    [request.spec.idParam]: request.targetId,
    ...(request.confirmPossibleDuplicateOf.length > 0 ? { confirm_possible_duplicate_of: request.confirmPossibleDuplicateOf } : {})
  };
}

export type FinanceActionPreview =
  | { ok: true; state: JsonValue; reason: string | null; summary: string | null }
  | { ok: false; kind: "not_found" | "read_failed"; reason: string };

/**
 * Fersk tilstandslesing + målvalidering for en pengehandling, kjørt gjennom SAMME ToolGateway som all annen utførelse (policy, audit). Ren lesing (klasse A).
 * `reason === null` betyr at handlingen kan sendes nå; ellers er det den samme årsakskoden klasse D-pipelinen ville avvist med (`preflight_invalid:<reason>`).
 */
export async function previewFinanceAction(
  gateway: Pick<ToolGateway, "execute">, identity: IdentityContext, request: ParsedFinanceActionRequest
): Promise<FinanceActionPreview> {
  const parameters = moneyActionParameters(identity, request);
  const read = await gateway.execute({
    identity, tool_id: request.spec.tool_id, action: request.spec.checkAction,
    parameters: { tenant_id: identity.tenant_id, [request.spec.idParam]: request.targetId }
  });
  if (!read.ok) return { ok: false, kind: "read_failed", reason: read.reason };
  if (read.data === undefined || read.data === null) return { ok: false, kind: "not_found", reason: "target_not_found" };
  let reason: string | null;
  try {
    reason = request.spec.validate(read.data, parameters);
  } catch {
    reason = "validator_error";
  }
  return { ok: true, state: read.data, reason: reason === null ? null : reason.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80), summary: request.spec.summarize(read.data) };
}
