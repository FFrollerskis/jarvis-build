import { describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import {
  FINANCE_BLOCKING_INTEGRITY_FLAGS,
  boundExpectationReason,
  FINANCE_PROVIDER_CREDENTIAL_REFS,
  MAX_AMOUNT_MINOR_UNITS,
  financeCredentialRefForProvider,
  formatMinorUnits,
  parseSubmitChildCheck,
  parseSubmitIntentCheck,
  submitPaymentIntentPostcondition,
  submitStripeRefundPostcondition,
  submitVippsCapturePostcondition,
  submitVippsRefundPostcondition,
  summarizeSubmitChild,
  summarizeSubmitPaymentIntent,
  validateSubmitPaymentIntent,
  validateSubmitStripeRefund,
  validateSubmitVippsCapture,
  validateSubmitVippsRefund
} from "@jarvis/tool-gateway";

/**
 * WP-F1 (D-462): de RENE, deterministiske validatorene/etterbetingelsene for klasse D-kjeden for penger. Ingen I/O - kun JSON inn, årsakskode ut.
 * Adversarielt: feilformet tilstand (feil type, NaN/Infinity, negative, brøk, for store tall, manglende felt) skal ALDRI tolkes som «ok» (fail-closed).
 * Den ferske tilstandslesingen bygges av `@jarvis/finance` (`class-d-checks.ts`); kontrakten her er det som låser de to sidene sammen.
 */

type Json = Record<string, JsonValue>;
const PI = "fin-pi-1";

function intentCheck(over: { pi?: Json; checks?: Json } = {}): JsonValue {
  return {
    v: 1, kind: "payment_intent",
    payment_intent: {
      payment_intent_id: PI, state: "draft", provider: "stripe", provider_ref: null, amount_ore: 10_000, currency: "NOK", account_code: "kategori",
      counter_account_code: null, vendor_ref_present: false, vendor_ref_masked: null, vendor_id: null, provider_status: null,
      provider_reported_amount_ore: null, provider_reported_currency: null, anomaly_flags: [], reconciliation_state: "unreconciled", ...over.pi
    },
    checks: { kill_switch_active: false, vendor_binding: "not_applicable", debtor_account: "not_applicable", reservation: "none", duplicate_candidates: [], ...over.checks }
  } as JsonValue;
}
const params = (extra: Json = {}): Record<string, JsonValue> => ({ tenant_id: "t", payment_intent_id: PI, ...extra });

function childCheck(kind: "stripe_refund" | "vipps_refund" | "vipps_capture", over: { child?: Json; parent?: Json | null; checks?: Json } = {}): JsonValue {
  const provider = kind === "stripe_refund" ? "stripe" : "vipps";
  const settledParent = kind !== "vipps_capture";
  return {
    v: 1, kind,
    child: { id: "child-1", payment_intent_id: PI, state: "draft", provider_ref: null, amount_ore: 4_000, currency: "NOK", anomaly_flags: [], ...over.child },
    parent: over.parent === null ? null : {
      payment_intent_id: PI, provider, state: settledParent ? "settled" : "provider_acknowledged", provider_ref_present: true,
      provider_status: settledParent ? "succeeded" : "AUTHORIZED", amount_ore: 10_000, currency: "NOK", ...over.parent
    },
    checks: { kill_switch_active: false, reservation: "none", other_active_ore: 0, ...over.checks }
  } as JsonValue;
}
const childParams = (idParam: "refund_id" | "capture_id"): Record<string, JsonValue> => ({ tenant_id: "t", [idParam]: "child-1" });

describe("A: validateSubmitPaymentIntent - gyldig og feilformet tilstand", () => {
  it("en gyldig draft-intensjon slipper gjennom (null = ingen årsak)", () => {
    expect(validateSubmitPaymentIntent(intentCheck(), params())).toBeNull();
  });

  it("feilformet tilstand er alltid malformed_state (aldri ok)", () => {
    for (const bad of [null, "streng", 42, [], {}, { v: 2 }, { v: 1, kind: "payment_intent" }, { ...(intentCheck() as Json), kind: "stripe_refund" }]) {
      expect(validateSubmitPaymentIntent(bad as JsonValue, params()), JSON.stringify(bad)).toBe("malformed_state");
    }
    // manglende/feiltypet nøkkelfelt i ellers gyldig struktur
    for (const pi of [{ state: 5 }, { provider: null }, { currency: null }, { account_code: undefined }, { anomaly_flags: "x" }, { vendor_ref_present: "ja" }]) {
      expect(validateSubmitPaymentIntent(intentCheck({ pi: pi as Json }), params()), JSON.stringify(pi)).toBe("malformed_state");
    }
    expect(validateSubmitPaymentIntent(intentCheck({ checks: { reservation: "kanskje" } }), params())).toBe("malformed_state");
    expect(validateSubmitPaymentIntent(intentCheck({ checks: { kill_switch_active: "nei" } }), params())).toBe("malformed_state");
  });

  it("riktig mål: tilstandens intensjons-id må være den som ble bedt om (aldri en annen betaling)", () => {
    expect(validateSubmitPaymentIntent(intentCheck(), params({ payment_intent_id: "fin-pi-ANNEN" }))).toBe("target_mismatch");
    expect(validateSubmitPaymentIntent(intentCheck(), { tenant_id: "t" })).toBe("target_mismatch");
    expect(validateSubmitPaymentIntent(intentCheck(), params({ payment_intent_id: "" }))).toBe("target_mismatch");
  });

  it("nødbryteren stopper alt FØR annen validering", () => {
    expect(validateSubmitPaymentIntent(intentCheck({ checks: { kill_switch_active: true } }), params())).toBe("finance_kill_switch_active");
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { amount_ore: -5 }, checks: { kill_switch_active: true } }), params())).toBe("finance_kill_switch_active");
  });

  it("intent-tilstand i state-machinen: kun draft (og gjenopptakbar reservasjon uten leverandør-ID) kan sendes", () => {
    for (const state of ["provider_acknowledged", "settled", "failed", "cancelled"]) {
      expect(validateSubmitPaymentIntent(intentCheck({ pi: { state, provider_ref: "x" } }), params()), state).toBe(`not_submittable:${state}`);
    }
    // submitted MED leverandør-ID = allerede utført
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { state: "submitted", provider_ref: "pi_1" }, checks: { reservation: "none" } }), params())).toBe("not_submittable:submitted");
    // submitted UTEN leverandør-ID: pågår / avstemming / gjenopptakbar / inkonsistent
    const reserved = (reservation: string) => validateSubmitPaymentIntent(intentCheck({ pi: { state: "submitted" }, checks: { reservation } }), params());
    expect(reserved("in_flight")).toBe("submit_in_flight");
    expect(reserved("reconcile_required")).toBe("submit_outcome_unknown_reconcile_required");
    expect(reserved("resumable")).toBeNull();
    expect(reserved("none")).toBe("submit_state_inconsistent");
    expect(reserved("window_expired")).toBe("submit_state_inconsistent");
    // draft som har vært forsøkt for lenge siden (utenfor leverandørens idempotensvindu)
    expect(validateSubmitPaymentIntent(intentCheck({ checks: { reservation: "window_expired" } }), params())).toBe("submit_window_expired_reconcile_required");
  });

  it("beløpsformat: kun positive, trygge heltall i minste enhet og ikke over formatgrensen", () => {
    const amount = (n: unknown) => validateSubmitPaymentIntent(intentCheck({ pi: { amount_ore: n as JsonValue } }), params());
    expect(amount(1)).toBeNull();
    expect(amount(MAX_AMOUNT_MINOR_UNITS)).toBeNull();
    expect(amount(MAX_AMOUNT_MINOR_UNITS + 1)).toBe("amount_too_large");
    expect(amount(Number.MAX_SAFE_INTEGER)).toBe("amount_too_large");
    expect(amount(0)).toBe("amount_not_positive_integer_ore");
    expect(amount(-1)).toBe("amount_not_positive_integer_ore");
    expect(amount(10.5)).toBe("amount_not_positive_integer_ore");
    // JSON kan ikke bære NaN/Infinity, men et objekt kan: zod avviser dem som malformed (z.number() godtar ikke NaN; Infinity kommer ut som ikke-trygt heltall)
    expect(amount(Number.NaN)).toBe("malformed_state");
    expect(amount(Number.POSITIVE_INFINITY)).toBe("amount_not_positive_integer_ore");
    expect(amount("10000")).toBe("malformed_state");
    expect(amount(null)).toBe("malformed_state");
  });

  it("valuta: tre store bokstaver; Fiken-posteringen har ingen valutadimensjon (kun NOK)", () => {
    const cur = (c: string, provider = "stripe") => validateSubmitPaymentIntent(intentCheck({ pi: { currency: c, provider } }), params());
    expect(cur("NOK")).toBeNull();
    expect(cur("EUR")).toBeNull();
    for (const bad of ["nok", "NO", "NOKK", "N0K", "", " NOK"]) expect(cur(bad), bad).toBe("currency_invalid");
    const fiken = (c: string) => validateSubmitPaymentIntent(intentCheck({ pi: { currency: c, provider: "fiken", account_code: "6540", counter_account_code: "1920", vendor_ref_present: true } }), params());
    expect(fiken("NOK")).toBeNull();
    expect(fiken("EUR")).toBe("currency_not_supported_for_provider:fiken");
  });

  it("konto/motkonto og leverandørreferanse per provider", () => {
    const fiken = (pi: Json) => validateSubmitPaymentIntent(intentCheck({ pi: { provider: "fiken", account_code: "6540", counter_account_code: "1920", vendor_ref_present: true, ...pi } }), params());
    expect(fiken({})).toBeNull();
    expect(fiken({ account_code: "6540:10001" })).toBeNull();
    for (const bad of ["654", "65400", "abcd", "6540:1", "6540:100011", " 6540", "6540;DROP"]) expect(fiken({ account_code: bad }), bad).toBe("invalid_account_code");
    expect(fiken({ counter_account_code: null })).toBe("missing_counter_account_code");
    expect(fiken({ counter_account_code: "19x0" })).toBe("invalid_counter_account_code");
    expect(fiken({ vendor_ref_present: false })).toBe("missing_vendor_provider_ref");
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { account_code: "  " } }), params())).toBe("account_code_missing");
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { provider: "paypal" } }), params())).toBe("unknown_provider");
  });

  it("Neonomics: motkonto, leverandørreferanse og debitor-konto/samtykke må være gyldige", () => {
    const neo = (pi: Json, checks: Json = {}) =>
      validateSubmitPaymentIntent(intentCheck({ pi: { provider: "neonomics", counter_account_code: "bank-acc-1", vendor_ref_present: true, ...pi }, checks: { debtor_account: "valid", ...checks } }), params());
    expect(neo({})).toBeNull();
    expect(neo({ vendor_ref_present: false })).toBe("missing_vendor_provider_ref");
    expect(neo({ counter_account_code: null })).toBe("missing_counter_account_code");
    expect(neo({}, { debtor_account: "invalid:consent_not_active" })).toBe("debtor_account_invalid:consent_not_active");
    expect(neo({}, { debtor_account: "invalid:account_not_found_or_inactive" })).toBe("debtor_account_invalid:account_not_found_or_inactive");
    expect(neo({}, { debtor_account: "not_applicable" })).toBe("debtor_account_not_applicable");
  });

  it("leverandør-binding (D-116): kreves kun når intensjonen hevder en vendor; ugyldig binding stopper", () => {
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { vendor_id: null }, checks: { vendor_binding: "invalid:binding_revoked" } }), params())).toBeNull();
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { vendor_id: "v1" }, checks: { vendor_binding: "valid" } }), params())).toBeNull();
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { vendor_id: "v1" }, checks: { vendor_binding: "invalid:binding_revoked" } }), params())).toBe("vendor_binding_invalid:binding_revoked");
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { vendor_id: "v1" }, checks: { vendor_binding: "invalid:binding_mismatch" } }), params())).toBe("vendor_binding_invalid:binding_mismatch");
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { vendor_id: "v1" }, checks: { vendor_binding: "not_applicable" } }), params())).toBe("vendor_binding_not_applicable");
  });

  it("integritetsflagg fra leverandørkonflikt blokkerer en NY pengehandling mot objektet", () => {
    for (const flag of FINANCE_BLOCKING_INTEGRITY_FLAGS) {
      expect(validateSubmitPaymentIntent(intentCheck({ pi: { anomaly_flags: [flag] } }), params()), flag).toBe(`integrity_flag:${flag}`);
    }
    // et annet (ikke-blokkerende) flagg, f.eks. SUBMIT_OUTCOME_UNKNOWN på en gjenopptakbar Stripe/Vipps-rad, hindrer ikke en trygg gjenopptakelse
    expect(validateSubmitPaymentIntent(intentCheck({ pi: { anomaly_flags: ["SUBMIT_OUTCOME_UNKNOWN"] } }), params())).toBeNull();
  });

  it("mulig duplikat avvises til eieren eksplisitt kvitterer for HVER kandidat", () => {
    const dup = (id: string) => ({ payment_intent_id: id, state: "settled", created_at: "2026-10-09T10:00:00Z" });
    const state = intentCheck({ checks: { duplicate_candidates: [dup("fin-pi-A"), dup("fin-pi-B")] as unknown as JsonValue } });
    expect(validateSubmitPaymentIntent(state, params())).toBe("possible_duplicate_of:fin-pi-A");
    expect(validateSubmitPaymentIntent(state, params({ confirm_possible_duplicate_of: ["fin-pi-A"] }))).toBe("possible_duplicate_of:fin-pi-B");
    expect(validateSubmitPaymentIntent(state, params({ confirm_possible_duplicate_of: ["fin-pi-A", "fin-pi-B"] }))).toBeNull();
    expect(validateSubmitPaymentIntent(state, params({ confirm_possible_duplicate_of: "fin-pi-A" }))).toBe("possible_duplicate_of:fin-pi-B");
    expect(validateSubmitPaymentIntent(state, params({ confirm_possible_duplicate_of: [42, null, "fin-pi-A"] as unknown as JsonValue }))).toBe("possible_duplicate_of:fin-pi-B");
  });
});

describe("B: submitPaymentIntentPostcondition - leverandør-ID + tilstandsovergang bekreftet", () => {
  const after = (pi: Json = {}) => intentCheck({ pi: { state: "provider_acknowledged", provider_ref: "pi_123", ...pi } });
  it("bekreftet: leverandør-ID satt, riktig overgang, ekko stemmer", () => {
    expect(submitPaymentIntentPostcondition(after(), params())).toBe(true);
    expect(submitPaymentIntentPostcondition(after({ state: "settled" }), params())).toBe(true);
    expect(submitPaymentIntentPostcondition(after({ provider_reported_amount_ore: 10_000, provider_reported_currency: "NOK" }), params())).toBe(true);
  });
  it("ikke bekreftet: manglende ID, feil tilstand, ekko som avviker, avviksflagg, feil mål, feilformet", () => {
    expect(submitPaymentIntentPostcondition(after({ provider_ref: null }), params())).toBe(false);
    expect(submitPaymentIntentPostcondition(after({ provider_ref: "" }), params())).toBe(false);
    for (const state of ["draft", "submitted", "failed", "cancelled"]) expect(submitPaymentIntentPostcondition(after({ state }), params()), state).toBe(false);
    expect(submitPaymentIntentPostcondition(after({ provider_reported_amount_ore: 10_001 }), params())).toBe(false);
    expect(submitPaymentIntentPostcondition(after({ provider_reported_currency: "EUR" }), params())).toBe(false);
    for (const flag of ["SUBMIT_OUTCOME_UNKNOWN", "PROVIDER_AMOUNT_MISMATCH", "PROVIDER_CURRENCY_MISMATCH", ...FINANCE_BLOCKING_INTEGRITY_FLAGS]) {
      expect(submitPaymentIntentPostcondition(after({ anomaly_flags: [flag] }), params()), flag).toBe(false);
    }
    expect(submitPaymentIntentPostcondition(after(), params({ payment_intent_id: "fin-pi-ANNEN" }))).toBe(false);
    expect(submitPaymentIntentPostcondition(null as unknown as JsonValue, params())).toBe(false);
    expect(submitPaymentIntentPostcondition({ v: 1 } as JsonValue, params())).toBe(false);
  });
});

describe("C: refusjon/capture - validering mot foreldrebetalingen", () => {
  it("Stripe-refusjon: oppgjort Stripe-betaling, beløp innenfor det opprinnelige, riktig valuta", () => {
    const v = (over: Parameters<typeof childCheck>[1] = {}, p = childParams("refund_id")) => validateSubmitStripeRefund(childCheck("stripe_refund", over), p);
    expect(v()).toBeNull();
    expect(v({ child: { amount_ore: 6_000 }, checks: { other_active_ore: 4_000 } })).toBeNull(); // nøyaktig resten
    expect(v({ child: { amount_ore: 6_001 }, checks: { other_active_ore: 4_000 } })).toBe("exceeds_parent_amount");
    expect(v({ child: { amount_ore: 10_001 } })).toBe("exceeds_parent_amount");
    expect(v({ parent: { state: "provider_acknowledged" } })).toBe("parent_not_settled:provider_acknowledged");
    expect(v({ parent: { state: "failed" } })).toBe("parent_not_settled:failed");
    expect(v({ parent: { provider: "vipps" } })).toBe("parent_provider_mismatch:vipps");
    expect(v({ parent: { provider_ref_present: false } })).toBe("parent_has_no_provider_ref");
    expect(v({ parent: { currency: "EUR" } })).toBe("currency_mismatch_with_parent");
    expect(v({ parent: { payment_intent_id: "fin-pi-ANNEN" } })).toBe("parent_mismatch");
    expect(v({ parent: null })).toBe("parent_payment_not_found");
    expect(v({ checks: { kill_switch_active: true } })).toBe("finance_kill_switch_active");
    expect(v({}, { tenant_id: "t", refund_id: "child-ANNEN" })).toBe("target_mismatch");
    expect(v({}, { tenant_id: "t" })).toBe("target_mismatch");
    // feil type check (Vipps-kontrakt til Stripe-validator)
    expect(validateSubmitStripeRefund(childCheck("vipps_refund"), childParams("refund_id"))).toBe("malformed_state");
  });

  it("refusjon/capture-tilstand: kun draft (eller gjenopptakbar reservasjon uten leverandør-ID)", () => {
    const v = (child: Json, checks: Json = {}) => validateSubmitStripeRefund(childCheck("stripe_refund", { child, checks }), childParams("refund_id"));
    for (const state of ["provider_acknowledged", "settled", "failed", "cancelled"]) expect(v({ state, provider_ref: "re_1" }), state).toBe(`not_submittable:${state}`);
    expect(v({ state: "submitted" }, { reservation: "in_flight" })).toBe("submit_in_flight");
    expect(v({ state: "submitted" }, { reservation: "reconcile_required" })).toBe("submit_outcome_unknown_reconcile_required");
    expect(v({ state: "submitted" }, { reservation: "resumable" })).toBeNull();
    expect(v({ state: "draft" }, { reservation: "window_expired" })).toBe("submit_window_expired_reconcile_required");
  });

  it("beløp/valuta på refusjonen er også fail-closed", () => {
    const v = (child: Json, checks: Json = {}) => validateSubmitStripeRefund(childCheck("stripe_refund", { child, checks }), childParams("refund_id"));
    for (const amount of [0, -1, 1.5, Number.POSITIVE_INFINITY]) expect(v({ amount_ore: amount }), String(amount)).toBe("amount_not_positive_integer_ore");
    expect(v({ amount_ore: MAX_AMOUNT_MINOR_UNITS + 1 })).toBe("amount_too_large");
    expect(v({ amount_ore: "4000" as unknown as JsonValue })).toBe("malformed_state");
    expect(v({ currency: "nok" })).toBe("currency_invalid");
    expect(v({}, { other_active_ore: -1 })).toBe("malformed_state");
    expect(v({}, { other_active_ore: 1.5 })).toBe("malformed_state");
  });

  it("Vipps-refusjon: oppgjort Vipps-betaling", () => {
    const v = (over: Parameters<typeof childCheck>[1] = {}) => validateSubmitVippsRefund(childCheck("vipps_refund", over), childParams("refund_id"));
    expect(v()).toBeNull();
    expect(v({ parent: { state: "provider_acknowledged" } })).toBe("parent_not_settled:provider_acknowledged");
    expect(v({ parent: { provider: "stripe" } })).toBe("parent_provider_mismatch:stripe");
    expect(v({ child: { amount_ore: 10_001 } })).toBe("exceeds_parent_amount");
  });

  it("Vipps-capture: kun mot en AUTORISERT (reservert) betaling - aldri ventende, avsluttet eller allerede oppgjort", () => {
    const v = (over: Parameters<typeof childCheck>[1] = {}) => validateSubmitVippsCapture(childCheck("vipps_capture", over), childParams("capture_id"));
    expect(v()).toBeNull();
    expect(v({ parent: { provider_status: "CREATED" } })).toBe("parent_not_authorized:CREATED");
    expect(v({ parent: { provider_status: null } })).toBe("parent_not_authorized:unknown");
    expect(v({ parent: { provider_status: "TERMINATED" } })).toBe("parent_not_authorized:TERMINATED");
    expect(v({ parent: { state: "settled", provider_status: "AUTHORIZED" } })).toBe("parent_not_capturable:settled");
    expect(v({ parent: { state: "cancelled", provider_status: "AUTHORIZED" } })).toBe("parent_not_capturable:cancelled");
    expect(v({ child: { amount_ore: 10_001 } })).toBe("exceeds_parent_amount");
    expect(v({ child: { amount_ore: 6_000 }, checks: { other_active_ore: 4_000 } })).toBeNull();
  });
});

describe("D: etterbetingelser for refusjon/capture", () => {
  it("Stripe-refusjon: leverandør-ID + provider_acknowledged/settled, ingen konflikt, fortsatt innenfor opprinnelig beløp", () => {
    const post = (over: Parameters<typeof childCheck>[1] = {}) => submitStripeRefundPostcondition(childCheck("stripe_refund", { child: { state: "settled", provider_ref: "re_1" }, ...over }), childParams("refund_id"));
    expect(post()).toBe(true);
    expect(post({ child: { state: "provider_acknowledged", provider_ref: "re_1" } })).toBe(true);
    expect(post({ child: { state: "draft", provider_ref: "re_1" } })).toBe(false);
    expect(post({ child: { state: "failed", provider_ref: "re_1" } })).toBe(false);
    expect(post({ child: { state: "settled", provider_ref: null } })).toBe(false);
    expect(post({ child: { state: "settled", provider_ref: "re_1", anomaly_flags: ["REFUND_AMOUNT_CONFLICT"] } })).toBe(false);
    expect(post({ child: { state: "settled", provider_ref: "re_1", anomaly_flags: ["SUBMIT_OUTCOME_UNKNOWN"] } })).toBe(false);
    expect(post({ child: { state: "settled", provider_ref: "re_1", amount_ore: 9_000 }, checks: { other_active_ore: 2_000 } })).toBe(false);
    expect(post({ parent: null })).toBe(false);
    expect(submitStripeRefundPostcondition(childCheck("stripe_refund", { child: { state: "settled", provider_ref: "re_1" } }), { tenant_id: "t", refund_id: "child-ANNEN" })).toBe(false);
  });

  it("Vipps-refusjon krever leverandør-referanse; Vipps-capture har ingen egen referanse men må være oppgjort", () => {
    expect(submitVippsRefundPostcondition(childCheck("vipps_refund", { child: { state: "settled", provider_ref: "ref" } }), childParams("refund_id"))).toBe(true);
    expect(submitVippsRefundPostcondition(childCheck("vipps_refund", { child: { state: "settled", provider_ref: null } }), childParams("refund_id"))).toBe(false);
    expect(submitVippsRefundPostcondition(childCheck("vipps_refund", { child: { state: "provider_acknowledged", provider_ref: "ref" } }), childParams("refund_id"))).toBe(false);
    expect(submitVippsCapturePostcondition(childCheck("vipps_capture", { child: { state: "settled" } }), childParams("capture_id"))).toBe(true);
    expect(submitVippsCapturePostcondition(childCheck("vipps_capture", { child: { state: "submitted" } }), childParams("capture_id"))).toBe(false);
    expect(submitVippsCapturePostcondition(childCheck("vipps_capture", { child: { state: "settled", anomaly_flags: ["CAPTURE_AMOUNT_CONFLICT"] } }), childParams("capture_id"))).toBe(false);
    expect(submitVippsCapturePostcondition(childCheck("vipps_capture", { child: { state: "settled" } }), childParams("refund_id"))).toBe(false);
  });
});

describe("E: kontrakter, sammendrag og credential-oppslag", () => {
  it("parse*Check: gyldig -> objekt, ugyldig -> null (aldri kast)", () => {
    expect(parseSubmitIntentCheck(intentCheck())).not.toBeNull();
    expect(parseSubmitIntentCheck(null)).toBeNull();
    expect(parseSubmitIntentCheck({ v: 1 })).toBeNull();
    expect(parseSubmitChildCheck(childCheck("vipps_capture"))).not.toBeNull();
    expect(parseSubmitChildCheck({ v: 1, kind: "annet" } as JsonValue)).toBeNull();
  });

  it("credential per provider: fire kjente providere, ukjent = ingen ref (fail-closed i gatewayen)", () => {
    expect(FINANCE_PROVIDER_CREDENTIAL_REFS).toEqual({
      fiken: "JARVIS_FIKEN_REFRESH_TOKEN", stripe: "JARVIS_STRIPE_SECRET_KEY", vipps: "JARVIS_VIPPS_CLIENT_SECRET", neonomics: "JARVIS_NEONOMICS_CLIENT_SECRET"
    });
    expect(FINANCE_PROVIDER_CREDENTIAL_REFS["paypal"]).toBeUndefined();
    expect(Object.keys(FINANCE_PROVIDER_CREDENTIAL_REFS)).not.toContain("__proto__");
    expect(financeCredentialRefForProvider("stripe")).toBe("JARVIS_STRIPE_SECRET_KEY");
    // arvede egenskaper er IKKE providere: aldri en funksjon/objekt fra Object.prototype som «credential»
    for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(financeCredentialRefForProvider(inherited), inherited).toBeNull();
      expect(validateSubmitPaymentIntent(intentCheck({ pi: { provider: inherited } }), params()), inherited).toBe("unknown_provider");
    }
    expect(financeCredentialRefForProvider(undefined)).toBeNull();
    expect(financeCredentialRefForProvider(42)).toBeNull();
    expect(financeCredentialRefForProvider(null)).toBeNull();
  });

  it("formatMinorUnits: heltallsaritmetikk, tusenskille, ugyldig beløp gir ikke et falskt tall", () => {
    expect(formatMinorUnits(0, "NOK")).toBe("0,00 NOK");
    expect(formatMinorUnits(5, "NOK")).toBe("0,05 NOK");
    expect(formatMinorUnits(10_000, "NOK")).toBe("100,00 NOK");
    expect(formatMinorUnits(6_523_450, "NOK")).toBe("65 234,50 NOK");
    expect(formatMinorUnits(100_000_099, "EUR")).toBe("1 000 000,99 EUR");
    expect(formatMinorUnits(-1, "NOK")).toBe("ugyldig beløp NOK");
    expect(formatMinorUnits(1.5, "NOK")).toBe("ugyldig beløp NOK");
    expect(formatMinorUnits(Number.NaN, "NOK")).toBe("ugyldig beløp NOK");
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER + 2, "NOK")).toBe("ugyldig beløp NOK");
  });

  it("sammendrag til det umiddelbare varselet er redigert (ingen kontonummer/KID/leverandørreferanse) og null ved feilformet tilstand", () => {
    const s = summarizeSubmitPaymentIntent(intentCheck({ pi: { vendor_ref_present: true, vendor_ref_masked: "…4321 (11)", counter_account_code: "1920" } }));
    expect(s).toBe(`betaling 100,00 NOK via stripe (intensjon ${PI})`);
    expect(s).not.toMatch(/4321|1920/);
    expect(summarizeSubmitPaymentIntent(null)).toBeNull();
    expect(summarizeSubmitPaymentIntent({ v: 1 })).toBeNull();
    expect(summarizeSubmitChild(childCheck("stripe_refund"))).toBe(`refusjon 40,00 NOK via stripe (betaling ${PI})`);
    expect(summarizeSubmitChild(childCheck("vipps_capture"))).toBe(`capture 40,00 NOK via vipps (betaling ${PI})`);
    expect(summarizeSubmitChild(childCheck("vipps_refund"))).toBe(`refusjon 40,00 NOK via vipps (betaling ${PI})`);
    expect(summarizeSubmitChild(null)).toBeNull();
  });
});

describe("F: binding til beløp og mottaker (`expected_*`) - alt-eller-ingenting, sammenlignet med den FERSKE tilstanden", () => {
  const digest = "0123456789abcdef0123456789abcdef";
  const state = (over: Json = {}): JsonValue => intentCheck({ pi: { vendor_name: "Utleier AS", recipient_digest: digest, ...over } });
  const bound = (extra: Json = {}): Record<string, JsonValue> => params({ expected_amount_ore: 10_000, expected_currency: "NOK", expected_recipient: digest, ...extra });

  it("ingen binding oppgitt = ingen ekstra sjekk (uendret oppførsel); riktig binding slipper gjennom", () => {
    expect(validateSubmitPaymentIntent(state(), params())).toBeNull();
    expect(validateSubmitPaymentIntent(state(), bound())).toBeNull();
  });

  it("avvik i beløp, valuta eller mottaker avvises med spesifikk årsak - også når tilstanden ellers er gyldig", () => {
    expect(validateSubmitPaymentIntent(state({ amount_ore: 10_001 }), bound())).toBe("bound_amount_mismatch");
    expect(validateSubmitPaymentIntent(state({ currency: "EUR" }), bound())).toBe("bound_currency_mismatch");
    expect(validateSubmitPaymentIntent(state({ recipient_digest: "ffffffffffffffffffffffffffffffff" }), bound())).toBe("bound_recipient_mismatch");
    expect(validateSubmitPaymentIntent(state(), bound({ expected_amount_ore: 9_999 }))).toBe("bound_amount_mismatch");
    // tilstanden mangler digest (ukjent mottaker) men binding er oppgitt: fail-closed
    expect(validateSubmitPaymentIntent(intentCheck(), bound())).toBe("bound_recipient_mismatch");
  });

  it("alt-eller-ingenting: oppgis én eller to av tre, avvises hele kallet som `bound_incomplete`", () => {
    for (const present of [["expected_amount_ore"], ["expected_currency"], ["expected_recipient"], ["expected_amount_ore", "expected_currency"], ["expected_currency", "expected_recipient"]]) {
      const p = params(Object.fromEntries(present.map((k) => [k, bound()[k]!])));
      expect(validateSubmitPaymentIntent(state(), p), present.join("+")).toBe("bound_incomplete");
    }
  });

  it("feil type/format på bindingen er aldri «ok» (streng, flyttall, NaN, negative, objekt)", () => {
    for (const bad of ["10000", 10_000.5, Number.NaN, -10_000, null, {}, [10_000], true] as JsonValue[]) {
      expect(validateSubmitPaymentIntent(state(), bound({ expected_amount_ore: bad })), JSON.stringify(bad)).toBe("bound_amount_mismatch");
    }
    for (const bad of [5, null, "nok", ["NOK"]] as JsonValue[]) expect(validateSubmitPaymentIntent(state(), bound({ expected_currency: bad })), JSON.stringify(bad)).toBe("bound_currency_mismatch");
    for (const bad of [5, null, "", digest.toUpperCase(), [digest]] as JsonValue[]) expect(validateSubmitPaymentIntent(state(), bound({ expected_recipient: bad })), JSON.stringify(bad)).toBe("bound_recipient_mismatch");
  });

  it("nødbryteren og målet går FØR bindingen (en aktiv nødbryter forklares som nødbryter)", () => {
    expect(validateSubmitPaymentIntent(intentCheck({ checks: { kill_switch_active: true } }), bound({ expected_amount_ore: 1 }))).toBe("finance_kill_switch_active");
    expect(validateSubmitPaymentIntent(state(), { ...bound(), payment_intent_id: "annen" })).toBe("target_mismatch");
  });

  it("refusjon/capture: bindingen gjelder barnets beløp/valuta og foreldrebetalingens mottaker-digest", () => {
    const refund = (parent: Json = {}, child: Json = {}): JsonValue => childCheck("stripe_refund", { parent: { recipient_digest: digest, vendor_name: "Kunde AS", ...parent }, child });
    const p = { ...childParams("refund_id"), expected_amount_ore: 4_000, expected_currency: "NOK", expected_recipient: digest };
    expect(validateSubmitStripeRefund(refund(), p)).toBeNull();
    expect(validateSubmitStripeRefund(refund({}, { amount_ore: 4_001 }), p)).toBe("bound_amount_mismatch");
    expect(validateSubmitStripeRefund(refund({ recipient_digest: "ffffffffffffffffffffffffffffffff" }), p)).toBe("bound_recipient_mismatch");
    expect(validateSubmitStripeRefund(refund(), { ...childParams("refund_id"), expected_amount_ore: 4_000 })).toBe("bound_incomplete");
    const captureParent = childCheck("vipps_capture", { parent: { recipient_digest: digest } });
    expect(validateSubmitVippsCapture(captureParent, { ...childParams("capture_id"), expected_amount_ore: 4_000, expected_currency: "NOK", expected_recipient: digest })).toBeNull();
    expect(validateSubmitVippsCapture(childCheck("vipps_capture", { parent: null }), { ...childParams("capture_id"), expected_amount_ore: 4_000, expected_currency: "NOK", expected_recipient: digest })).toBe("bound_recipient_mismatch");
  });

  it("boundExpectationReason direkte: ingen parametre = null", () => {
    expect(boundExpectationReason({}, { amount_ore: 1, currency: "NOK", recipient_digest: undefined })).toBeNull();
  });

  it("sammendrag: leverandørnavnet vises, referansen vises KUN i eierens bekreftelsesvisning (maskert) og aldri i varselet", () => {
    const s = state({ vendor_ref_present: true, vendor_ref_masked: "…4321 (11)", counter_account_code: "1920" });
    expect(summarizeSubmitPaymentIntent(s)).toBe(`betaling 100,00 NOK til Utleier AS via stripe (intensjon ${PI})`);
    expect(summarizeSubmitPaymentIntent(s, { includeMaskedReference: true })).toBe(`betaling 100,00 NOK til Utleier AS [ref …4321 (11)] via stripe (intensjon ${PI})`);
    expect(summarizeSubmitPaymentIntent(s)).not.toMatch(/4321|1920/);
    expect(summarizeSubmitPaymentIntent(state({ vendor_name: "x".repeat(200) }))).toContain(`til ${"x".repeat(60)} via`);
    expect(summarizeSubmitChild(childCheck("stripe_refund", { parent: { vendor_name: "Kunde AS" } }))).toBe(`refusjon 40,00 NOK via stripe (betaling ${PI}, Kunde AS)`);
  });
});
