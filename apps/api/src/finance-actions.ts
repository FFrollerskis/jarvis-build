// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  parseSubmitChildCheck,
  parseSubmitIntentCheck,
  summarizeSubmitChild,
  summarizeSubmitPaymentIntent,
  validateSubmitPaymentIntent,
  validateSubmitStripeRefund,
  validateSubmitVippsCapture,
  validateSubmitVippsRefund,
  type ToolGateway
} from "@jarvis/tool-gateway";

/**
 * WP-F1 (D-462, Q-47 a): EIERENS VEI TIL PENGEHANDLINGENE. De fire handlingene (`finance.submit_payment_intent`, `finance_stripe.submit_refund`,
 * `finance_vipps.submit_capture`/`submit_refund`) står på INGEN modellflate og kan ikke utføres av modellen. Eieren når dem slik:
 *   1. `POST /finance/actions` `preview`: fersk, redigert tilstandslesing + målvalidering - «kan dette sendes nå, og hvorfor ikke?» (ingen mutasjon).
 *   2. `POST /finance/actions` `request`: samme validering; er den OK opprettes en BUNDET, engangs, utløpende bekreftelse (`ConfirmationStore.requestPending`) for
 *      NØYAKTIG dette kallet. Ingenting utføres.
 *   3. `POST /confirmations` `decide approve`: eieren godkjenner med en enhetssignert økt (step-up) - først da kjører det lagrede kallet gjennom ToolGateway
 *      (klasse D-pipelinen: ny fersk lesing + validering, reservasjon, leverandørkall med Idempotency-Key, readback, varsel) med bekreftelses-id som idempotensnøkkel.
 * Step-up kreves i alle tre trinn (preview/request/approve) OG håndheves på nytt av ToolGateway selv (`ToolDefinition.step_up_required`).
 * Bekreftelsen er i tillegg BUNDET til beløp, valuta og mottaker-digest slik eieren så dem (`expected_*`, utledet fra den ferske tilstandslesingen - aldri fra klienten), og pengekolonnene
 * er uforanderlige på databasenivå (migrasjon 101): en intensjon kan ikke endres mellom forespørsel og godkjenning, og hvis den likevel var endret avvises utførelsen før noe sendes.
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
  { tool_id: "finance", action: "submit_payment_intent", idParam: "payment_intent_id", checkAction: "check_submit_payment_intent", validate: validateSubmitPaymentIntent, summarize: (state) => summarizeSubmitPaymentIntent(state, { includeMaskedReference: true }), acceptsDuplicateAck: true },
  { tool_id: "finance_stripe", action: "submit_refund", idParam: "refund_id", checkAction: "check_submit_refund", validate: validateSubmitStripeRefund, summarize: summarizeSubmitChild, acceptsDuplicateAck: false },
  { tool_id: "finance_vipps", action: "submit_capture", idParam: "capture_id", checkAction: "check_submit_capture", validate: validateSubmitVippsCapture, summarize: summarizeSubmitChild, acceptsDuplicateAck: false },
  { tool_id: "finance_vipps", action: "submit_refund", idParam: "refund_id", checkAction: "check_submit_refund", validate: validateSubmitVippsRefund, summarize: summarizeSubmitChild, acceptsDuplicateAck: false }
];

/** Handlingene ruten `POST /finance/actions` tilbyr - hardkodet, aldri «alt finance.* tilbyr». `reconciliation_status` er en ren lesing av avstemmingsrapporten. */
export const FINANCE_ACTION_ROUTE_ACTIONS = ["preview", "request", "reconciliation_status"] as const;
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

/**
 * WP-F1 (D-462): eierens BUNDNE forventning - beløp, valuta og mottaker-digest slik de står i den ferske tilstandslesingen eieren ser i forhåndsvisningen. Den følger med i den
 * bundne bekreftelsen (inngår i kall-fingeravtrykket), og klasse D-pipelinen sammenligner den med en NY tilstandslesing ved utførelsen (`boundExpectationReason`): endres beløp eller
 * mottaker mellom forespørsel og godkjenning, avvises utførelsen FØR noe reserveres eller sendes. Klienten kan aldri oppgi disse selv (ruten avviser `expected_*` som ukjent parameter).
 */
export interface BoundExpectation {
  readonly expected_amount_ore: number;
  readonly expected_currency: string;
  readonly expected_recipient: string;
}

/** `null` når tilstanden ikke bærer beløp/valuta/mottaker-digest - da kan ingen bekreftelse opprettes (fail-closed). */
export function boundExpectationFromState(spec: Pick<FinanceMoneyActionSpec, "idParam">, state: JsonValue): BoundExpectation | null {
  if (spec.idParam === "payment_intent_id") {
    const check = parseSubmitIntentCheck(state);
    const pi = check?.payment_intent;
    if (!pi || !pi.recipient_digest) return null;
    return { expected_amount_ore: pi.amount_ore, expected_currency: pi.currency, expected_recipient: pi.recipient_digest };
  }
  const check = parseSubmitChildCheck(state);
  if (!check || !check.parent || !check.parent.recipient_digest) return null;
  return { expected_amount_ore: check.child.amount_ore, expected_currency: check.child.currency, expected_recipient: check.parent.recipient_digest };
}

/** Parametrene til selve pengehandlingen - `tenant_id` kommer ALLTID fra den autentiserte identiteten, aldri fra klienten. */
export function moneyActionParameters(
  identity: Pick<IdentityContext, "tenant_id">, request: ParsedFinanceActionRequest, binding?: BoundExpectation | null
): Record<string, JsonValue> {
  return {
    tenant_id: identity.tenant_id,
    [request.spec.idParam]: request.targetId,
    ...(request.confirmPossibleDuplicateOf.length > 0 ? { confirm_possible_duplicate_of: request.confirmPossibleDuplicateOf } : {}),
    ...(binding ? { expected_amount_ore: binding.expected_amount_ore, expected_currency: binding.expected_currency, expected_recipient: binding.expected_recipient } : {})
  };
}

export type FinanceActionPreview =
  | { ok: true; state: JsonValue; reason: string | null; summary: string | null; binding: BoundExpectation | null }
  | { ok: false; kind: "not_found" | "read_failed"; reason: string };

/**
 * Fersk tilstandslesing + målvalidering for en pengehandling, kjørt gjennom SAMME ToolGateway som all annen utførelse (policy, audit). Ren lesing (klasse A).
 * `reason === null` betyr at handlingen kan sendes nå; ellers er det den samme årsakskoden klasse D-pipelinen ville avvist med (`preflight_invalid:<reason>`).
 */
export async function previewFinanceAction(
  gateway: Pick<ToolGateway, "execute">, identity: IdentityContext, request: ParsedFinanceActionRequest
): Promise<FinanceActionPreview> {
  const read = await gateway.execute({
    identity, tool_id: request.spec.tool_id, action: request.spec.checkAction,
    parameters: { tenant_id: identity.tenant_id, [request.spec.idParam]: request.targetId }
  });
  if (!read.ok) return { ok: false, kind: "read_failed", reason: read.reason };
  if (read.data === undefined || read.data === null) return { ok: false, kind: "not_found", reason: "target_not_found" };
  // Forhåndsvisningen validerer med SAMME bundne forventning som bekreftelsen vil bære (utledet fra tilstanden selv) - så vi viser nøyaktig det pipelinen vil avgjøre ved utførelsen.
  const binding = boundExpectationFromState(request.spec, read.data);
  const parameters = moneyActionParameters(identity, request, binding);
  let reason: string | null;
  try {
    reason = request.spec.validate(read.data, parameters);
  } catch {
    reason = "validator_error";
  }
  return { ok: true, state: read.data, reason: reason === null ? null : reason.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80), summary: request.spec.summarize(read.data), binding };
}

/**
 * WP-F1 (UA-6): avstemmingsrapporten til eieren - `finance.get_reconciliation_status` (klasse A, ren lesing) gjennom SAMME ToolGateway. `tenant_id` kommer fra den autentiserte
 * identiteten. Holdt her (ikke inline i ruten) slik at ruten aldri selv kaller `gateway.execute` (kildevakten i `wpf1-finance-actions-route.test.ts`).
 */
export async function readReconciliationStatus(
  gateway: Pick<ToolGateway, "execute">, identity: IdentityContext
): Promise<{ ok: true; data: JsonValue } | { ok: false; reason: string }> {
  const read = await gateway.execute({ identity, tool_id: "finance", action: "get_reconciliation_status", parameters: { tenant_id: identity.tenant_id } });
  return read.ok ? { ok: true, data: read.data ?? null } : { ok: false, reason: read.reason };
}
