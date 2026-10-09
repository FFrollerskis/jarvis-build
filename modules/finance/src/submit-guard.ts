/**
 * WP-F1 (D-462): rene, deterministiske regler for en innsending mot leverandøren som er RESERVERT (`submitted`) uten leverandørsvar.
 *
 * Reserve-then-execute (D-392) committer `draft -> submitted` FØR leverandørkallet. En rad som står igjen som `submitted` uten `provider_ref` betyr
 * derfor enten (a) at et kall pågår akkurat nå, eller (b) at prosessen døde/leverandøren ikke svarte (utfall ukjent). Tre lag hindrer dobbel effekt:
 *   1. In-flight-lease: er reservasjonen yngre enn `leaseMs` regnes kallet som pågående - ALDRI et nytt leverandørkall (`SubmitInFlightError`).
 *   2. Leverandørens Idempotency-Key (Stripe/Vipps): etter at leasen er utløpt kan innsendingen gjenopptas med SAMME nøkkel, men KUN innenfor
 *      leverandørens idempotensvindu målt fra FØRSTE forsøk (`first_submit_attempt_at`) - etter vinduet slår ikke leverandøren lenger sammen kallene.
 *   3. Leverandører uten Idempotency-Key (Fiken/Neonomics) kan aldri gjenopptas automatisk: utløpt lease = `reconcile_required` (eieravstemming).
 * Tid måles av databasen (`clock_timestamp()`), aldri av applikasjonsklokken, slik at flere prosesser er enige.
 */
import type pg from "pg";

/** Hvor lenge en reservasjon regnes som pågående. Over leverandørens HTTP-tak (20 s × maks 3 forsøk + backoff) med god margin. */
export const SUBMIT_INFLIGHT_LEASE_MS = 120_000;

/** Stripe lagrer Idempotency-Key i 24 timer; Vipps' vindu er ikke verifisert - begge behandles konservativt med 23 t. */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

export interface SubmitTiming {
  readonly leaseMs: number;
  readonly idempotencyWindowMs: number;
}

export const DEFAULT_SUBMIT_TIMING: SubmitTiming = { leaseMs: SUBMIT_INFLIGHT_LEASE_MS, idempotencyWindowMs: PROVIDER_IDEMPOTENCY_WINDOW_MS };

export type ReservedSubmitVerdict = "resume" | "in_flight" | "reconcile_required";

export interface SubmitAges {
  /** Alder på reservasjonen (`submitted_at`); `null` = ukjent (eldre rad uten tidsstempel) og regnes som utløpt lease. */
  readonly submittedAgeMs: number | null;
  /** Alder på FØRSTE forsøk mot leverandøren; `null` = ikke registrert (eldre rad). */
  readonly firstAttemptAgeMs: number | null;
}

/** Hva skal skje med en rad som står som `submitted` uten leverandørsvar? */
export function classifyReservedSubmit(ages: SubmitAges, idempotentAtProvider: boolean, timing: SubmitTiming = DEFAULT_SUBMIT_TIMING): ReservedSubmitVerdict {
  if (ages.submittedAgeMs !== null && ages.submittedAgeMs < timing.leaseMs) return "in_flight";
  if (!idempotentAtProvider) return "reconcile_required";
  if (ages.firstAttemptAgeMs !== null && ages.firstAttemptAgeMs >= timing.idempotencyWindowMs) return "reconcile_required";
  return "resume";
}

/**
 * Hva skal skje med en NY innsending (rad i `draft`) som tidligere har vært forsøkt? Et forsøk som endte i ukjent utfall rulles tilbake til `draft`
 * for Stripe/Vipps, men beholder `first_submit_attempt_at` - utenfor idempotensvinduet kan et nytt forsøk opprette et NYTT objekt hos leverandøren.
 */
export function classifyFreshSubmit(ages: Pick<SubmitAges, "firstAttemptAgeMs">, idempotentAtProvider: boolean, timing: SubmitTiming = DEFAULT_SUBMIT_TIMING): "ok" | "reconcile_required" {
  if (ages.firstAttemptAgeMs === null || !idempotentAtProvider) return "ok";
  return ages.firstAttemptAgeMs >= timing.idempotencyWindowMs ? "reconcile_required" : "ok";
}

export type ProviderFailureClass = "not_executed" | "unknown";

/** HTTP-status fra en leverandørfeil: `httpStatus`/`status`-felt (alle ekte transporter) - ellers `null`. */
function httpStatusOf(err: unknown): number | null {
  const e = err as { httpStatus?: unknown; status?: unknown } | null;
  const status = e?.httpStatus ?? e?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Feil som er kastet FØR noe ble sendt til leverandøren (vår egen validering/credential-sjekk) - leverandøren kan umulig ha utført noe. */
const PRE_SEND_ERROR = /^(invalid_amount_ore|neonomics_invalid_minor_units|neonomics_unparseable_amount|fiken_oauth_client_not_configured|[a-z_]+_credentials_unavailable)/;

/** Nettverksfeil der forbindelsen aldri ble opprettet - ingenting nådde leverandøren. */
const CONNECT_FAILED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);

function errorCodeOf(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Klassifiserer en feil fra selve leverandørkallet. `not_executed` = leverandøren har entydig ikke utført noe (4xx unntatt 408/409, 429, eller en feil
 * kastet før noe ble sendt). ALT annet - tidsavbrudd, avbrutt forbindelse, 5xx, 408, 409 (Stripe: `idempotency_key_in_use` = et tidligere kall pågår) og
 * uklassifiserbare feil - er `unknown`: for penger er en synlig «utfall ukjent» alltid bedre enn å anta at ingenting skjedde.
 */
export function classifyProviderFailure(err: unknown): ProviderFailureClass {
  const status = httpStatusOf(err);
  if (status !== null) {
    if (status === 429) return "not_executed"; // avslått FØR behandling
    if (status >= 400 && status < 500 && status !== 408 && status !== 409) return "not_executed";
    return "unknown";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (PRE_SEND_ERROR.test(message)) return "not_executed";
  const code = errorCodeOf(err);
  if (code !== null && CONNECT_FAILED_CODES.has(code)) return "not_executed";
  return "unknown";
}

/** Tabellene som har en reservasjonsfase (`submitted` før leverandørkallet) - hvitliste, aldri en streng fra utsiden i SQL. */
export type SubmitTable = "payment_intents" | "stripe_refunds" | "vipps_captures" | "vipps_refunds";
export const SUBMIT_TABLE_KEYS: Readonly<Record<SubmitTable, string>> = {
  payment_intents: "payment_intent_id", stripe_refunds: "refund_id", vipps_captures: "capture_id", vipps_refunds: "refund_id"
};

/** Alder på reservasjonen og på FØRSTE forsøk, målt av databasen (`clock_timestamp()`, ikke transaksjonsstart) - se `submit-guard.ts`. */
export async function readSubmitAges(client: pg.PoolClient, table: SubmitTable, tenantId: string, id: string): Promise<SubmitAges> {
  const { rows } = await client.query(
    `SELECT (EXTRACT(EPOCH FROM (clock_timestamp() - submitted_at)) * 1000)::bigint AS submitted_age_ms,
            (EXTRACT(EPOCH FROM (clock_timestamp() - first_submit_attempt_at)) * 1000)::bigint AS first_attempt_age_ms
       FROM ${table} WHERE tenant_id = $1 AND ${SUBMIT_TABLE_KEYS[table]} = $2`,
    [tenantId, id]
  );
  const row = rows[0] as { submitted_age_ms: string | null; first_attempt_age_ms: string | null } | undefined;
  return {
    submittedAgeMs: row?.submitted_age_ms == null ? null : Number(row.submitted_age_ms),
    firstAttemptAgeMs: row?.first_attempt_age_ms == null ? null : Number(row.first_attempt_age_ms)
  };
}

