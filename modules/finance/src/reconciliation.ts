import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { SUBMIT_INFLIGHT_LEASE_MS } from "./submit-guard.ts";

/**
 * WP-F1 (D-462, UA-6 akseptanse «hver pengehandling mapper intent -> provider-forespørsel -> utfall -> regnskap/avstemming»): DETERMINISTISK avstemming av penger.
 *
 * `reconcileFinance` sammenholder (1) betalingsintensjoner, (2) leverandørutfall slik Jarvis har lagret dem (oppfriskinger + webhooks) og (3) Fiken-bilag, og
 * registrerer avvik som FUNN. Funnene er OBSERVASJONER med varsel - aldri en automatisk korreksjon, aldri en ny pengehandling, aldri en endring av
 * intensjonens tilstand eller beløp. Eneste skriving utenfor funn-/kjøringstabellene er at avviksflagg `RECONCILE_*` settes på (og fjernes fra) selve
 * intensjonen, slik at den EKSISTERENDE open-loop-flaten (`payment_intent_anomaly`) viser dem uten noen ny mekanisme.
 *
 * Alt er ren, deterministisk kode (ingen LLM). Kjøringen er DORMANT uten credentials: den lokale delen krever ingen, og Fiken-delen hoppes over SYNLIG
 * (`checks.fiken = skipped_no_credentials`) i stedet for å se grønn ut. Leverandørlesing (Fiken) skjer UTENFOR enhver DB-transaksjon (JARVIS-019).
 *
 * ÆRLIGHET om Fiken: Fikens liste-API er ikke verifisert mot primærkilden i dette miljøet (paginering, svarform). Fravær av et bilag konkluderes derfor
 * KUN når leseren beviser en komplett liste (`complete: true`); positive funn (bilag med Jarvis-markør som ikke hører til en kjent intensjon, to bilag for én
 * intensjon, beløp som ikke stemmer) kreves ikke komplett liste. Produksjonsleseren melder `complete: false` inntil pagineringen er verifisert.
 */

export type ReconciliationSeverity = "info" | "warning" | "critical";

export type ReconciliationFindingKind =
  | "provider_amount_mismatch"
  | "provider_currency_mismatch"
  | "provider_ref_missing"
  | "submit_outcome_unknown"
  | "over_refunded"
  | "over_captured"
  | "possible_duplicate_payment"
  | "settled_unreconciled"
  | "webhook_rejected"
  | "webhook_unprocessed"
  | "fiken_posting_missing"
  | "fiken_posting_unlinked"
  | "fiken_posting_mismatch";

/** Funn som beregnes av den LOKALE delen (alltid, ingen credentials). */
export const LOCAL_FINDING_KINDS: readonly ReconciliationFindingKind[] = [
  "provider_amount_mismatch", "provider_currency_mismatch", "provider_ref_missing", "submit_outcome_unknown", "over_refunded", "over_captured",
  "possible_duplicate_payment", "settled_unreconciled", "webhook_rejected", "webhook_unprocessed"
];
/** Funn som krever Fiken-lesing. `fiken_posting_missing` krever dessuten en bevist komplett liste. */
export const FIKEN_FINDING_KINDS: readonly ReconciliationFindingKind[] = ["fiken_posting_missing", "fiken_posting_unlinked", "fiken_posting_mismatch"];

export interface ReconciliationFindingDraft {
  readonly kind: ReconciliationFindingKind;
  readonly severity: ReconciliationSeverity;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly payment_intent_id: string | null;
  /** Kort, REDIGERT norsk sammendrag (id-er, tilstander og beløp - aldri kontonummer/KID/kortdata). */
  readonly summary: string;
  readonly expected: Record<string, JsonValue>;
  readonly observed: Record<string, JsonValue>;
  /** Skiller flere funn av samme art på samme subjekt (f.eks. to ulike bilag). */
  readonly discriminator?: string;
}

export function findingKey(d: Pick<ReconciliationFindingDraft, "kind" | "subject_type" | "subject_id" | "discriminator">): string {
  return `${d.kind}:${d.subject_type}:${d.subject_id}${d.discriminator ? `:${d.discriminator}` : ""}`.slice(0, 400);
}

/** Avviksflagget som settes på intensjonen for et funn (leses av den eksisterende open-loop-flaten). Kun funn av alvorlighet warning/critical flagges. */
export function reconcileFlagFor(kind: ReconciliationFindingKind): string {
  return `RECONCILE_${kind.toUpperCase()}`;
}
const RECONCILE_FLAG_PREFIX = "RECONCILE_";

/** `1 234,50 NOK` - heltallsaritmetikk på minste enhet (aldri flyttall). */
export function formatOre(ore: number, currency: string): string {
  if (!Number.isSafeInteger(ore)) return `ugyldig beløp ${currency}`;
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  const major = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${major},${String(abs % 100).padStart(2, "0")} ${currency}`;
}

const asNumber = (v: unknown): number => (typeof v === "number" ? v : Number(v));

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Fiken-markør: gjør et Fiken-bilag sporbart tilbake til intensjonen (Fiken har ingen Idempotency-Key og returnerer ikke vår id).
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const MARKER_PATTERN = /\[J:([0-9a-z]{6,12})\]/;
/** Samlet tak for beskrivelsen vi sender til Fiken (konservativt - Fikens faktiske grense er ikke verifisert). */
export const FIKEN_DESCRIPTION_MAX_LENGTH = 140;

/** Kort, stabil token for en intensjons-id: de 12 første hex-/alfanumeriske tegnene etter `fin-pi-` (uuid uten bindestreker). Ikke en hemmelighet. */
export function fikenPostingToken(paymentIntentId: string): string {
  const compact = paymentIntentId.replace(/^fin-pi-/, "").replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
  return compact.slice(0, 12);
}

export function fikenPostingMarker(paymentIntentId: string): string {
  return `[J:${fikenPostingToken(paymentIntentId)}]`;
}

/** Beskrivelsen som sendes til Fiken: formålet (avkortet) + markøren. Brukes av `submitPaymentIntent` og leses av avstemmingen. */
export function fikenPostingDescription(purpose: string, paymentIntentId: string): string {
  const marker = fikenPostingMarker(paymentIntentId);
  const room = FIKEN_DESCRIPTION_MAX_LENGTH - marker.length - 1;
  const base = purpose.replace(/\s+/g, " ").trim().slice(0, room).trim();
  return `${base.length > 0 ? base : "Jarvis"} ${marker}`;
}

/** Tokenen i en Fiken-beskrivelse, eller `null` hvis bilaget ikke har en Jarvis-markør. */
export function parseFikenPostingMarker(description: string | null | undefined): string | null {
  if (typeof description !== "string") return null;
  return MARKER_PATTERN.exec(description)?.[1] ?? null;
}

export interface FikenPostingEntry {
  readonly journalEntryId: string;
  readonly description: string | null;
  readonly date: string | null;
  /** Sum av debet-linjer i øre hvis Fiken oppga linjene; ellers `null` (beløpet kan da ikke avstemmes). */
  readonly debitTotalOre: number | null;
}

export interface FikenPostingListing {
  readonly entries: readonly FikenPostingEntry[];
  /** `true` KUN når lesingen beviselig dekker alle bilag. Utelatt/`false` => fravær av et bilag er ingen konklusjon. */
  readonly complete: boolean;
}

/** Leser Fiken-bilag. `null` = ikke konfigurert (ingen credentials) - avstemmingen er da dormant for Fiken og sier det. */
export interface FikenPostingReader {
  listPostings(tenantId: string): Promise<FikenPostingListing | null>;
}

export interface FikenIntentRow {
  readonly payment_intent_id: string;
  readonly state: string;
  readonly provider_ref: string | null;
  readonly amount_ore: number;
  readonly currency: string;
}

/**
 * Ren sammenligning intensjoner <-> Fiken-bilag. Positive funn (markør uten kjent intensjon, to bilag for én intensjon, bilag for en intensjon som ikke er sendt,
 * beløp som ikke stemmer) krever ikke komplett liste; fravær av et bilag for en bekreftet intensjon krever det.
 */
export function compareWithFiken(intents: readonly FikenIntentRow[], listing: FikenPostingListing): ReconciliationFindingDraft[] {
  const drafts: ReconciliationFindingDraft[] = [];
  const byToken = new Map<string, FikenIntentRow[]>();
  for (const intent of intents) {
    const token = fikenPostingToken(intent.payment_intent_id);
    byToken.set(token, [...(byToken.get(token) ?? []), intent]);
  }
  const entryIds = new Set(listing.entries.map((e) => e.journalEntryId));

  for (const entry of listing.entries) {
    const token = parseFikenPostingMarker(entry.description);
    if (token === null) continue; // ikke et Jarvis-bilag
    const matches = byToken.get(token) ?? [];
    if (matches.length === 0) {
      drafts.push({
        kind: "fiken_posting_unlinked", severity: "critical", subject_type: "fiken_journal_entry", subject_id: entry.journalEntryId, payment_intent_id: null,
        summary: `Fiken-bilag ${entry.journalEntryId} har Jarvis-markør ${token} uten kjent betalingsintensjon`,
        expected: { intent_for_marker: token }, observed: { journal_entry_id: entry.journalEntryId, marker: token }
      });
      continue;
    }
    if (matches.length > 1) {
      drafts.push({
        kind: "fiken_posting_unlinked", severity: "warning", subject_type: "fiken_journal_entry", subject_id: entry.journalEntryId, payment_intent_id: null,
        summary: `Fiken-bilag ${entry.journalEntryId} har markør ${token} som passer flere intensjoner - kan ikke knyttes entydig`,
        expected: { single_intent_for_marker: token }, observed: { journal_entry_id: entry.journalEntryId, candidate_count: matches.length }
      });
      continue;
    }
    const intent = matches[0]!;
    if (intent.provider_ref === entry.journalEntryId) {
      if (entry.debitTotalOre !== null && entry.debitTotalOre !== intent.amount_ore) {
        drafts.push({
          kind: "fiken_posting_mismatch", severity: "critical", subject_type: "payment_intent", subject_id: intent.payment_intent_id, payment_intent_id: intent.payment_intent_id,
          summary: `Fiken-bilag ${entry.journalEntryId} er bokført med ${formatOre(entry.debitTotalOre, intent.currency)}, intensjonen er ${formatOre(intent.amount_ore, intent.currency)}`,
          expected: { amount_ore: intent.amount_ore, currency: intent.currency }, observed: { journal_entry_id: entry.journalEntryId, debit_total_ore: entry.debitTotalOre },
          discriminator: entry.journalEntryId
        });
      }
      continue;
    }
    const unsent = intent.state === "draft" || intent.state === "failed" || intent.state === "cancelled";
    const summary = intent.provider_ref === null
      ? unsent
        ? `Fiken har bilag ${entry.journalEntryId} for intensjon ${intent.payment_intent_id} som står som ${intent.state} (ikke sendt) - mulig postering uten bekreftelse`
        : `Intensjon ${intent.payment_intent_id} mangler bekreftet bilags-ID, men Fiken har bilag ${entry.journalEntryId} med markøren (utfallet kan avklares)`
      : `Intensjon ${intent.payment_intent_id} peker på bilag ${intent.provider_ref}, men Fiken har også bilag ${entry.journalEntryId} med samme markør - mulig dobbeltpostering`;
    drafts.push({
      kind: "fiken_posting_unlinked", severity: "critical", subject_type: "fiken_journal_entry", subject_id: entry.journalEntryId, payment_intent_id: intent.payment_intent_id,
      summary, expected: { journal_entry_id: intent.provider_ref, state: intent.state }, observed: { journal_entry_id: entry.journalEntryId, marker: token }
    });
  }

  if (listing.complete) {
    for (const intent of intents) {
      if ((intent.state !== "provider_acknowledged" && intent.state !== "settled") || intent.provider_ref === null) continue;
      if (!entryIds.has(intent.provider_ref)) {
        drafts.push({
          kind: "fiken_posting_missing", severity: "critical", subject_type: "payment_intent", subject_id: intent.payment_intent_id, payment_intent_id: intent.payment_intent_id,
          summary: `Intensjon ${intent.payment_intent_id} (${formatOre(intent.amount_ore, intent.currency)}) peker på Fiken-bilag ${intent.provider_ref}, som ikke finnes i Fiken`,
          expected: { journal_entry_id: intent.provider_ref }, observed: { found: false }
        });
      }
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Lokale detektorer (ren logikk over rader lest i én kort transaksjon)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface IntentRow {
  readonly payment_intent_id: string;
  readonly provider: string;
  readonly state: string;
  readonly amount_ore: number;
  readonly currency: string;
  readonly provider_ref: string | null;
  readonly provider_reported_amount_ore: number | null;
  readonly provider_reported_currency: string | null;
  readonly reconciliation_state: string;
  readonly anomaly_flags: readonly string[];
  /** Millisekunder siden reservasjonen (`submitted_at`), målt av databasen; `null` = ukjent. */
  readonly submitted_age_ms: number | null;
  /** Dager siden oppgjør (`settled_at`); `null` = ikke oppgjort. */
  readonly settled_age_days: number | null;
}

export interface DetectorOptions {
  /** Hvor lenge en reservasjon uten leverandørsvar regnes som pågående før utfallet er «ukjent» (standard: samme lease som innsendingen). */
  readonly leaseMs: number;
  /** Dager et oppgjort beløp får stå uavstemt før det flagges (info). */
  readonly settledUnreconciledDays: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = { leaseMs: SUBMIT_INFLIGHT_LEASE_MS, settledUnreconciledDays: 7 };

export function detectIntentFindings(rows: readonly IntentRow[], options: DetectorOptions = DEFAULT_DETECTOR_OPTIONS): ReconciliationFindingDraft[] {
  const drafts: ReconciliationFindingDraft[] = [];
  for (const r of rows) {
    const base = { subject_type: "payment_intent", subject_id: r.payment_intent_id, payment_intent_id: r.payment_intent_id };
    const money = formatOre(r.amount_ore, r.currency);
    if (r.provider_reported_amount_ore !== null && r.provider_reported_amount_ore !== r.amount_ore) {
      drafts.push({
        ...base, kind: "provider_amount_mismatch", severity: "critical",
        summary: `${r.provider} oppgir ${formatOre(r.provider_reported_amount_ore, r.provider_reported_currency ?? r.currency)}, intensjon ${r.payment_intent_id} er ${money}`,
        expected: { amount_ore: r.amount_ore, currency: r.currency }, observed: { provider_reported_amount_ore: r.provider_reported_amount_ore, provider_reported_currency: r.provider_reported_currency }
      });
    }
    if (r.provider_reported_currency !== null && r.provider_reported_currency !== r.currency) {
      drafts.push({
        ...base, kind: "provider_currency_mismatch", severity: "critical",
        summary: `${r.provider} oppgir valuta ${r.provider_reported_currency}, intensjon ${r.payment_intent_id} er i ${r.currency}`,
        expected: { currency: r.currency }, observed: { provider_reported_currency: r.provider_reported_currency }
      });
    }
    if ((r.state === "provider_acknowledged" || r.state === "settled") && (r.provider_ref === null || r.provider_ref.length === 0)) {
      drafts.push({
        ...base, kind: "provider_ref_missing", severity: "critical",
        summary: `Intensjon ${r.payment_intent_id} (${money}) står som ${r.state} uten leverandør-ID`,
        expected: { provider_ref: "present" }, observed: { state: r.state, provider_ref: null }
      });
    }
    const flaggedUnknown = r.anomaly_flags.includes("SUBMIT_OUTCOME_UNKNOWN");
    const staleReservation = r.state === "submitted" && (r.provider_ref === null || r.provider_ref.length === 0) && (r.submitted_age_ms === null || r.submitted_age_ms >= options.leaseMs);
    if (flaggedUnknown || staleReservation) {
      drafts.push({
        ...base, kind: "submit_outcome_unknown", severity: "critical",
        summary: `Innsending av intensjon ${r.payment_intent_id} (${money} via ${r.provider}) har ukjent utfall - sjekk hos leverandøren FØR noe prøves på nytt`,
        expected: { outcome: "confirmed_or_rejected_by_provider" }, observed: { state: r.state, flagged: flaggedUnknown, reservation_stale: staleReservation }
      });
    }
    if (r.state === "settled" && r.reconciliation_state === "unreconciled" && r.settled_age_days !== null && r.settled_age_days >= options.settledUnreconciledDays) {
      drafts.push({
        ...base, kind: "settled_unreconciled", severity: "info",
        summary: `Intensjon ${r.payment_intent_id} (${money}) har vært oppgjort i ${Math.floor(r.settled_age_days)} dager uten avstemming mot regnskap/bank`,
        expected: { reconciliation_state: "matched" }, observed: { reconciliation_state: r.reconciliation_state, settled_age_days: Math.floor(r.settled_age_days) }
      });
    }
  }
  return drafts;
}

export interface OverSumRow {
  readonly payment_intent_id: string;
  readonly amount_ore: number;
  readonly currency: string;
  readonly refunded_ore: number;
  readonly captured_ore: number;
}

export function detectOverSumFindings(rows: readonly OverSumRow[]): ReconciliationFindingDraft[] {
  const drafts: ReconciliationFindingDraft[] = [];
  for (const r of rows) {
    const base = { subject_type: "payment_intent", subject_id: r.payment_intent_id, payment_intent_id: r.payment_intent_id };
    if (r.refunded_ore > r.amount_ore) {
      drafts.push({
        ...base, kind: "over_refunded", severity: "critical",
        summary: `Refusjoner (${formatOre(r.refunded_ore, r.currency)}) overstiger betalingen (${formatOre(r.amount_ore, r.currency)}) for intensjon ${r.payment_intent_id}`,
        expected: { max_refundable_ore: r.amount_ore }, observed: { refunded_ore: r.refunded_ore }
      });
    }
    if (r.captured_ore > r.amount_ore) {
      drafts.push({
        ...base, kind: "over_captured", severity: "critical",
        summary: `Capture (${formatOre(r.captured_ore, r.currency)}) overstiger betalingen (${formatOre(r.amount_ore, r.currency)}) for intensjon ${r.payment_intent_id}`,
        expected: { max_capturable_ore: r.amount_ore }, observed: { captured_ore: r.captured_ore }
      });
    }
  }
  return drafts;
}

export interface DuplicateRow {
  readonly later_id: string;
  readonly earlier_id: string;
  readonly provider: string;
  readonly amount_ore: number;
  readonly currency: string;
}

export function detectDuplicateFindings(rows: readonly DuplicateRow[]): ReconciliationFindingDraft[] {
  return rows.map((r): ReconciliationFindingDraft => ({
    kind: "possible_duplicate_payment", severity: "warning", subject_type: "payment_intent", subject_id: r.later_id, payment_intent_id: r.later_id, discriminator: r.earlier_id,
    summary: `Mulig dobbeltbetaling: ${formatOre(r.amount_ore, r.currency)} via ${r.provider} til samme leverandør er sendt både i ${r.earlier_id} og ${r.later_id} innen 24 timer`,
    expected: { distinct_payments: 1 }, observed: { other_payment_intent_id: r.earlier_id }
  }));
}

export interface WebhookRow {
  readonly provider: "stripe" | "vipps" | "neonomics" | "wallester";
  readonly key: string;
  readonly status: string;
  readonly error_message: string | null;
}

export function detectWebhookFindings(rows: readonly WebhookRow[]): ReconciliationFindingDraft[] {
  return rows.map((r): ReconciliationFindingDraft => {
    const rejected = r.status === "rejected";
    return {
      kind: rejected ? "webhook_rejected" : "webhook_unprocessed", severity: "warning", subject_type: "webhook_event", subject_id: `${r.provider}:${r.key}`.slice(0, 280), payment_intent_id: null,
      summary: rejected
        ? `${r.provider}-hendelse ble avvist som permanent ugyldig (${(r.error_message ?? "ukjent årsak").slice(0, 80)}) - tilstanden hentes inn av oppfriskingen`
        : `${r.provider}-hendelse står som ${r.status} uten å være behandlet - leverandørens retry eller oppfriskingen må dekke den`,
      expected: { status: "processed" }, observed: { status: r.status, reason: r.error_message === null ? null : r.error_message.slice(0, 80) }
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Tjenesten
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Varsler eieren out-of-band (Telegram i produksjon). Feil her gjøres synlig (`summary.notified = false`) - de ruller aldri tilbake funnene. */
export interface FinanceAlertNotifier {
  notify(alert: { tenant_id: string; run_id: string; text: string }): Promise<void>;
}

export interface FinanceReconciliationOptions {
  readonly leaseMs?: number;
  readonly settledUnreconciledDays?: number;
  /** Vindu for dobbeltbetalingssjekken (timer mellom opprettelse av de to intensjonene). */
  readonly duplicateWindowHours?: number;
  /** Hvor mange dager tilbake avviste hendelser rapporteres. */
  readonly webhookLookbackDays?: number;
  /** Minutter en hendelse får stå ubehandlet (`received`/`verified`/`failed_retryable`) før den flagges. */
  readonly webhookStuckMinutes?: number;
}

export interface FinanceReconciliationDeps {
  readonly fiken?: FikenPostingReader;
  readonly notifier?: FinanceAlertNotifier;
  readonly options?: FinanceReconciliationOptions;
}

export type CheckStatus = "ok" | "skipped_no_credentials" | "skipped_not_configured" | "incomplete" | `failed:${string}`;

export interface ReconciliationReport {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly status: "completed";
  readonly checks: Record<string, CheckStatus>;
  readonly findings_open: number;
  readonly findings_new: number;
  readonly findings_reopened: number;
  readonly findings_resolved: number;
  readonly notified: boolean | null;
  readonly new_findings: ReadonlyArray<{ kind: ReconciliationFindingKind; severity: ReconciliationSeverity; summary: string; reopened: boolean }>;
}

export interface ReconciliationStatus {
  readonly generated_at: string;
  readonly last_run: {
    readonly run_id: string; readonly status: string; readonly trigger: string; readonly started_at: string; readonly finished_at: string | null;
    readonly checks: Record<string, string>; readonly summary: Record<string, JsonValue>; readonly error_message: string | null;
  } | null;
  readonly open_counts: { readonly critical: number; readonly warning: number; readonly info: number };
  readonly open_findings: ReadonlyArray<{
    readonly finding_id: string; readonly kind: string; readonly severity: string; readonly subject_type: string; readonly subject_id: string;
    readonly payment_intent_id: string | null; readonly summary: string; readonly expected: JsonValue; readonly observed: JsonValue;
    readonly first_seen_at: string; readonly last_seen_at: string; readonly reopen_count: number;
  }>;
  /** Er det noen kjøring i det hele tatt? `false` => avstemmingen har aldri gått (f.eks. nylig installert). */
  readonly ever_run: boolean;
}

const MAX_OPEN_FINDINGS_IN_STATUS = 100;
const SEVERITY_RANK: Record<ReconciliationSeverity, number> = { critical: 3, warning: 2, info: 1 };

interface LocalReadResult {
  readonly drafts: ReconciliationFindingDraft[];
  readonly fikenIntents: FikenIntentRow[];
}

export class FinanceReconciliationService {
  private readonly options: Required<FinanceReconciliationOptions>;

  constructor(private readonly pool: pg.Pool, private readonly deps: FinanceReconciliationDeps = {}) {
    const o = deps.options ?? {};
    this.options = {
      leaseMs: o.leaseMs ?? SUBMIT_INFLIGHT_LEASE_MS,
      settledUnreconciledDays: o.settledUnreconciledDays ?? 7,
      duplicateWindowHours: o.duplicateWindowHours ?? 24,
      webhookLookbackDays: o.webhookLookbackDays ?? 30,
      webhookStuckMinutes: o.webhookStuckMinutes ?? 120
    };
  }

  /** Les alle lokale kilder i ÉN kort lese-transaksjon (ingen nettverk, ingen lås). */
  private async readLocal(tenantId: string, memorySpace: MemorySpace): Promise<LocalReadResult> {
    const o = this.options;
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const drafts: ReconciliationFindingDraft[] = [];

      const { rows: intentRows } = await client.query(
        `SELECT payment_intent_id, provider, state, amount_ore, currency, provider_ref, provider_reported_amount_ore, provider_reported_currency,
                reconciliation_state, anomaly_flags,
                (EXTRACT(EPOCH FROM (clock_timestamp() - submitted_at)) * 1000)::bigint AS submitted_age_ms,
                (EXTRACT(EPOCH FROM (clock_timestamp() - settled_at)) / 86400.0)::float8 AS settled_age_days
           FROM payment_intents
          WHERE tenant_id = $1 AND memory_space_id = $2
            AND (state IN ('submitted', 'provider_acknowledged', 'settled') OR (state = 'draft' AND anomaly_flags ? 'SUBMIT_OUTCOME_UNKNOWN'))`,
        [tenantId, memorySpace]
      );
      drafts.push(...detectIntentFindings((intentRows as Array<Record<string, unknown>>).map((r): IntentRow => ({
        payment_intent_id: String(r["payment_intent_id"]), provider: String(r["provider"]), state: String(r["state"]),
        amount_ore: asNumber(r["amount_ore"]), currency: String(r["currency"]),
        provider_ref: r["provider_ref"] === null ? null : String(r["provider_ref"]),
        provider_reported_amount_ore: r["provider_reported_amount_ore"] === null ? null : asNumber(r["provider_reported_amount_ore"]),
        provider_reported_currency: r["provider_reported_currency"] === null ? null : String(r["provider_reported_currency"]),
        reconciliation_state: String(r["reconciliation_state"]),
        anomaly_flags: Array.isArray(r["anomaly_flags"]) ? (r["anomaly_flags"] as unknown[]).map(String) : [],
        submitted_age_ms: r["submitted_age_ms"] === null ? null : asNumber(r["submitted_age_ms"]),
        settled_age_days: r["settled_age_days"] === null ? null : asNumber(r["settled_age_days"])
      })), { leaseMs: o.leaseMs, settledUnreconciledDays: o.settledUnreconciledDays }));

      // Refusjoner/capture mot en betaling kan aldri til sammen overstige betalingen (aktive = sendt, bekreftet eller oppgjort).
      const { rows: sumRows } = await client.query(
        `SELECT p.payment_intent_id, p.amount_ore, p.currency,
                (COALESCE((SELECT SUM(r.amount_ore) FROM stripe_refunds r WHERE r.tenant_id = p.tenant_id AND r.payment_intent_id = p.payment_intent_id AND r.state IN ('submitted', 'provider_acknowledged', 'settled')), 0)
               + COALESCE((SELECT SUM(r.amount_ore) FROM vipps_refunds r WHERE r.tenant_id = p.tenant_id AND r.payment_intent_id = p.payment_intent_id AND r.state IN ('submitted', 'provider_acknowledged', 'settled')), 0))::bigint AS refunded_ore,
                COALESCE((SELECT SUM(c.amount_ore) FROM vipps_captures c WHERE c.tenant_id = p.tenant_id AND c.payment_intent_id = p.payment_intent_id AND c.state IN ('submitted', 'provider_acknowledged', 'settled')), 0)::bigint AS captured_ore
           FROM payment_intents p
          WHERE p.tenant_id = $1 AND p.memory_space_id = $2 AND p.state IN ('provider_acknowledged', 'settled')`,
        [tenantId, memorySpace]
      );
      drafts.push(...detectOverSumFindings((sumRows as Array<Record<string, unknown>>).map((r): OverSumRow => ({
        payment_intent_id: String(r["payment_intent_id"]), amount_ore: asNumber(r["amount_ore"]), currency: String(r["currency"]),
        refunded_ore: asNumber(r["refunded_ore"]), captured_ore: asNumber(r["captured_ore"])
      }))));

      // Mulig dobbeltbetaling: to intensjoner mot samme leverandørtype/leverandør/beløp/valuta, begge sendt, opprettet innen vinduet.
      const { rows: dupRows } = await client.query(
        `SELECT a.payment_intent_id AS later_id, b.payment_intent_id AS earlier_id, a.provider, a.amount_ore, a.currency
           FROM payment_intents a
           JOIN payment_intents b
             ON b.tenant_id = a.tenant_id AND b.memory_space_id = a.memory_space_id AND b.provider = a.provider
            AND b.amount_ore = a.amount_ore AND b.currency = a.currency
            AND lower(btrim(b.vendor_name)) = lower(btrim(a.vendor_name))
            AND (a.created_at, a.payment_intent_id) > (b.created_at, b.payment_intent_id)
            AND a.created_at - b.created_at < make_interval(hours => $3::int)
          WHERE a.tenant_id = $1 AND a.memory_space_id = $2
            AND a.state IN ('submitted', 'provider_acknowledged', 'settled') AND b.state IN ('submitted', 'provider_acknowledged', 'settled')
            AND a.created_at > now() - interval '30 days'
          ORDER BY a.created_at DESC LIMIT 200`,
        [tenantId, memorySpace, o.duplicateWindowHours]
      );
      drafts.push(...detectDuplicateFindings((dupRows as Array<Record<string, unknown>>).map((r): DuplicateRow => ({
        later_id: String(r["later_id"]), earlier_id: String(r["earlier_id"]), provider: String(r["provider"]), amount_ore: asNumber(r["amount_ore"]), currency: String(r["currency"])
      }))));

      // Avviste og hengende leverandørhendelser (alle fire leverandører).
      const webhookRows: WebhookRow[] = [];
      const webhookSources: Array<{ provider: WebhookRow["provider"]; table: string; key: string; at: string }> = [
        { provider: "stripe", table: "stripe_webhook_events", key: "stripe_event_id", at: "received_at" },
        { provider: "vipps", table: "vipps_webhook_events", key: "dedupe_key", at: "received_at" },
        { provider: "neonomics", table: "neonomics_webhook_events", key: "dedupe_key", at: "received_at" },
        { provider: "wallester", table: "wallester_webhook_events", key: "dedupe_key", at: "received_at" }
      ];
      for (const s of webhookSources) {
        const { rows } = await client.query(
          `SELECT ${s.key} AS key, status, error_message FROM ${s.table}
            WHERE tenant_id = $1 AND memory_space_id = $2 AND (
                  (status = 'rejected' AND ${s.at} > now() - make_interval(days => $3::int))
               OR (status IN ('received', 'verified', 'failed_retryable') AND COALESCE(processed_at, ${s.at}) < now() - make_interval(mins => $4::int)))
            ORDER BY ${s.at} DESC LIMIT 200`,
          [tenantId, memorySpace, o.webhookLookbackDays, o.webhookStuckMinutes]
        );
        for (const r of rows as Array<{ key: string; status: string; error_message: string | null }>) webhookRows.push({ provider: s.provider, key: r.key, status: r.status, error_message: r.error_message });
      }
      drafts.push(...detectWebhookFindings(webhookRows));

      const { rows: fikenRows } = await client.query(
        `SELECT payment_intent_id, state, provider_ref, amount_ore, currency FROM payment_intents
          WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'fiken' ORDER BY created_at DESC LIMIT 2000`,
        [tenantId, memorySpace]
      );
      const fikenIntents = (fikenRows as Array<Record<string, unknown>>).map((r): FikenIntentRow => ({
        payment_intent_id: String(r["payment_intent_id"]), state: String(r["state"]), provider_ref: r["provider_ref"] === null ? null : String(r["provider_ref"]),
        amount_ore: asNumber(r["amount_ore"]), currency: String(r["currency"])
      }));
      return { drafts, fikenIntents };
    });
  }

  /**
   * Kjører avstemmingen for én tenant. Idempotent og samtidighetstrygg (rådgivende lås per tenant i skrivefasen). Registrerer funn, setter/fjerner `RECONCILE_*`-flagg på
   * intensjoner, lukker funn som ikke lenger gjelder (kun innenfor sjekkene som faktisk kjørte) og varsler eieren om NYE/gjenåpnede funn.
   */
  async reconcileFinance(tenantId: string, memorySpace: MemorySpace = "business", trigger: "sweep" | "manual" = "sweep"): Promise<ReconciliationReport> {
    const runId = `fin-rec-${randomUUID()}`;
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // En kjøring som døde midt i (prosessen drept) står igjen som `running` - merk eldre enn en time som forlatt, slik at rapporten aldri viser en evig «pågående» kjøring.
      await client.query(
        `UPDATE finance_reconciliation_runs SET status = 'failed', finished_at = now(), error_message = 'abandoned'
          WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'running' AND started_at < now() - interval '1 hour'`, [tenantId, memorySpace]
      );
      await client.query(`INSERT INTO finance_reconciliation_runs (run_id, tenant_id, memory_space_id, trigger) VALUES ($1, $2, $3, $4)`, [runId, tenantId, memorySpace, trigger]);
    });
    try {
      const local = await this.readLocal(tenantId, memorySpace);
      const checks: Record<string, CheckStatus> = { local: "ok" };
      const drafts = [...local.drafts];
      const covered = new Set<ReconciliationFindingKind>(LOCAL_FINDING_KINDS);

      // Fiken: leverandørlesing UTENFOR enhver DB-transaksjon (JARVIS-019).
      if (!this.deps.fiken) {
        checks["fiken"] = "skipped_not_configured";
      } else {
        try {
          const listing = await this.deps.fiken.listPostings(tenantId);
          if (listing === null) {
            checks["fiken"] = "skipped_no_credentials";
          } else {
            drafts.push(...compareWithFiken(local.fikenIntents, listing));
            checks["fiken"] = listing.complete ? "ok" : "incomplete";
            // Et funn lukkes kun når sjekken som fant det beviselig har sett alt: en ufullstendig liste lukker aldri et Fiken-funn.
            if (listing.complete) for (const k of FIKEN_FINDING_KINDS) covered.add(k);
          }
        } catch (err) {
          checks["fiken"] = `failed:${errorCode(err)}`;
        }
      }
      return await this.persist(tenantId, memorySpace, runId, drafts, covered, checks);
    } catch (err) {
      await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
        client.query(`UPDATE finance_reconciliation_runs SET status = 'failed', finished_at = now(), error_message = $3 WHERE run_id = $1 AND tenant_id = $2`, [runId, tenantId, errorCode(err)])
      ).catch(() => undefined);
      throw err;
    }
  }

  private async persist(
    tenantId: string, memorySpace: MemorySpace, runId: string, drafts: readonly ReconciliationFindingDraft[],
    covered: ReadonlySet<ReconciliationFindingKind>, checks: Record<string, CheckStatus>
  ): Promise<ReconciliationReport> {
    // Samme nøkkel kan komme fra flere detektorer (f.eks. samme bilag i to funn) - siste vinner, deterministisk rekkefølge.
    const byKey = new Map<string, ReconciliationFindingDraft>();
    for (const d of drafts) byKey.set(findingKey(d), d);

    const result = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // Én kjøring om gangen per tenant (sveip + manuell kjøring kan overlappe).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`finance-reconcile:${tenantId}`]);
      const keys = [...byKey.keys()];
      const existing = keys.length === 0 ? [] : (await client.query(
        `SELECT finding_key, status FROM finance_reconciliation_findings WHERE tenant_id = $1 AND finding_key = ANY($2::text[])`, [tenantId, keys]
      )).rows as Array<{ finding_key: string; status: string }>;
      const priorStatus = new Map(existing.map((r) => [r.finding_key, r.status]));

      const fresh: Array<{ draft: ReconciliationFindingDraft; reopened: boolean }> = [];
      for (const [key, d] of byKey) {
        const prior = priorStatus.get(key);
        await client.query(
          `INSERT INTO finance_reconciliation_findings
             (finding_id, tenant_id, memory_space_id, finding_key, kind, severity, subject_type, subject_id, payment_intent_id, summary, expected, observed, first_seen_run_id, last_seen_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $13)
           ON CONFLICT (tenant_id, finding_key) DO UPDATE SET
             severity = EXCLUDED.severity, summary = EXCLUDED.summary, expected = EXCLUDED.expected, observed = EXCLUDED.observed,
             payment_intent_id = EXCLUDED.payment_intent_id, last_seen_run_id = EXCLUDED.last_seen_run_id, last_seen_at = now(),
             status = 'open', resolved_at = NULL,
             reopen_count = finance_reconciliation_findings.reopen_count + CASE WHEN finance_reconciliation_findings.status = 'resolved' THEN 1 ELSE 0 END`,
          [`fin-fnd-${randomUUID()}`, tenantId, memorySpace, key, d.kind, d.severity, d.subject_type, d.subject_id, d.payment_intent_id, d.summary.slice(0, 500),
            JSON.stringify(d.expected), JSON.stringify(d.observed), runId]
        );
        if (prior === undefined) fresh.push({ draft: d, reopened: false });
        else if (prior === "resolved") fresh.push({ draft: d, reopened: true });
      }

      // Lukk funn innenfor sjekkene som faktisk kjørte og som ikke lenger gjelder.
      const resolved = await client.query(
        `UPDATE finance_reconciliation_findings SET status = 'resolved', resolved_at = now()
          WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'open' AND kind = ANY($3::text[]) AND finding_key <> ALL($4::text[])`,
        [tenantId, memorySpace, [...covered], keys]
      );

      await this.syncIntentFlags(client, tenantId, memorySpace);

      const counts = (await client.query(
        `SELECT count(*)::int AS n FROM finance_reconciliation_findings WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'open'`, [tenantId, memorySpace]
      )).rows[0] as { n: number };
      const summary = {
        findings_open: counts.n, findings_new: fresh.filter((f) => !f.reopened).length, findings_reopened: fresh.filter((f) => f.reopened).length,
        findings_resolved: resolved.rowCount ?? 0
      };
      await client.query(
        `UPDATE finance_reconciliation_runs SET status = 'completed', finished_at = now(), checks = $3::jsonb, summary = $4::jsonb WHERE run_id = $1 AND tenant_id = $2`,
        [runId, tenantId, JSON.stringify(checks), JSON.stringify(summary)]
      );
      return { fresh, summary };
    });

    // Varsling UTENFOR transaksjonen. Kun nye/gjenåpnede funn (warning/critical) varsles - samme funn varsles ikke hver natt.
    const alertable = result.fresh.filter((f) => f.draft.severity !== "info");
    let notified: boolean | null = null;
    if (alertable.length > 0 && this.deps.notifier) {
      try {
        await this.deps.notifier.notify({ tenant_id: tenantId, run_id: runId, text: renderAlert(tenantId, alertable) });
        notified = true;
      } catch (err) {
        notified = false;
        console.error(JSON.stringify({ msg: "finance_reconcile_notify_failed", tenant_id: tenantId, run_id: runId, error: errorCode(err) }));
      }
      await withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
        client.query(`UPDATE finance_reconciliation_runs SET summary = summary || $3::jsonb WHERE run_id = $1 AND tenant_id = $2`, [runId, tenantId, JSON.stringify({ notified })])
      ).catch(() => undefined);
    } else if (alertable.length > 0) {
      notified = false; // funn som skulle vært varslet, men ingen varsler er koblet - synlig i rapporten, ikke stille
    }

    return {
      run_id: runId, tenant_id: tenantId, status: "completed", checks, ...result.summary, notified,
      new_findings: result.fresh.map((f) => ({ kind: f.draft.kind, severity: f.draft.severity, summary: f.draft.summary, reopened: f.reopened }))
    };
  }

  /** Setter `RECONCILE_*`-flagg på intensjoner med åpne funn (warning/critical) og fjerner dem fra intensjoner uten. Rører aldri andre flagg. */
  private async syncIntentFlags(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace): Promise<void> {
    const { rows: open } = await client.query(
      `SELECT payment_intent_id, kind FROM finance_reconciliation_findings
        WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'open' AND payment_intent_id IS NOT NULL AND severity IN ('warning', 'critical')`,
      [tenantId, memorySpace]
    );
    const desired = new Map<string, Set<string>>();
    for (const r of open as Array<{ payment_intent_id: string; kind: ReconciliationFindingKind }>) {
      const set = desired.get(r.payment_intent_id) ?? new Set<string>();
      set.add(reconcileFlagFor(r.kind));
      desired.set(r.payment_intent_id, set);
    }
    const { rows: candidates } = await client.query(
      `SELECT payment_intent_id, anomaly_flags FROM payment_intents
        WHERE tenant_id = $1 AND memory_space_id = $2
          AND (payment_intent_id = ANY($3::text[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(anomaly_flags) AS f(flag) WHERE f.flag LIKE 'RECONCILE\\_%'))`,
      [tenantId, memorySpace, [...desired.keys()]]
    );
    for (const c of candidates as Array<{ payment_intent_id: string; anomaly_flags: unknown }>) {
      const current = Array.isArray(c.anomaly_flags) ? (c.anomaly_flags as unknown[]).map(String) : [];
      const kept = current.filter((f) => !f.startsWith(RECONCILE_FLAG_PREFIX));
      const next = [...new Set([...kept, ...(desired.get(c.payment_intent_id) ?? [])])].sort();
      const same = next.length === current.length && [...current].sort().every((f, i) => f === next[i]);
      if (same) continue;
      // Review F7: ÉN atomisk setning i stedet for les-modifiser-skriv. Den forrige versjonen skrev hele `anomaly_flags` fra en lesing uten radlås, så et flagg som et samtidig kall la til
      // (f.eks. SUBMIT_OUTCOME_UNKNOWN, WEBHOOK_STATE_CONFLICT) mellom lesingen og skrivingen gikk tapt. Her utledes den nye listen av radens SISTE committede flagg inne i selve UPDATE-en
      // (under radlåsen, korrelert mot `payment_intents.anomaly_flags` slik at READ COMMITTED re-evaluerer mot den nyeste versjonen): alle ikke-RECONCILE-flagg beholdes, RECONCILE-flaggene settes til
      // det avstemmingen vil ha. `COLLATE "C"` gir samme (kodepunkt-)rekkefølge som JS-sorteringen over.
      await client.query(
        `UPDATE payment_intents SET anomaly_flags = (
             SELECT COALESCE(jsonb_agg(merged.flag ORDER BY merged.flag COLLATE "C"), '[]'::jsonb) FROM (
               SELECT v.flag FROM jsonb_array_elements_text(payment_intents.anomaly_flags) AS v(flag) WHERE v.flag NOT LIKE 'RECONCILE\\_%'
               UNION
               SELECT w.flag FROM unnest($3::text[]) AS w(flag)
             ) merged
           ), updated_at = now()
         WHERE tenant_id = $1 AND payment_intent_id = $2`,
        [tenantId, c.payment_intent_id, [...(desired.get(c.payment_intent_id) ?? [])]]
      );
    }
  }

  /** Klasse A-rapporten: siste kjøring, hva som er åpent og hvilke sjekker som faktisk kjørte (dormante sjekker står eksplisitt, aldri som grønne). */
  async getReconciliationStatus(tenantId: string, memorySpace: MemorySpace = "business"): Promise<ReconciliationStatus> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: runRows } = await client.query(
        `SELECT run_id, status, trigger, started_at, finished_at, checks, summary, error_message FROM finance_reconciliation_runs
          WHERE tenant_id = $1 AND memory_space_id = $2 ORDER BY started_at DESC LIMIT 1`, [tenantId, memorySpace]
      );
      const run = runRows[0] as Record<string, unknown> | undefined;
      const { rows: countRows } = await client.query(
        `SELECT severity, count(*)::int AS n FROM finance_reconciliation_findings WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'open' GROUP BY severity`, [tenantId, memorySpace]
      );
      const counts = { critical: 0, warning: 0, info: 0 };
      for (const r of countRows as Array<{ severity: ReconciliationSeverity; n: number }>) counts[r.severity] = r.n;
      const { rows: findingRows } = await client.query(
        `SELECT finding_id, kind, severity, subject_type, subject_id, payment_intent_id, summary, expected, observed, first_seen_at, last_seen_at, reopen_count
           FROM finance_reconciliation_findings WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'open'
          ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC, last_seen_at DESC, finding_id LIMIT ${MAX_OPEN_FINDINGS_IN_STATUS}`,
        [tenantId, memorySpace]
      );
      const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
      return {
        generated_at: new Date().toISOString(),
        ever_run: run !== undefined,
        last_run: run === undefined ? null : {
          run_id: String(run["run_id"]), status: String(run["status"]), trigger: String(run["trigger"]), started_at: iso(run["started_at"]),
          finished_at: run["finished_at"] === null ? null : iso(run["finished_at"]), checks: run["checks"] as Record<string, string>,
          summary: run["summary"] as Record<string, JsonValue>, error_message: run["error_message"] === null ? null : String(run["error_message"])
        },
        open_counts: counts,
        open_findings: (findingRows as Array<Record<string, unknown>>).map((r) => ({
          finding_id: String(r["finding_id"]), kind: String(r["kind"]), severity: String(r["severity"]), subject_type: String(r["subject_type"]), subject_id: String(r["subject_id"]),
          payment_intent_id: r["payment_intent_id"] === null ? null : String(r["payment_intent_id"]), summary: String(r["summary"]),
          expected: r["expected"] as JsonValue, observed: r["observed"] as JsonValue, first_seen_at: iso(r["first_seen_at"]), last_seen_at: iso(r["last_seen_at"]),
          reopen_count: Number(r["reopen_count"])
        }))
      };
    });
  }
}

function errorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80);
}

function renderAlert(tenantId: string, items: ReadonlyArray<{ draft: ReconciliationFindingDraft; reopened: boolean }>): string {
  const sorted = [...items].sort((a, b) => SEVERITY_RANK[b.draft.severity] - SEVERITY_RANK[a.draft.severity]);
  const critical = sorted.filter((i) => i.draft.severity === "critical").length;
  const lines = sorted.slice(0, 10).map((i) => `- [${i.draft.severity === "critical" ? "KRITISK" : "advarsel"}${i.reopened ? ", gjenåpnet" : ""}] ${i.draft.summary}`);
  return [
    `Finansavstemming (${tenantId}): ${items.length} nye/gjenåpnede funn (${critical} kritiske)`,
    ...lines,
    ...(sorted.length > 10 ? [`- ...og ${sorted.length - 10} til`] : []),
    "Ingen automatisk korreksjon er gjort. Se finance.get_reconciliation_status."
  ].join("\n").slice(0, 3800);
}
