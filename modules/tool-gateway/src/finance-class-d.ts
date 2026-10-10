import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";

/**
 * WP-F1 (D-462, Q-47 a): klasse D-kjeden for de fire pengehandlingene som var DEFERRED i D-375:
 *   `finance.submit_payment_intent`, `finance_stripe.submit_refund`, `finance_vipps.submit_capture`, `finance_vipps.submit_refund`.
 *
 * Denne filen er DEN rene, deterministiske halvdelen av kjeden (ingen I/O, ingen LLM): validatorer for den ferske tilstandslesingen
 * (`check_submit_*`), etterbetingelser for readbacken, sammendrag til det umiddelbare varselet og credential-oppslag per provider.
 * Tilstandslesingene selv bygges av `@jarvis/finance` (samme JSON-kontrakt som skjemaene under) - `tool-gateway` kan ikke importere finance.
 *
 * Alt her er FAIL-CLOSED: tilstand som ikke passer kontrakten, har ukjent form eller mangler et felt gir avslag (`malformed_state`), aldri et antatt «ok».
 * Beløp er alltid heltall i minste enhet (øre/cent) - aldri flyttall, aldri streng, aldri negative, aldri større enn `MAX_AMOUNT_MINOR_UNITS`.
 */

/** Øvre tak for ett beløp i minste enhet (10 mrd. i hovedenhet). Langt over enhver realistisk enkelttransaksjon, langt under 2^53 (summer forblir eksakte). Speilet i finance/src/ore.ts (låst av test). */
export const MAX_AMOUNT_MINOR_UNITS = 1_000_000_000_000;

/** Leverandørens credential-referanse per provider (JARVIS-072: kravet bestemmes av intensjonens provider, ikke statisk). */
export const FINANCE_PROVIDER_CREDENTIAL_REFS: Readonly<Record<string, string>> = {
  fiken: "JARVIS_FIKEN_REFRESH_TOKEN",
  stripe: "JARVIS_STRIPE_SECRET_KEY",
  vipps: "JARVIS_VIPPS_CLIENT_SECRET",
  neonomics: "JARVIS_NEONOMICS_CLIENT_SECRET"
};

/**
 * Credential-referansen for en provider, eller `null` for en ukjent. Slår kun opp EGNE nøkler (`Object.hasOwn`): en verdi som `constructor`/`__proto__`/`toString`
 * skal aldri løses til noe arvet fra `Object.prototype` (en funksjon er ingen credential-ref, og en ukjent provider skal alltid være fail-closed).
 */
export function financeCredentialRefForProvider(provider: unknown): string | null {
  return typeof provider === "string" && Object.hasOwn(FINANCE_PROVIDER_CREDENTIAL_REFS, provider) ? (FINANCE_PROVIDER_CREDENTIAL_REFS[provider] as string) : null;
}

/**
 * WP-F1 (review F8): connector-id-en(e) en eierfrys skal gjelde for, utledet av den LØSTE credential-referansen. Connector-id-ene i `CONNECTOR_REGISTRY` (fiken/stripe/vipps/neonomics)
 * er identiske med providernavnene. En ukjent referanse gir ingen connector (kun `tool_id`-frysen gjelder, som før).
 */
export function financeConnectorIdsForCredentialRef(ref: string): readonly string[] {
  const ids: string[] = [];
  for (const [provider, credentialRef] of Object.entries(FINANCE_PROVIDER_CREDENTIAL_REFS)) if (credentialRef === ref) ids.push(provider);
  return ids;
}

/** Avviksflagg som betyr at leverandørobjektet ikke kan stoles på som mål for en NY pengehandling (blokkerer innsending til eieren har ryddet). */
export const FINANCE_BLOCKING_INTEGRITY_FLAGS: ReadonlySet<string> = new Set([
  "PROVIDER_OBJECT_TENANT_CONFLICT", "PROVIDER_DUPLICATE_OBJECT_CONFLICT", "PROVIDER_REFERENCE_CONFLICT"
]);

const FIKEN_ACCOUNT = /^\d{4}(:\d{5})?$/;
const CURRENCY = /^[A-Z]{3}$/;

const Reservation = z.enum(["none", "in_flight", "resumable", "reconcile_required", "window_expired"]);

/** `finance.check_submit_payment_intent` - fersk, REDIGERT tilstand (kun maskert leverandørreferanse; aldri kontonummer/KID i klartekst). */
export const SubmitIntentCheckSchema = z.object({
  v: z.literal(1),
  kind: z.literal("payment_intent"),
  payment_intent: z.object({
    payment_intent_id: z.string().min(1),
    state: z.string(),
    provider: z.string(),
    provider_ref: z.string().nullable(),
    amount_ore: z.number(),
    currency: z.string(),
    account_code: z.string(),
    counter_account_code: z.string().nullable(),
    vendor_ref_present: z.boolean(),
    vendor_ref_masked: z.string().nullable(),
    vendor_id: z.string().nullable(),
    /** WP-F1: leverandørnavnet (avkortet) - vises til eieren i sammendraget («betaling til X»). Ren visning. */
    vendor_name: z.string().optional(),
    /** WP-F1: kort, ikke-sensitiv digest av mottakeren (provider, vendor_id, navn, MASKERT referanse, kontokoder) som bekreftelsen bindes til (`expected_recipient`). */
    recipient_digest: z.string().optional(),
    provider_status: z.string().nullable(),
    provider_reported_amount_ore: z.number().nullable(),
    provider_reported_currency: z.string().nullable(),
    anomaly_flags: z.array(z.string()),
    reconciliation_state: z.string()
  }),
  checks: z.object({
    kill_switch_active: z.boolean(),
    vendor_binding: z.string(),
    debtor_account: z.string(),
    reservation: Reservation,
    duplicate_candidates: z.array(z.object({ payment_intent_id: z.string(), state: z.string(), created_at: z.string() })).max(20)
  })
});
export type SubmitIntentCheck = z.infer<typeof SubmitIntentCheckSchema>;

const ParentSchema = z.object({
  payment_intent_id: z.string(),
  provider: z.string(),
  state: z.string(),
  provider_ref_present: z.boolean(),
  provider_status: z.string().nullable(),
  amount_ore: z.number(),
  currency: z.string(),
  /** WP-F1: som for intensjoner - visning og mottaker-digest for foreldrebetalingen (refusjonens/capturens mottaker er foreldrebetalingens motpart). */
  vendor_name: z.string().optional(),
  recipient_digest: z.string().optional()
});

/** `finance_stripe.check_submit_refund` / `finance_vipps.check_submit_refund` / `finance_vipps.check_submit_capture`. */
export const SubmitChildCheckSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["stripe_refund", "vipps_refund", "vipps_capture"]),
  child: z.object({
    id: z.string().min(1),
    payment_intent_id: z.string(),
    state: z.string(),
    provider_ref: z.string().nullable(),
    amount_ore: z.number(),
    currency: z.string(),
    anomaly_flags: z.array(z.string())
  }),
  parent: ParentSchema.nullable(),
  checks: z.object({
    kill_switch_active: z.boolean(),
    reservation: Reservation,
    /** Sum av ALLE andre aktive (ikke-feilede/-kansellerte) refusjoner/captures mot samme betaling. */
    other_active_ore: z.number()
  })
});
export type SubmitChildCheck = z.infer<typeof SubmitChildCheckSchema>;

export function parseSubmitIntentCheck(data: JsonValue | null): SubmitIntentCheck | null {
  const parsed = SubmitIntentCheckSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function parseSubmitChildCheck(data: JsonValue | null): SubmitChildCheck | null {
  const parsed = SubmitChildCheckSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function stringParam(parameters: Record<string, JsonValue>, key: string): string | null {
  const v = parameters[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** `confirm_possible_duplicate_of`: eierens eksplisitte kvittering på at en mulig duplikat er kontrollert (id-en til hver kandidat). */
function acknowledgedDuplicates(parameters: Record<string, JsonValue>): Set<string> {
  const raw = parameters["confirm_possible_duplicate_of"];
  if (typeof raw === "string") return new Set([raw]);
  if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === "string"));
  return new Set();
}

/**
 * WP-F1 (D-462): BINDING TIL BELØP + MOTTAKER. Eierens bundne bekreftelse bærer `expected_amount_ore`, `expected_currency` og `expected_recipient` (digest av mottakeren) fra
 * tilstanden eieren SÅ da hen ba om handlingen. Ved utførelsen sammenlignes de med den FERSKE tilstandslesingen: en intensjon/refusjon/capture som er endret mellom forespørsel
 * og godkjenning (også om DB-triggeren som låser pengekolonnene skulle være slått av) avvises FØR noe reserveres eller sendes. Alt-eller-ingenting: oppgis én, må alle tre oppgis.
 * Ingen binding oppgitt = ingen ekstra sjekk (direkte eier-kall med step-up og skriptene); ruten `/finance/actions` setter alltid alle tre.
 */
export function boundExpectationReason(
  parameters: Record<string, JsonValue>, actual: { amount_ore: number; currency: string; recipient_digest: string | undefined }
): string | null {
  const amount = parameters["expected_amount_ore"];
  const currency = parameters["expected_currency"];
  const recipient = parameters["expected_recipient"];
  if (amount === undefined && currency === undefined && recipient === undefined) return null;
  if (amount === undefined || currency === undefined || recipient === undefined) return "bound_incomplete";
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount !== actual.amount_ore) return "bound_amount_mismatch";
  if (typeof currency !== "string" || currency !== actual.currency) return "bound_currency_mismatch";
  if (typeof recipient !== "string" || actual.recipient_digest === undefined || recipient !== actual.recipient_digest) return "bound_recipient_mismatch";
  return null;
}

function reservationReason(reservation: z.infer<typeof Reservation>, state: string, providerRefPresent: boolean): string | null {
  if (state === "submitted" && !providerRefPresent) {
    if (reservation === "in_flight") return "submit_in_flight";
    if (reservation === "reconcile_required") return "submit_outcome_unknown_reconcile_required";
    if (reservation === "resumable") return null;
    return "submit_state_inconsistent";
  }
  if (state === "draft" && reservation === "window_expired") return "submit_window_expired_reconcile_required";
  return null;
}

function amountReason(amount: number): string | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return "amount_not_positive_integer_ore";
  if (amount > MAX_AMOUNT_MINOR_UNITS) return "amount_too_large";
  return null;
}

/**
 * FERSK TILSTANDSLESING + MÅLVALIDERING for `finance.submit_payment_intent`. Returnerer `null` når innsendingen er gyldig, ellers en kort årsakskode
 * (blir `preflight_invalid:<kode>`). Dekker: riktig mål (intent-id), intent-tilstand i state-machinen, beløpsformat, valuta, konto/motkonto,
 * leverandør-binding, leverandørreferanse, nødbryter, integritetsflagg og mulig duplikat.
 */
export function validateSubmitPaymentIntent(data: JsonValue, parameters: Record<string, JsonValue>): string | null {
  const check = parseSubmitIntentCheck(data);
  if (check === null) return "malformed_state";
  const pi = check.payment_intent;
  if (pi.payment_intent_id !== stringParam(parameters, "payment_intent_id")) return "target_mismatch";
  if (check.checks.kill_switch_active) return "finance_kill_switch_active";
  const bound = boundExpectationReason(parameters, { amount_ore: pi.amount_ore, currency: pi.currency, recipient_digest: pi.recipient_digest });
  if (bound !== null) return bound;

  const providerRefPresent = pi.provider_ref !== null && pi.provider_ref.length > 0;
  const stateReason = reservationReason(check.checks.reservation, pi.state, providerRefPresent);
  if (stateReason !== null) return stateReason;
  if (pi.state !== "draft" && !(pi.state === "submitted" && !providerRefPresent)) return `not_submittable:${pi.state}`;

  const amount = amountReason(pi.amount_ore);
  if (amount !== null) return amount;
  if (!CURRENCY.test(pi.currency)) return "currency_invalid";
  if (financeCredentialRefForProvider(pi.provider) === null) return "unknown_provider";
  // Fiken-posteringen har ingen valutadimensjon (beløpet bokføres i selskapets valuta, NOK) - en annen valuta ville bokført feil beløp.
  if (pi.provider === "fiken" && pi.currency !== "NOK") return "currency_not_supported_for_provider:fiken";
  if (pi.account_code.trim().length === 0) return "account_code_missing";
  if (pi.provider === "fiken") {
    if (!FIKEN_ACCOUNT.test(pi.account_code)) return "invalid_account_code";
    if (pi.counter_account_code === null) return "missing_counter_account_code";
    if (!FIKEN_ACCOUNT.test(pi.counter_account_code)) return "invalid_counter_account_code";
  }
  if ((pi.provider === "fiken" || pi.provider === "neonomics") && !pi.vendor_ref_present) return "missing_vendor_provider_ref";
  if (pi.provider === "neonomics") {
    if (pi.counter_account_code === null) return "missing_counter_account_code";
    if (check.checks.debtor_account !== "valid") return `debtor_account_${check.checks.debtor_account}`.slice(0, 60);
  }
  if (pi.vendor_id !== null && check.checks.vendor_binding !== "valid") return `vendor_binding_${check.checks.vendor_binding}`.slice(0, 60);
  for (const flag of pi.anomaly_flags) if (FINANCE_BLOCKING_INTEGRITY_FLAGS.has(flag)) return `integrity_flag:${flag}`;

  const acknowledged = acknowledgedDuplicates(parameters);
  const unacknowledged = check.checks.duplicate_candidates.find((c) => !acknowledged.has(c.payment_intent_id));
  if (unacknowledged) return `possible_duplicate_of:${unacknowledged.payment_intent_id}`;
  return null;
}

/** ETTERBETINGELSE: leverandør-ID + tilstandsovergang bekreftet via readback, og leverandørens ekko samsvarer med det vi bad om. */
export function submitPaymentIntentPostcondition(after: JsonValue, parameters: Record<string, JsonValue>): boolean {
  const check = parseSubmitIntentCheck(after);
  if (check === null) return false;
  const pi = check.payment_intent;
  if (pi.payment_intent_id !== stringParam(parameters, "payment_intent_id")) return false;
  if (pi.state !== "provider_acknowledged" && pi.state !== "settled") return false;
  if (pi.provider_ref === null || pi.provider_ref.length === 0) return false;
  if (pi.provider_reported_amount_ore !== null && pi.provider_reported_amount_ore !== pi.amount_ore) return false;
  if (pi.provider_reported_currency !== null && pi.provider_reported_currency !== pi.currency) return false;
  for (const flag of pi.anomaly_flags) {
    if (flag === "SUBMIT_OUTCOME_UNKNOWN" || flag === "PROVIDER_AMOUNT_MISMATCH" || flag === "PROVIDER_CURRENCY_MISMATCH" || FINANCE_BLOCKING_INTEGRITY_FLAGS.has(flag)) return false;
  }
  return true;
}

/** `65 234,50 NOK` - heltallsaritmetikk på minste enhet (aldri flyttall). */
export function formatMinorUnits(ore: number, currency: string): string {
  if (!Number.isSafeInteger(ore) || ore < 0) return `ugyldig beløp ${currency}`;
  const major = Math.floor(ore / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${major},${String(ore % 100).padStart(2, "0")} ${currency}`;
}

/**
 * Sammendrag av en betaling. Standard (varselet som går ut via Telegram) har leverandørnavnet men ALDRI noen referanse; eierens egen bekreftelsesvisning (`includeMaskedReference`)
 * viser i tillegg den MASKERTE referansen (siste fire tegn + lengde, aldri hele kontonummeret/KID) slik at eieren kan kjenne igjen mottakerkontoen.
 */
export function summarizeSubmitPaymentIntent(state: JsonValue | null, options: { includeMaskedReference?: boolean } = {}): string | null {
  if (state === null) return null;
  const check = parseSubmitIntentCheck(state);
  if (check === null) return null;
  const pi = check.payment_intent;
  // WP-F1: eieren skal se HVEM som får pengene, ikke bare en id.
  const ref = options.includeMaskedReference === true && pi.vendor_ref_masked ? ` [ref ${pi.vendor_ref_masked}]` : "";
  const to = pi.vendor_name ? ` til ${pi.vendor_name.slice(0, 60)}${ref}` : "";
  return `betaling ${formatMinorUnits(pi.amount_ore, pi.currency)}${to} via ${pi.provider} (intensjon ${pi.payment_intent_id})`;
}

function validateChild(
  data: JsonValue, parameters: Record<string, JsonValue>, idParam: string, kind: SubmitChildCheck["kind"], parentProvider: "stripe" | "vipps"
): { check: SubmitChildCheck } | { reason: string } {
  const check = parseSubmitChildCheck(data);
  if (check === null || check.kind !== kind) return { reason: "malformed_state" };
  if (check.child.id !== stringParam(parameters, idParam)) return { reason: "target_mismatch" };
  if (check.checks.kill_switch_active) return { reason: "finance_kill_switch_active" };
  const bound = boundExpectationReason(parameters, { amount_ore: check.child.amount_ore, currency: check.child.currency, recipient_digest: check.parent?.recipient_digest });
  if (bound !== null) return { reason: bound };
  const providerRefPresent = check.child.provider_ref !== null && check.child.provider_ref.length > 0;
  const stateReason = reservationReason(check.checks.reservation, check.child.state, providerRefPresent);
  if (stateReason !== null) return { reason: stateReason };
  if (check.child.state !== "draft" && !(check.child.state === "submitted" && !providerRefPresent)) return { reason: `not_submittable:${check.child.state}` };
  const amount = amountReason(check.child.amount_ore);
  if (amount !== null) return { reason: amount };
  if (!CURRENCY.test(check.child.currency)) return { reason: "currency_invalid" };
  const parent = check.parent;
  if (parent === null) return { reason: "parent_payment_not_found" };
  if (parent.payment_intent_id !== check.child.payment_intent_id) return { reason: "parent_mismatch" };
  if (parent.provider !== parentProvider) return { reason: `parent_provider_mismatch:${parent.provider}` };
  if (!parent.provider_ref_present) return { reason: "parent_has_no_provider_ref" };
  if (parent.currency !== check.child.currency) return { reason: "currency_mismatch_with_parent" };
  if (!Number.isSafeInteger(check.checks.other_active_ore) || check.checks.other_active_ore < 0) return { reason: "malformed_state" };
  if (check.checks.other_active_ore + check.child.amount_ore > parent.amount_ore) return { reason: "exceeds_parent_amount" };
  return { check };
}

/** `finance_stripe.submit_refund`: refusjon mot en OPPGJORT Stripe-betaling, innenfor det opprinnelige beløpet, riktig valuta. */
export function validateSubmitStripeRefund(data: JsonValue, parameters: Record<string, JsonValue>): string | null {
  const result = validateChild(data, parameters, "refund_id", "stripe_refund", "stripe");
  if ("reason" in result) return result.reason;
  if (result.check.parent!.state !== "settled") return `parent_not_settled:${result.check.parent!.state}`;
  return null;
}

/** `finance_vipps.submit_refund`: refusjon mot en OPPGJORT Vipps-betaling. */
export function validateSubmitVippsRefund(data: JsonValue, parameters: Record<string, JsonValue>): string | null {
  const result = validateChild(data, parameters, "refund_id", "vipps_refund", "vipps");
  if ("reason" in result) return result.reason;
  if (result.check.parent!.state !== "settled") return `parent_not_settled:${result.check.parent!.state}`;
  return null;
}

/** `finance_vipps.submit_capture`: capture mot en AUTORISERT (reservert) Vipps-betaling - aldri mot en betaling som venter på brukeren, er avsluttet eller allerede oppgjort. */
export function validateSubmitVippsCapture(data: JsonValue, parameters: Record<string, JsonValue>): string | null {
  const result = validateChild(data, parameters, "capture_id", "vipps_capture", "vipps");
  if ("reason" in result) return result.reason;
  const parent = result.check.parent!;
  if (parent.state !== "provider_acknowledged") return `parent_not_capturable:${parent.state}`;
  if (parent.provider_status !== "AUTHORIZED") return `parent_not_authorized:${parent.provider_status ?? "unknown"}`;
  return null;
}

function childPostcondition(
  after: JsonValue, parameters: Record<string, JsonValue>, idParam: string, kind: SubmitChildCheck["kind"], allowedStates: readonly string[], needsProviderRef: boolean
): boolean {
  const check = parseSubmitChildCheck(after);
  if (check === null || check.kind !== kind) return false;
  if (check.child.id !== stringParam(parameters, idParam)) return false;
  if (!allowedStates.includes(check.child.state)) return false;
  if (needsProviderRef && (check.child.provider_ref === null || check.child.provider_ref.length === 0)) return false;
  for (const flag of check.child.anomaly_flags) {
    if (flag === "SUBMIT_OUTCOME_UNKNOWN" || flag === "REFUND_AMOUNT_CONFLICT" || flag === "CAPTURE_AMOUNT_CONFLICT") return false;
  }
  // Etter-tilstanden skal fortsatt være innenfor det opprinnelige beløpet (summen av alle aktive inkl. denne).
  if (check.parent === null) return false;
  if (check.checks.other_active_ore + check.child.amount_ore > check.parent.amount_ore) return false;
  return true;
}

export function submitStripeRefundPostcondition(after: JsonValue, parameters: Record<string, JsonValue>): boolean {
  return childPostcondition(after, parameters, "refund_id", "stripe_refund", ["provider_acknowledged", "settled"], true);
}
export function submitVippsRefundPostcondition(after: JsonValue, parameters: Record<string, JsonValue>): boolean {
  return childPostcondition(after, parameters, "refund_id", "vipps_refund", ["settled"], true);
}
export function submitVippsCapturePostcondition(after: JsonValue, parameters: Record<string, JsonValue>): boolean {
  return childPostcondition(after, parameters, "capture_id", "vipps_capture", ["settled"], false);
}

export function summarizeSubmitChild(state: JsonValue | null): string | null {
  if (state === null) return null;
  const check = parseSubmitChildCheck(state);
  if (check === null) return null;
  const what = check.kind === "vipps_capture" ? "capture" : "refusjon";
  const provider = check.kind === "stripe_refund" ? "stripe" : "vipps";
  const counterparty = check.parent?.vendor_name ? `, ${check.parent.vendor_name.slice(0, 60)}` : "";
  return `${what} ${formatMinorUnits(check.child.amount_ore, check.child.currency)} via ${provider} (betaling ${check.child.payment_intent_id}${counterparty})`;
}

/** Gjenopprettingsplaner (kompenserende handling / manuell rutine) - vises i varselet og i `reconcile()`. Aldri en automatisk reversering. */
export const SUBMIT_PAYMENT_INTENT_RECOVERY =
  "Fiken: ingen automatisk reversering - bokfør en manuell korrigerende journalpost direkte i Fiken. Stripe: PaymentIntent er opprettet uten betalingsmetode (ingen penger trukket) - kanseller den i Stripe Dashboard ved feil. " +
  "Vipps: bruk finance_vipps.cancel_payment (klasse C) før capture. Neonomics: bankbetalingen utføres først når kunden fullfører SCA hos banken - avbryt hos banken ved feil. " +
  "UKJENT utfall (outcome_unknown): sjekk leverandørens dashbord FØR du prøver igjen; kjør avstemming (finance.get_reconciliation_status) - ALDRI opprett en ny intensjon for samme betaling uten å ha bekreftet at den første ikke gikk gjennom.";
export const SUBMIT_STRIPE_REFUND_RECOVERY =
  "Ikke reverserbar hos Stripe - en feilaktig refusjon korrigeres ved en NY, separat finansoperasjon (ny betaling), aldri en stille reversering. UKJENT utfall: sjekk Stripe Dashboard (Refunds) FØR du prøver igjen; samme refusjon sendes alltid med samme Idempotency-Key.";
export const SUBMIT_VIPPS_CAPTURE_RECOVERY =
  "Ikke reverserbar hos Vipps - en fanget betaling korrigeres kun via en NY, separat refusjon (request_refund/submit_refund), aldri en stille reversering. UKJENT utfall: sjekk Vipps-portalen FØR du prøver igjen; samme capture sendes alltid med samme Idempotency-Key.";
export const SUBMIT_VIPPS_REFUND_RECOVERY =
  "Ikke reverserbar hos Vipps - ny motsatt-rettet finansoperasjon kreves ved feil, aldri en stille reversering. UKJENT utfall: sjekk Vipps-portalen FØR du prøver igjen; samme refusjon sendes alltid med samme Idempotency-Key.";
