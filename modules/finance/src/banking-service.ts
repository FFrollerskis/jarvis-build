import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { NeonomicsConsentRequiredError, type NeonomicsGateway } from "./neonomics-transport.ts";
import {
  BankAccountNotFoundError,
  BankCallbackStateMismatchError,
  BankConsentNotActiveError,
  BankConsentNotFoundError,
  NeonomicsCredentialsUnavailableError,
  type BankAccount,
  type BankAccountBalance,
  type BankAnomalyDetectionResult,
  type BankAnomalyType,
  type BankConsent,
  type BankConsentScope,
  type BankTransaction
} from "./banking-types.ts";
import type { NeonomicsCredentialsProvider, NeonomicsGatewayFactory } from "./service.ts";
import { defaultNeonomicsGatewayFactory } from "./service.ts";

/**
 * UA-6 Slice 5 (D-111): kanonisk open-banking-domenetjeneste (AIS-siden:
 * samtykke/kontoer/saldo/transaksjoner/avstemming/bank-avvik). Egen klasse
 * ved siden av FinanceService/SpendService (SAMME oppdelingspresedens som
 * Slice 2 - bankdata er et eget deldomene, IKKE nok en betalingsleverandør-
 * gren) - PIS-betalingssiden bor i FinanceService (provider-dispatchet
 * `submitPaymentIntent`, aldri to konkurrerende handlinger).
 *
 * Deterministiske avstemmingsregler (byggeordrens §10) - ALDRI AI-inferert
 * (Q-26): se `reconcileBankTransactions()`. Tvetydige kandidater forblir
 * `ambiguous` - aldri stille auto-lukket.
 */

/** Deterministiske konstanter for avviks-/avstemmingsreglene - dokumentert, aldri skjult-tilfeldige. */
export const RECONCILE_DATE_WINDOW_DAYS = 3;
export const UNMATCHED_FLAG_AGE_DAYS = 3;
export const LARGE_DEBIT_THRESHOLD_ORE = 1_000_000; // 10 000 kr - eier-synlig terskel for UNEXPECTED_LARGE_DEBIT.

export class BankingService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly credentialsProvider: NeonomicsCredentialsProvider = { getCredentials: async () => null },
    private readonly gatewayFactory: NeonomicsGatewayFactory = defaultNeonomicsGatewayFactory
  ) {}

  private async gateway(tenantId: string): Promise<NeonomicsGateway> {
    const credentials = await this.credentialsProvider.getCredentials(tenantId);
    if (!credentials) throw new NeonomicsCredentialsUnavailableError(tenantId);
    return this.gatewayFactory(credentials);
  }

  // === Institusjoner ======================================================

  async listBanks(tenantId: string): Promise<Array<{ id: string; bankDisplayName: string | null; countryCode: string | null }>> {
    const gw = await this.gateway(tenantId);
    return gw.listBanks();
  }

  // === Samtykke-livssyklus (byggeordrens §5) ==============================

  /** Oppretter sesjon hos Neonomics (samtykke-bæreren) + kanonisk consent-rad i `created`-tilstand. Idempotens: én rad per (tenant, provider_session_id) - hver createConsent gir bevisst en NY sesjon (Neonomics-modellen er sesjon-per-samtykkeforsøk). */
  async createConsent(tenantId: string, memorySpace: MemorySpace, input: { bank_id: string; bank_name?: string; requested_scope?: BankConsentScope; owner_person_id?: string }): Promise<BankConsent> {
    const gw = await this.gateway(tenantId);
    const { sessionId } = await gw.createSession(input.bank_id);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO bank_consents (consent_id, tenant_id, memory_space_id, provider_session_id, bank_id, bank_name, requested_scope, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [`bank-co-${randomUUID()}`, tenantId, memorySpace, sessionId, input.bank_id, input.bank_name ?? null, input.requested_scope ?? "ais_pis", input.owner_person_id ?? null]
      );
      return rows[0] as BankConsent;
    });
  }

  /**
   * Henter autorisasjons-URL-en sluttbrukeren MÅ besøke (SCA hos banken -
   * en MENNESKELIG handling, aldri automatiserbar). Genererer samtidig
   * Jarvis sin egen kryptografisk tilfeldige `callback_state` (CSRF-/
   * replay-vokteren, byggeordrens §22) - den legges på Jarvis sin EGEN
   * redirect-URL, ALDRI en provider-hemmelighet.
   */
  async getConsentAuthorizationUrl(tenantId: string, memorySpace: MemorySpace, consentId: string, redirectBaseUrl: string): Promise<{ url: string; callback_state: string }> {
    const callbackState = randomBytes(24).toString("base64url");
    const consent = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 AND consent_id = $2 FOR UPDATE`, [tenantId, consentId]);
      const current = rows[0] as BankConsent | undefined;
      if (!current) throw new BankConsentNotFoundError(consentId);
      if (!current.provider_session_id) throw new BankConsentNotActiveError(consentId, current.state);
      return current;
    });
    const gw = await this.gateway(tenantId);
    const redirectUrl = `${redirectBaseUrl}?consent_id=${encodeURIComponent(consentId)}&state=${encodeURIComponent(callbackState)}`;
    const { url } = await gw.getConsentUrl(consent.provider_session_id!, redirectUrl);
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      await client.query(
        `UPDATE bank_consents SET state = 'authorization_required', authorization_url = $3, callback_state = $4, updated_at = now()
         WHERE tenant_id = $1 AND consent_id = $2`,
        [tenantId, consentId, url, callbackState]
      );
    });
    return { url, callback_state: callbackState };
  }

  /**
   * Callback-fullføring (byggeordrens §22): konstant-tid state-verifisering,
   * fail-closed på avvik/replay (state NULL-stilles ved suksess - en
   * GJENTATT callback med samme state avvises som replay), stale callback
   * mot et allerede tilbakekalt/utløpt samtykke avvises.
   */
  async completeConsentCallback(tenantId: string, memorySpace: MemorySpace, consentId: string, providedState: string): Promise<BankConsent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 AND consent_id = $2 FOR UPDATE`, [tenantId, consentId]);
      const current = rows[0] as BankConsent | undefined;
      if (!current) throw new BankConsentNotFoundError(consentId);
      if (current.state !== "authorization_required" || !current.callback_state) {
        // Stale/replayet callback (state allerede konsumert) ELLER callback mot revoked/expired - fail-closed.
        throw new BankCallbackStateMismatchError(consentId);
      }
      const expected = Buffer.from(current.callback_state, "utf8");
      const provided = Buffer.from(providedState, "utf8");
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new BankCallbackStateMismatchError(consentId);
      }
      const updated = await client.query(
        `UPDATE bank_consents SET state = 'active', authorized_at = now(), callback_state = NULL, last_verified_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND consent_id = $2 RETURNING *`,
        [tenantId, consentId]
      );
      return updated.rows[0] as BankConsent;
    });
  }

  /** Eksplisitt tilstandsovergang (revoke/expire/reject) - operasjonell tilstand, aldri en skjult feil. */
  async markConsentState(tenantId: string, memorySpace: MemorySpace, consentId: string, state: "expired" | "revoked" | "rejected"): Promise<BankConsent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE bank_consents SET state = $3, ${state === "revoked" ? "revoked_at = now()," : ""} updated_at = now()
         WHERE tenant_id = $1 AND consent_id = $2 RETURNING *`,
        [tenantId, consentId, state]
      );
      const updated = rows[0] as BankConsent | undefined;
      if (!updated) throw new BankConsentNotFoundError(consentId);
      return updated;
    });
  }

  async getConsent(tenantId: string, memorySpace: MemorySpace, consentId: string): Promise<BankConsent | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 AND consent_id = $2`, [tenantId, consentId]);
      return (rows[0] as BankConsent | undefined) ?? null;
    });
  }

  async listConsents(tenantId: string, memorySpace: MemorySpace, limit = 50): Promise<BankConsent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(limit, 200)]);
      return rows as BankConsent[];
    });
  }

  /**
   * Samtykke-verifisering (byggeordrens §17 «consent status verification»):
   * en billig provider-probe (kontolisting). 1426 «consent required» mot et
   * 'active' samtykke betyr at banktilgangen REELT er tapt (utløpt hos
   * banken) - tilstanden settes 'expired' (operasjonell tilstand som
   * overflates via bank_consent_attention-OpenLoop-regelen), aldri en
   * skjult feil.
   */
  async verifyConsent(tenantId: string, memorySpace: MemorySpace, consentId: string): Promise<BankConsent> {
    const consent = await this.getConsent(tenantId, memorySpace, consentId);
    if (!consent) throw new BankConsentNotFoundError(consentId);
    if (consent.state !== "active" || !consent.provider_session_id) return consent;
    const gw = await this.gateway(tenantId);
    try {
      await gw.listAccounts(consent.provider_session_id);
      return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        const { rows } = await client.query(
          `UPDATE bank_consents SET last_verified_at = now(), updated_at = now() WHERE tenant_id = $1 AND consent_id = $2 RETURNING *`,
          [tenantId, consentId]
        );
        return rows[0] as BankConsent;
      });
    } catch (err) {
      if (err instanceof NeonomicsConsentRequiredError) {
        return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
          const { rows } = await client.query(
            `UPDATE bank_consents SET state = 'expired', updated_at = now() WHERE tenant_id = $1 AND consent_id = $2 RETURNING *`,
            [tenantId, consentId]
          );
          return rows[0] as BankConsent;
        });
      }
      throw err;
    }
  }

  private async requireActiveConsent(client: pg.PoolClient, tenantId: string, consentId: string): Promise<BankConsent> {
    const { rows } = await client.query(`SELECT * FROM bank_consents WHERE tenant_id = $1 AND consent_id = $2`, [tenantId, consentId]);
    const consent = rows[0] as BankConsent | undefined;
    if (!consent) throw new BankConsentNotFoundError(consentId);
    if (consent.state !== "active" || !consent.provider_session_id) throw new BankConsentNotActiveError(consentId, consent.state);
    return consent;
  }

  // === Kontodiscovery/-synk (byggeordrens §6) =============================

  /**
   * autorisert samtykke -> provider-kontodiscovery -> kanoniske Jarvis-
   * bankkontoer. Idempotent (ON CONFLICT på (tenant, provider,
   * provider_account_id) oppdaterer metadata - dupliserer ALDRI), ikke-
   * destruktiv (kontoer som forsvant hos provider settes inactive, aldri
   * slettet - historisk finansiell linkage bevares). 1426 underveis ->
   * samtykket markeres 'expired' og BankConsentNotActiveError kastes
   * (autorisasjonsfeil MAPPER til samtykketilstand, byggeordrens §6).
   */
  async syncAccounts(tenantId: string, memorySpace: MemorySpace, consentId: string): Promise<{ discovered: number; updated: number; deactivated: number }> {
    const consent = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.requireActiveConsent(client, tenantId, consentId));
    const gw = await this.gateway(tenantId);
    let providerAccounts;
    try {
      providerAccounts = await gw.listAccounts(consent.provider_session_id!);
    } catch (err) {
      if (err instanceof NeonomicsConsentRequiredError) {
        await this.markConsentState(tenantId, memorySpace, consentId, "expired");
        throw new BankConsentNotActiveError(consentId, "expired");
      }
      throw err;
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let discovered = 0;
      let updated = 0;
      const seenProviderIds: string[] = [];
      for (const account of providerAccounts) {
        seenProviderIds.push(account.id);
        const masked = account.accountNumber ? `…${account.accountNumber.slice(-4)} (${account.accountNumber.length})` : null;
        const { rows } = await client.query(
          `INSERT INTO bank_accounts (bank_account_id, tenant_id, memory_space_id, provider_account_id, consent_id, bank_id, account_name, account_identifier_masked, currency, account_type, active, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, now())
           ON CONFLICT (tenant_id, provider, provider_account_id) DO UPDATE SET
             account_name = EXCLUDED.account_name, account_identifier_masked = EXCLUDED.account_identifier_masked,
             currency = EXCLUDED.currency, account_type = EXCLUDED.account_type, active = true,
             consent_id = EXCLUDED.consent_id, last_synced_at = now(), updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [`bank-ac-${randomUUID()}`, tenantId, memorySpace, account.id, consentId, consent.bank_id, account.accountName, masked, account.currency ?? "NOK", account.accountType]
        );
        if ((rows[0] as { inserted: boolean }).inserted) discovered++; else updated++;
      }
      // Ikke-destruktiv inaktivering av kontoer under DETTE samtykket som
      // provider ikke lenger rapporterer.
      const { rowCount } = await client.query(
        `UPDATE bank_accounts SET active = false, updated_at = now()
         WHERE tenant_id = $1 AND consent_id = $2 AND active = true AND NOT (provider_account_id = ANY($3))`,
        [tenantId, consentId, seenProviderIds]
      );
      return { discovered, updated, deactivated: rowCount ?? 0 };
    });
  }

  async listBankAccounts(tenantId: string, memorySpace: MemorySpace, includeInactive = false, limit = 100): Promise<BankAccount[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = includeInactive
        ? await client.query(`SELECT * FROM bank_accounts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(limit, 500)])
        : await client.query(`SELECT * FROM bank_accounts WHERE tenant_id = $1 AND active = true ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(limit, 500)]);
      return rows as BankAccount[];
    });
  }

  // === Saldo-synk (byggeordrens §7) =======================================

  /** Append-only saldo-observasjoner - provider-typene (booked/available/...) bevares rått, aldri kollapset; beløp i øre (eksakt konvertering i transporten). */
  async syncBalances(tenantId: string, memorySpace: MemorySpace, bankAccountId: string): Promise<{ observed: number }> {
    const { account, consent } = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_accounts WHERE tenant_id = $1 AND bank_account_id = $2`, [tenantId, bankAccountId]);
      const acc = rows[0] as BankAccount | undefined;
      if (!acc) throw new BankAccountNotFoundError(bankAccountId);
      const cons = await this.requireActiveConsent(client, tenantId, acc.consent_id);
      return { account: acc, consent: cons };
    });
    const gw = await this.gateway(tenantId);
    const balances = await gw.getBalances(consent.provider_session_id!, account.provider_account_id);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      for (const balance of balances) {
        await client.query(
          `INSERT INTO bank_account_balances (balance_id, tenant_id, memory_space_id, bank_account_id, balance_type, amount_ore, currency, provider_reference_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [`bank-bl-${randomUUID()}`, tenantId, memorySpace, bankAccountId, balance.type, balance.amountOre, balance.currency, balance.referenceDate ? new Date(balance.referenceDate).toISOString() : null]
        );
      }
      return { observed: balances.length };
    });
  }

  async listBalances(tenantId: string, memorySpace: MemorySpace, bankAccountId: string, limit = 20): Promise<BankAccountBalance[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM bank_account_balances WHERE tenant_id = $1 AND bank_account_id = $2 ORDER BY observed_at DESC LIMIT $3`,
        [tenantId, bankAccountId, Math.min(limit, 200)]
      );
      return rows as BankAccountBalance[];
    });
  }

  // === Transaksjonssynk (byggeordrens §8) =================================

  /**
   * Deterministisk, idempotent, paginert transaksjonsinnhenting.
   * - Duplikat-undertrykkelse: UNIQUE (tenant, provider,
   *   provider_transaction_id) + ON CONFLICT-vei.
   * - pending->booked: tilstandsovergang på SAMME rad (stabil provider-ID).
   * - Provider-KORREKSJON av en allerede booket transaksjon (endret beløp/
   *   valuta/retning): flagges BANK_TRANSACTION_CORRECTION_CONFLICT -
   *   etablert beløp overskrives ALDRI stille (booking-/valuteringsdato og
   *   metadata KAN oppdateres trygt).
   * - Sen ankomst/backfill: samme idempotente vei - rekkefølge spiller
   *   ingen rolle.
   */
  async syncTransactions(tenantId: string, memorySpace: MemorySpace, bankAccountId: string, opts: { maxPages?: number } = {}): Promise<{ inserted: number; transitioned: number; corrections_flagged: number; pages: number }> {
    const { account, consent } = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM bank_accounts WHERE tenant_id = $1 AND bank_account_id = $2`, [tenantId, bankAccountId]);
      const acc = rows[0] as BankAccount | undefined;
      if (!acc) throw new BankAccountNotFoundError(bankAccountId);
      const cons = await this.requireActiveConsent(client, tenantId, acc.consent_id);
      return { account: acc, consent: cons };
    });
    const gw = await this.gateway(tenantId);
    const maxPages = Math.min(opts.maxPages ?? 10, 50);
    let inserted = 0;
    let transitioned = 0;
    let correctionsFlagged = 0;
    let pages = 0;
    let pageToken: string | null = null;
    do {
      const page = await gw.listTransactions(consent.provider_session_id!, account.provider_account_id, pageToken);
      pages++;
      await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        for (const tx of page.transactions) {
          const { rows } = await client.query(
            `INSERT INTO bank_transactions
               (bank_transaction_id, tenant_id, memory_space_id, bank_account_id, provider_transaction_id, status, direction,
                amount_ore, currency, booking_date, value_date, counterparty_name, reference_text, bank_transaction_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (tenant_id, provider, provider_transaction_id) DO NOTHING
             RETURNING bank_transaction_id`,
            [`bank-tx-${randomUUID()}`, tenantId, memorySpace, bankAccountId, tx.id, tx.status, tx.direction,
              tx.amountOre, tx.currency, tx.bookingDate, tx.valueDate, tx.counterpartyName, tx.referenceText, tx.bankTransactionCode]
          );
          if (rows.length > 0) {
            inserted++;
            continue;
          }
          const { rows: existingRows } = await client.query(
            `SELECT * FROM bank_transactions WHERE tenant_id = $1 AND provider = 'neonomics' AND provider_transaction_id = $2 FOR UPDATE`,
            [tenantId, tx.id]
          );
          const existing = existingRows[0] as BankTransaction | undefined;
          if (!existing) continue;
          const economicallyChanged = Number(existing.amount_ore) !== tx.amountOre || existing.currency !== tx.currency || existing.direction !== tx.direction;
          if (existing.status === "booked" && economicallyChanged) {
            await this.appendBankAnomalyFlags(client, existing.bank_transaction_id, ["BANK_TRANSACTION_CORRECTION_CONFLICT"]);
            correctionsFlagged++;
            continue;
          }
          if (existing.status === "pending" && tx.status === "booked") {
            await client.query(
              `UPDATE bank_transactions SET status = 'booked', amount_ore = $3, currency = $4, direction = $5,
                 booking_date = COALESCE($6, booking_date), value_date = COALESCE($7, value_date), updated_at = now()
               WHERE tenant_id = $1 AND bank_transaction_id = $2`,
              [tenantId, existing.bank_transaction_id, tx.amountOre, tx.currency, tx.direction, tx.bookingDate, tx.valueDate]
            );
            transitioned++;
          }
        }
      });
      pageToken = page.nextPageToken;
    } while (pageToken !== null && pages < maxPages);
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      await client.query(`UPDATE bank_accounts SET last_synced_at = now(), updated_at = now() WHERE tenant_id = $1 AND bank_account_id = $2`, [tenantId, bankAccountId]);
    });
    return { inserted, transitioned, corrections_flagged: correctionsFlagged, pages };
  }

  async listBankTransactions(tenantId: string, memorySpace: MemorySpace, filter: { bank_account_id?: string; reconciliation_state?: string; limit?: number } = {}): Promise<BankTransaction[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const limit = Math.min(filter.limit ?? 50, 500);
      const conditions: string[] = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (filter.bank_account_id) {
        values.push(filter.bank_account_id);
        conditions.push(`bank_account_id = $${values.length}`);
      }
      if (filter.reconciliation_state) {
        values.push(filter.reconciliation_state);
        conditions.push(`reconciliation_state = $${values.length}`);
      }
      values.push(limit);
      const { rows } = await client.query(
        `SELECT * FROM bank_transactions WHERE ${conditions.join(" AND ")} ORDER BY booking_date DESC NULLS LAST, created_at DESC LIMIT $${values.length}`,
        values
      );
      return rows as BankTransaction[];
    });
  }

  // === Avstemming (byggeordrens §10/§14) ==================================

  /**
   * To deterministiske regler, i prioritert rekkefølge:
   *
   * REGEL 1 `provider_reference` (sterkest bevis): en DEBET-transaksjon
   * hvis `reference_text` inneholder en eksisterende `payment_intent_id`
   * (Neonomics-PIS setter `endToEndReference = payment_intent_id` ved
   * initiering - se FinanceService). Beløp+valuta MÅ også stemme - et
   * referanse-treff med beløpsavvik flagges
   * PAYMENT_BANK_TRANSACTION_MISMATCH (aldri en stille match).
   *
   * REGEL 2 `amount_date_window`: en booket transaksjon som matcher
   * NØYAKTIG ÉN intent med samme beløp+valuta+retningssemantikk
   * (debet<->utgående intent) innen ±RECONCILE_DATE_WINDOW_DAYS av
   * booking-datoen, der intenten ikke allerede er matchet av en annen
   * banktransaksjon. Flere kandidater -> `ambiguous` (uløst, aldri
   * stille valgt).
   *
   * §14-invarianten: provider-initiering og bank-oppgjør er RELATERT BEVIS
   * om ETT økonomisk beløp - en match skaper ALDRI en ny normalisert
   * pengerad, den LENKER den observerte banktransaksjonen til den
   * eksisterende intenten (og setter intentens reconciliation_state
   * 'matched' + en 'reconciled'-hendelse - samme semantikk som
   * FinanceService.reconcilePaymentIntent(matched=true), utført her i
   * SAMME transaksjon som lenkingen).
   */
  async reconcileBankTransactions(tenantId: string, memorySpace: MemorySpace): Promise<{ matched_by_reference: number; matched_by_amount_date: number; mismatch_flagged: number; ambiguous: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let matchedByReference = 0;
      let matchedByAmountDate = 0;
      let mismatchFlagged = 0;
      let ambiguous = 0;

      const { rows: unmatchedRows } = await client.query(
        `SELECT * FROM bank_transactions WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'booked' AND reconciliation_state IN ('unmatched', 'ambiguous') ORDER BY created_at`,
        [tenantId, memorySpace]
      );

      for (const tx of unmatchedRows as BankTransaction[]) {
        // REGEL 1: provider-referanse i reference_text.
        if (tx.reference_text) {
          const refMatch = /fin-pi-[0-9a-f-]{36}/.exec(tx.reference_text);
          if (refMatch) {
            const { rows: intentRows } = await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2 FOR UPDATE`, [tenantId, refMatch[0]]);
            const intent = intentRows[0] as { payment_intent_id: string; amount_ore: string; currency: string } | undefined;
            if (intent) {
              if (Number(intent.amount_ore) === Number(tx.amount_ore) && intent.currency === tx.currency && tx.direction === "debit") {
                await this.linkMatch(client, tenantId, memorySpace, tx, intent.payment_intent_id, "provider_reference", {
                  reference: refMatch[0], amount_ore: Number(tx.amount_ore), currency: tx.currency
                });
                matchedByReference++;
              } else {
                // Referansen peker på intenten, men beløp/valuta/retning
                // avviker - et EKTE avvik, aldri en stille match.
                await this.appendBankAnomalyFlags(client, tx.bank_transaction_id, ["PAYMENT_BANK_TRANSACTION_MISMATCH"]);
                mismatchFlagged++;
              }
              continue;
            }
          }
        }

        // REGEL 2: eksakt-én-kandidat på beløp+valuta+datovindu.
        if (tx.direction === "debit" && tx.booking_date) {
          const { rows: candidates } = await client.query(
            `SELECT pi.payment_intent_id FROM payment_intents pi
             WHERE pi.tenant_id = $1 AND pi.memory_space_id = $2 AND pi.amount_ore = $3 AND pi.currency = $4
               AND pi.state IN ('provider_acknowledged', 'settled')
               AND pi.submitted_at IS NOT NULL
               AND pi.submitted_at BETWEEN $5::date - $6 * interval '1 day' AND $5::date + $6 * interval '1 day'
               AND NOT EXISTS (
                 SELECT 1 FROM bank_transactions bt2 WHERE bt2.tenant_id = $1 AND bt2.matched_payment_intent_id = pi.payment_intent_id
               )`,
            [tenantId, memorySpace, tx.amount_ore, tx.currency, tx.booking_date, RECONCILE_DATE_WINDOW_DAYS]
          );
          if (candidates.length === 1) {
            const intentId = (candidates[0] as { payment_intent_id: string }).payment_intent_id;
            await this.linkMatch(client, tenantId, memorySpace, tx, intentId, "amount_date_window", {
              amount_ore: Number(tx.amount_ore), currency: tx.currency, booking_date: tx.booking_date, window_days: RECONCILE_DATE_WINDOW_DAYS
            });
            matchedByAmountDate++;
            continue;
          }
          if (candidates.length > 1) {
            await client.query(
              `UPDATE bank_transactions SET reconciliation_state = 'ambiguous', match_evidence = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND bank_transaction_id = $2`,
              [tenantId, tx.bank_transaction_id, JSON.stringify({ candidate_count: candidates.length, rule: "amount_date_window" })]
            );
            ambiguous++;
          }
        }
      }
      return { matched_by_reference: matchedByReference, matched_by_amount_date: matchedByAmountDate, mismatch_flagged: mismatchFlagged, ambiguous };
    });
  }

  private async linkMatch(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, tx: BankTransaction, paymentIntentId: string, rule: string, evidence: Record<string, unknown>): Promise<void> {
    await client.query(
      `UPDATE bank_transactions SET reconciliation_state = 'matched', matched_payment_intent_id = $3, match_rule = $4, match_evidence = $5::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND bank_transaction_id = $2`,
      [tenantId, tx.bank_transaction_id, paymentIntentId, rule, JSON.stringify(evidence)]
    );
    await client.query(
      `UPDATE payment_intents SET reconciliation_state = 'matched', updated_at = now() WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenantId, paymentIntentId]
    );
    await client.query(
      `INSERT INTO payment_intent_events (event_id, tenant_id, memory_space_id, payment_intent_id, event_type, summary, metadata)
       VALUES ($1, $2, $3, $4, 'reconciled', $5, $6)`,
      [`fin-ev-${randomUUID()}`, tenantId, memorySpace, paymentIntentId,
        `Avstemt: matched mot banktransaksjon ${tx.bank_transaction_id} (regel ${rule})`,
        JSON.stringify({ matched: true, bank_transaction_id: tx.bank_transaction_id, rule, evidence })]
    );
  }

  // === Bank-avviksdeteksjon (byggeordrens §15) ============================

  /**
   * SAMME full-gjenberegnings-/selv-korrigerende mønster som Stripe-/Vipps-
   * sveipene. Sveipen EIER: UNMATCHED_BANK_DEBIT/UNMATCHED_BANK_CREDIT/
   * UNEXPECTED_LARGE_DEBIT/BANK_DUPLICATE_TRANSACTION. Kilde-satte flagg
   * (BANK_TRANSACTION_CORRECTION_CONFLICT/PAYMENT_BANK_TRANSACTION_MISMATCH)
   * bevares - de settes ved kilden og slettes aldri av sveipen.
   */
  async runBankAnomalyDetection(tenantId: string, memorySpace: MemorySpace): Promise<BankAnomalyDetectionResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const candidateFlags = new Map<string, Set<BankAnomalyType>>();
      const addFlag = (id: string, flag: BankAnomalyType): void => {
        if (!candidateFlags.has(id)) candidateFlags.set(id, new Set());
        candidateFlags.get(id)!.add(flag);
      };

      const unmatchedOld = await client.query(
        `SELECT bank_transaction_id, direction, amount_ore FROM bank_transactions
         WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'booked' AND reconciliation_state IN ('unmatched', 'ambiguous')
           AND created_at < now() - $3 * interval '1 day'`,
        [tenantId, memorySpace, UNMATCHED_FLAG_AGE_DAYS]
      );
      for (const row of unmatchedOld.rows as Array<{ bank_transaction_id: string; direction: string; amount_ore: string }>) {
        addFlag(row.bank_transaction_id, row.direction === "debit" ? "UNMATCHED_BANK_DEBIT" : "UNMATCHED_BANK_CREDIT");
      }

      const largeDebit = await client.query(
        `SELECT bank_transaction_id FROM bank_transactions
         WHERE tenant_id = $1 AND memory_space_id = $2 AND status = 'booked' AND direction = 'debit'
           AND amount_ore >= $3 AND reconciliation_state != 'matched'`,
        [tenantId, memorySpace, LARGE_DEBIT_THRESHOLD_ORE]
      );
      for (const row of largeDebit.rows as Array<{ bank_transaction_id: string }>) addFlag(row.bank_transaction_id, "UNEXPECTED_LARGE_DEBIT");

      // BANK_DUPLICATE_TRANSACTION: to DISTINKTE provider-ID-er, samme
      // konto/beløp/valuta/retning/bokføringsdato/referanse (defensiv -
      // provider-ID-unikheten forhindrer ekte duplikat-innsetting, dette
      // fanger en bank som rapporterer samme økonomiske hendelse under to
      // ID-er).
      const duplicates = await client.query(
        `SELECT bank_transaction_id FROM bank_transactions bt
         WHERE bt.tenant_id = $1 AND bt.memory_space_id = $2 AND bt.status = 'booked' AND EXISTS (
           SELECT 1 FROM bank_transactions bt2
           WHERE bt2.tenant_id = bt.tenant_id AND bt2.bank_account_id = bt.bank_account_id
             AND bt2.bank_transaction_id != bt.bank_transaction_id
             AND bt2.amount_ore = bt.amount_ore AND bt2.currency = bt.currency AND bt2.direction = bt.direction
             AND bt2.booking_date IS NOT DISTINCT FROM bt.booking_date
             AND bt2.reference_text IS NOT DISTINCT FROM bt.reference_text
             AND bt2.status = 'booked'
         )`,
        [tenantId, memorySpace]
      );
      for (const row of duplicates.rows as Array<{ bank_transaction_id: string }>) addFlag(row.bank_transaction_id, "BANK_DUPLICATE_TRANSACTION");

      const alreadyFlagged = await client.query(
        `SELECT bank_transaction_id FROM bank_transactions WHERE tenant_id = $1 AND memory_space_id = $2 AND jsonb_array_length(anomaly_flags) > 0`,
        [tenantId, memorySpace]
      );
      for (const row of alreadyFlagged.rows as Array<{ bank_transaction_id: string }>) {
        if (!candidateFlags.has(row.bank_transaction_id)) candidateFlags.set(row.bank_transaction_id, new Set());
      }

      let flagsAdded = 0;
      let flagsCleared = 0;
      const sweepOwned: readonly BankAnomalyType[] = ["UNMATCHED_BANK_DEBIT", "UNMATCHED_BANK_CREDIT", "UNEXPECTED_LARGE_DEBIT", "BANK_DUPLICATE_TRANSACTION"];
      for (const [txId, flags] of candidateFlags) {
        const { rows } = await client.query(`SELECT anomaly_flags FROM bank_transactions WHERE tenant_id = $1 AND bank_transaction_id = $2`, [tenantId, txId]);
        const before = new Set((rows[0]?.["anomaly_flags"] as string[] | undefined) ?? []);
        const preserved = [...before].filter((f) => !sweepOwned.includes(f as BankAnomalyType));
        const next = new Set([...preserved, ...flags]);
        if (next.size < before.size) flagsCleared++;
        if (next.size > before.size) flagsAdded++;
        await client.query(`UPDATE bank_transactions SET anomaly_flags = $2::jsonb, updated_at = now() WHERE tenant_id = $1 AND bank_transaction_id = $3`, [tenantId, JSON.stringify([...next]), txId]);
      }
      return { transaction_flags_added: flagsAdded, flags_cleared: flagsCleared };
    });
  }

  private async appendBankAnomalyFlags(client: pg.PoolClient, bankTransactionId: string, flags: readonly BankAnomalyType[]): Promise<void> {
    await client.query(
      `UPDATE bank_transactions SET anomaly_flags = (
         SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(anomaly_flags || $2::jsonb) AS v
       ), updated_at = now() WHERE bank_transaction_id = $1`,
      [bankTransactionId, JSON.stringify(flags)]
    );
  }
}
