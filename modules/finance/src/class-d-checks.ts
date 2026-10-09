import type pg from "pg";
import type { SubmitChildCheck, SubmitIntentCheck } from "@jarvis/tool-gateway";
import { assertValidVendorBinding } from "./vendor-registry.ts";
import { classifyFreshSubmit, classifyReservedSubmit, readSubmitAges, SUBMIT_TABLE_KEYS, type SubmitAges, type SubmitTiming } from "./submit-guard.ts";
import type { PaymentIntent } from "./types.ts";
import type { BankAccount, BankConsent } from "./banking-types.ts";

/**
 * WP-F1 (D-453): den FERSKE, READ-ONLY tilstandslesingen klasse D-kjeden bygger på. Brukes to ganger per pengehandling av `ToolGateway`:
 * FØR (målvalidering: kan dette sendes, og hvorfor ikke?) og ETTER (readback: er leverandør-ID og tilstandsovergang bekreftet?). JSON-kontrakten er
 * `SubmitIntentCheckSchema`/`SubmitChildCheckSchema` i `@jarvis/tool-gateway` (`finance-class-d.ts`), som også eier validatorene - her bygges kun dataene.
 *
 * REDIGERT: leverandørreferanser (Fiken-kontakt, Neonomics kreditor-kontoidentifikator = kontonummer) maskeres; ingen KID/kort-/kontonummer i klartekst. Resultatet
 * havner i `tool_executions` og `audit_events` (før-/etter-tilstand), så alt her må tåle å bli lagret.
 */

type ChildKind = SubmitChildCheck["kind"];
const CHILD_TABLE: Readonly<Record<ChildKind, "stripe_refunds" | "vipps_refunds" | "vipps_captures">> = {
  stripe_refund: "stripe_refunds", vipps_refund: "vipps_refunds", vipps_capture: "vipps_captures"
};
const CHILD_PARENT_PROVIDER: Readonly<Record<ChildKind, "stripe" | "vipps">> = { stripe_refund: "stripe", vipps_refund: "vipps", vipps_capture: "vipps" };

/** `…1234 (11)`: de fire siste tegnene og lengden - nok til å kjenne igjen, ikke nok til å bruke. Korte verdier maskeres helt. */
export function maskReference(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v.length === 0) return null;
  return v.length <= 6 ? `***(${v.length})` : `…${v.slice(-4)} (${v.length})`;
}

type Reservation = SubmitIntentCheck["checks"]["reservation"];

function reservationFor(state: string, hasProviderRef: boolean, ages: SubmitAges, idempotentAtProvider: boolean, timing: SubmitTiming): Reservation {
  if (state === "submitted" && !hasProviderRef) {
    const verdict = classifyReservedSubmit(ages, idempotentAtProvider, timing);
    return verdict === "resume" ? "resumable" : verdict;
  }
  if (state === "draft" && classifyFreshSubmit(ages, idempotentAtProvider, timing) === "reconcile_required") return "window_expired";
  return "none";
}

async function killSwitchActive(client: pg.PoolClient, tenantId: string): Promise<boolean> {
  const { rows } = await client.query(`SELECT enabled FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]);
  return (rows[0] as { enabled: boolean } | undefined)?.enabled === true;
}

/** Debitor-kontoen (Neonomics): finnes i denne tenantens bank_accounts, er aktiv, og samtykket er aktivt (samme krav som innsendingen selv stiller). */
async function debtorAccountStatus(client: pg.PoolClient, tenantId: string, bankAccountId: string | null): Promise<string> {
  if (bankAccountId === null) return "invalid:missing";
  const { rows: accountRows } = await client.query(`SELECT * FROM bank_accounts WHERE tenant_id = $1 AND bank_account_id = $2`, [tenantId, bankAccountId]);
  const account = accountRows[0] as BankAccount | undefined;
  if (!account || !account.active) return "invalid:account_not_found_or_inactive";
  const { rows: consentRows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 AND consent_id = $2`, [tenantId, account.consent_id]);
  const consent = consentRows[0] as BankConsent | undefined;
  if (!consent || consent.state !== "active" || !consent.provider_session_id) return "invalid:consent_not_active";
  return "valid";
}

async function vendorBindingStatus(client: pg.PoolClient, tenantId: string, intent: PaymentIntent): Promise<string> {
  if (!intent.vendor_id) return "not_applicable";
  try {
    await assertValidVendorBinding(client, tenantId, intent.payment_intent_id, intent.vendor_id, intent.provider, intent.vendor_provider_ref);
    return "valid";
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    return `invalid:${name === "VendorBindingRevokedError" ? "binding_revoked" : "binding_mismatch"}`;
  }
}

/**
 * Mulige duplikater: ANDRE intensjoner mot samme leverandørtype med samme beløp, valuta og leverandørnavn som allerede er sendt (siste døgn) eller står
 * fast som «innsending startet, utfall ukjent» (uansett alder - de kan ha gått gjennom). Eieren kvitterer eksplisitt (`confirm_possible_duplicate_of`).
 */
async function duplicateCandidates(client: pg.PoolClient, tenantId: string, intent: PaymentIntent): Promise<Array<{ payment_intent_id: string; state: string; created_at: string }>> {
  const { rows } = await client.query(
    `SELECT payment_intent_id, state, created_at FROM payment_intents
      WHERE tenant_id = $1 AND payment_intent_id <> $2 AND provider = $3 AND amount_ore = $4 AND currency = $5
        AND lower(btrim(vendor_name)) = lower(btrim($6))
        AND state IN ('submitted', 'provider_acknowledged', 'settled')
        AND (state = 'submitted' OR COALESCE(submitted_at, created_at) > now() - interval '24 hours')
      ORDER BY created_at DESC LIMIT 5`,
    [tenantId, intent.payment_intent_id, intent.provider, intent.amount_ore, intent.currency, intent.vendor_name]
  );
  return (rows as Array<{ payment_intent_id: string; state: string; created_at: Date | string }>).map((r) => ({
    payment_intent_id: r.payment_intent_id, state: r.state, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)
  }));
}

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function buildSubmitIntentCheck(client: pg.PoolClient, tenantId: string, paymentIntentId: string, timing: SubmitTiming): Promise<SubmitIntentCheck | null> {
  const { rows } = await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2`, [tenantId, paymentIntentId]);
  const intent = rows[0] as PaymentIntent | undefined;
  if (!intent) return null;
  const idempotentAtProvider = intent.provider === "stripe" || intent.provider === "vipps";
  const ages = await readSubmitAges(client, "payment_intents", tenantId, paymentIntentId);
  const active = await killSwitchActive(client, tenantId);
  return {
    v: 1,
    kind: "payment_intent",
    payment_intent: {
      payment_intent_id: intent.payment_intent_id,
      state: intent.state,
      provider: intent.provider,
      provider_ref: intent.provider_ref,
      amount_ore: Number(intent.amount_ore),
      currency: intent.currency,
      account_code: intent.account_code,
      counter_account_code: intent.counter_account_code,
      vendor_ref_present: Boolean(intent.vendor_provider_ref),
      vendor_ref_masked: maskReference(intent.vendor_provider_ref),
      vendor_id: intent.vendor_id,
      provider_status: intent.provider_status,
      provider_reported_amount_ore: nullableNumber(intent.provider_reported_amount_ore),
      provider_reported_currency: intent.provider_reported_currency,
      anomaly_flags: [...(intent.anomaly_flags ?? [])],
      reconciliation_state: intent.reconciliation_state
    },
    checks: {
      kill_switch_active: active,
      vendor_binding: await vendorBindingStatus(client, tenantId, intent),
      debtor_account: intent.provider === "neonomics" ? await debtorAccountStatus(client, tenantId, intent.counter_account_code) : "not_applicable",
      reservation: reservationFor(intent.state, Boolean(intent.provider_ref), ages, idempotentAtProvider, timing),
      duplicate_candidates: await duplicateCandidates(client, tenantId, intent)
    }
  };
}

interface ChildRow {
  payment_intent_id: string; state: string; provider_ref?: string | null; amount_ore: string | number; currency: string; anomaly_flags: string[] | null;
}

export async function buildSubmitChildCheck(client: pg.PoolClient, kind: ChildKind, tenantId: string, id: string, timing: SubmitTiming): Promise<SubmitChildCheck | null> {
  const table = CHILD_TABLE[kind];
  const idColumn = SUBMIT_TABLE_KEYS[table];
  const { rows } = await client.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND ${idColumn} = $2`, [tenantId, id]);
  const child = rows[0] as ChildRow | undefined;
  if (!child) return null;
  const { rows: parentRows } = await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2`, [tenantId, child.payment_intent_id]);
  const parent = parentRows[0] as PaymentIntent | undefined;
  const { rows: sumRows } = await client.query(
    `SELECT COALESCE(SUM(amount_ore), 0)::bigint AS total FROM ${table} WHERE tenant_id = $1 AND payment_intent_id = $2 AND ${idColumn} <> $3 AND state NOT IN ('failed', 'cancelled')`,
    [tenantId, child.payment_intent_id, id]
  );
  const ages = await readSubmitAges(client, table, tenantId, id);
  const hasProviderRef = typeof child.provider_ref === "string" && child.provider_ref.length > 0;
  return {
    v: 1,
    kind,
    child: {
      id,
      payment_intent_id: child.payment_intent_id,
      state: child.state,
      provider_ref: child.provider_ref ?? null,
      amount_ore: Number(child.amount_ore),
      currency: child.currency,
      anomaly_flags: [...(child.anomaly_flags ?? [])]
    },
    parent: parent
      ? {
          payment_intent_id: parent.payment_intent_id,
          provider: parent.provider,
          state: parent.state,
          provider_ref_present: Boolean(parent.provider_ref),
          provider_status: parent.provider_status,
          amount_ore: Number(parent.amount_ore),
          currency: parent.currency
        }
      : null,
    checks: {
      kill_switch_active: await killSwitchActive(client, tenantId),
      // Refusjon/capture-leverandørene (Stripe/Vipps) slår alle sammen gjentatte kall med samme Idempotency-Key.
      reservation: reservationFor(child.state, hasProviderRef || (kind === "vipps_capture" && child.state === "settled"), ages, CHILD_PARENT_PROVIDER[kind] !== undefined, timing),
      other_active_ore: Number((sumRows[0] as { total: string }).total)
    }
  };
}
