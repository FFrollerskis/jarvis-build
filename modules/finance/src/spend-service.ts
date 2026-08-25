import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { CURRENCY_PATTERN, InvalidAmountError, InvalidCurrencyError } from "./types.ts";
import {
  assertValidCommitmentTransition,
  assertValidProcurementTransition
} from "./spend-state-machine.ts";
import {
  CommitmentNotFoundError,
  MissingCadenceIntervalError,
  ProcurementItemNotFoundError,
  SpendRecordNotFoundError
} from "./spend-types.ts";
import type {
  CreateProcurementItemInput,
  CreateRecurringCommitmentInput,
  FinanceProcurementItem,
  FinanceRecurringCommitment,
  FinanceSpendRecord,
  SpendAnomalyDetectionResult,
  SpendSyncResult
} from "./spend-types.ts";

/** §12: fast, dokumentert nådeperiode for "forventet belastning uteblir" (§8D/recurring) - IKKE en konfigurerbar AI-vurdering, samme prinsipp som payment_intents sine faste CHECK-terskler. */
const MISSING_CHARGE_GRACE_DAYS = 3;

function cadenceIntervalSql(alias: string): string {
  return `CASE ${alias}.cadence
            WHEN 'monthly' THEN INTERVAL '1 month'
            WHEN 'yearly' THEN INTERVAL '1 year'
            ELSE (${alias}.cadence_interval_days || ' days')::interval
          END`;
}

async function readCommitmentForUpdate(client: pg.PoolClient, tenantId: string, commitmentId: string, forUpdate: boolean): Promise<FinanceRecurringCommitment | null> {
  const { rows } = await client.query(
    `SELECT * FROM finance_recurring_commitments WHERE tenant_id = $1 AND commitment_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, commitmentId]
  );
  return (rows[0] as FinanceRecurringCommitment | undefined) ?? null;
}

async function readProcurementForUpdate(client: pg.PoolClient, tenantId: string, procurementItemId: string, forUpdate: boolean): Promise<FinanceProcurementItem | null> {
  const { rows } = await client.query(
    `SELECT * FROM finance_procurement_items WHERE tenant_id = $1 AND procurement_item_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, procurementItemId]
  );
  return (rows[0] as FinanceProcurementItem | undefined) ?? null;
}

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2):
 * intern utgifts-synk (marketing/model_cost), abonnement-/anskaffelses-
 * register, deterministisk avviksdeteksjon og avstemming/matching. Egen
 * tjeneste, SAMME `pool`/RLS-primitiv som `FinanceService` - ingen ny
 * sikkerhetsmodell. ZERO ekstern leverandør rørt (kun interne kilder Jarvis
 * allerede eier, se `039_finance_spend_integrity.sql`).
 *
 * §13 Kill switch-distinksjon: `finance_kill_switch` styrer KUN aktiv
 * pengeutførelse (`FinanceService.submitPaymentIntent()`). ALT i denne
 * klassen er PASSIV observasjon/regnskap (synk/deteksjon/avstemming av
 * ALLEREDE skjedd utgift) - INGEN metode her sjekker kill switch, med
 * vilje (se spend-service.test.ts for den eksplisitte regresjonen).
 */
export class SpendService {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------
  // Recurring commitments (§6)
  // ---------------------------------------------------------------------

  private validateCommitmentInput(input: CreateRecurringCommitmentInput): void {
    if (!Number.isInteger(input.expected_amount_ore) || input.expected_amount_ore <= 0) throw new InvalidAmountError(input.expected_amount_ore);
    const currency = input.currency ?? "NOK";
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidCurrencyError(currency);
    if (input.cadence === "custom_days" && !input.cadence_interval_days) throw new MissingCadenceIntervalError();
  }

  async createCommitment(tenantId: string, memorySpace: MemorySpace, input: CreateRecurringCommitmentInput): Promise<FinanceRecurringCommitment> {
    this.validateCommitmentInput(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const commitmentId = `fin-rc-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO finance_recurring_commitments
           (commitment_id, tenant_id, memory_space_id, vendor_name, description, cadence, cadence_interval_days,
            expected_billing_day_of_month, expected_amount_ore, currency, amount_tolerance_ore, source_mapping,
            payment_intent_id, owner_person_id, start_date, end_date, next_expected_charge_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date::timestamptz)
         RETURNING *`,
        [
          commitmentId, tenantId, memorySpace, input.vendor_name, input.description, input.cadence,
          input.cadence_interval_days ?? null, input.expected_billing_day_of_month ?? null, input.expected_amount_ore,
          input.currency ?? "NOK", input.amount_tolerance_ore ?? 0, JSON.stringify(input.source_mapping ?? {}),
          input.payment_intent_id ?? null, input.owner_person_id ?? null, input.start_date, input.end_date ?? null,
          input.start_date
        ]
      );
      return rows[0] as FinanceRecurringCommitment;
    });
  }

  async getCommitment(tenantId: string, memorySpace: MemorySpace, commitmentId: string): Promise<FinanceRecurringCommitment | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) => readCommitmentForUpdate(client, tenantId, commitmentId, false));
  }

  async listCommitments(tenantId: string, memorySpace: MemorySpace, state?: FinanceRecurringCommitment["state"]): Promise<FinanceRecurringCommitment[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = state
        ? await client.query(`SELECT * FROM finance_recurring_commitments WHERE tenant_id = $1 AND state = $2 ORDER BY created_at DESC`, [tenantId, state])
        : await client.query(`SELECT * FROM finance_recurring_commitments WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
      return rows as FinanceRecurringCommitment[];
    });
  }

  async updateCommitment(
    tenantId: string,
    memorySpace: MemorySpace,
    commitmentId: string,
    patch: { description?: string; expected_amount_ore?: number; amount_tolerance_ore?: number; source_mapping?: Record<string, unknown> }
  ): Promise<FinanceRecurringCommitment> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readCommitmentForUpdate(client, tenantId, commitmentId, true);
      if (!current) throw new CommitmentNotFoundError(commitmentId);
      if (patch.expected_amount_ore !== undefined && (!Number.isInteger(patch.expected_amount_ore) || patch.expected_amount_ore <= 0)) {
        throw new InvalidAmountError(patch.expected_amount_ore);
      }
      const { rows } = await client.query(
        `UPDATE finance_recurring_commitments SET
           description = COALESCE($3, description), expected_amount_ore = COALESCE($4, expected_amount_ore),
           amount_tolerance_ore = COALESCE($5, amount_tolerance_ore), source_mapping = COALESCE($6, source_mapping), updated_at = now()
         WHERE tenant_id = $1 AND commitment_id = $2 RETURNING *`,
        [
          tenantId, commitmentId, patch.description ?? null, patch.expected_amount_ore ?? null,
          patch.amount_tolerance_ore ?? null, patch.source_mapping ? JSON.stringify(patch.source_mapping) : null
        ]
      );
      return rows[0] as FinanceRecurringCommitment;
    });
  }

  private async setCommitmentState(tenantId: string, memorySpace: MemorySpace, commitmentId: string, target: FinanceRecurringCommitment["state"]): Promise<FinanceRecurringCommitment> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readCommitmentForUpdate(client, tenantId, commitmentId, true);
      if (!current) throw new CommitmentNotFoundError(commitmentId);
      assertValidCommitmentTransition(current.state, target);
      const { rows } = await client.query(
        `UPDATE finance_recurring_commitments SET state = $3, cancelled_at = CASE WHEN $3 = 'cancelled' THEN now() ELSE cancelled_at END, updated_at = now()
         WHERE tenant_id = $1 AND commitment_id = $2 RETURNING *`,
        [tenantId, commitmentId, target]
      );
      return rows[0] as FinanceRecurringCommitment;
    });
  }

  async pauseCommitment(tenantId: string, memorySpace: MemorySpace, commitmentId: string): Promise<FinanceRecurringCommitment> {
    return this.setCommitmentState(tenantId, memorySpace, commitmentId, "paused");
  }

  async resumeCommitment(tenantId: string, memorySpace: MemorySpace, commitmentId: string): Promise<FinanceRecurringCommitment> {
    return this.setCommitmentState(tenantId, memorySpace, commitmentId, "active");
  }

  async cancelCommitment(tenantId: string, memorySpace: MemorySpace, commitmentId: string): Promise<FinanceRecurringCommitment> {
    return this.setCommitmentState(tenantId, memorySpace, commitmentId, "cancelled");
  }

  // ---------------------------------------------------------------------
  // Procurement / expected spend (§7)
  // ---------------------------------------------------------------------

  private validateProcurementInput(input: CreateProcurementItemInput): void {
    if (!Number.isInteger(input.expected_amount_ore) || input.expected_amount_ore <= 0) throw new InvalidAmountError(input.expected_amount_ore);
    const currency = input.currency ?? "NOK";
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidCurrencyError(currency);
  }

  async createProcurementItem(tenantId: string, memorySpace: MemorySpace, input: CreateProcurementItemInput): Promise<FinanceProcurementItem> {
    this.validateProcurementInput(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const procurementItemId = `fin-pr-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO finance_procurement_items
           (procurement_item_id, tenant_id, memory_space_id, vendor_name, description, expected_amount_ore, currency,
            expected_date, expected_window_days, payment_intent_id, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          procurementItemId, tenantId, memorySpace, input.vendor_name, input.description, input.expected_amount_ore,
          input.currency ?? "NOK", input.expected_date, input.expected_window_days ?? 0, input.payment_intent_id ?? null,
          input.owner_person_id ?? null
        ]
      );
      return rows[0] as FinanceProcurementItem;
    });
  }

  async getProcurementItem(tenantId: string, memorySpace: MemorySpace, procurementItemId: string): Promise<FinanceProcurementItem | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) => readProcurementForUpdate(client, tenantId, procurementItemId, false));
  }

  async listProcurementItems(tenantId: string, memorySpace: MemorySpace, status?: FinanceProcurementItem["status"]): Promise<FinanceProcurementItem[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = status
        ? await client.query(`SELECT * FROM finance_procurement_items WHERE tenant_id = $1 AND status = $2 ORDER BY expected_date DESC`, [tenantId, status])
        : await client.query(`SELECT * FROM finance_procurement_items WHERE tenant_id = $1 ORDER BY expected_date DESC`, [tenantId]);
      return rows as FinanceProcurementItem[];
    });
  }

  async updateProcurementItem(
    tenantId: string,
    memorySpace: MemorySpace,
    procurementItemId: string,
    patch: { expected_amount_ore?: number; expected_date?: string; expected_window_days?: number }
  ): Promise<FinanceProcurementItem> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readProcurementForUpdate(client, tenantId, procurementItemId, true);
      if (!current) throw new ProcurementItemNotFoundError(procurementItemId);
      if (patch.expected_amount_ore !== undefined && (!Number.isInteger(patch.expected_amount_ore) || patch.expected_amount_ore <= 0)) {
        throw new InvalidAmountError(patch.expected_amount_ore);
      }
      const { rows } = await client.query(
        `UPDATE finance_procurement_items SET
           expected_amount_ore = COALESCE($3, expected_amount_ore), expected_date = COALESCE($4, expected_date),
           expected_window_days = COALESCE($5, expected_window_days), updated_at = now()
         WHERE tenant_id = $1 AND procurement_item_id = $2 RETURNING *`,
        [tenantId, procurementItemId, patch.expected_amount_ore ?? null, patch.expected_date ?? null, patch.expected_window_days ?? null]
      );
      return rows[0] as FinanceProcurementItem;
    });
  }

  async fulfillProcurementItem(tenantId: string, memorySpace: MemorySpace, procurementItemId: string): Promise<FinanceProcurementItem> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readProcurementForUpdate(client, tenantId, procurementItemId, true);
      if (!current) throw new ProcurementItemNotFoundError(procurementItemId);
      assertValidProcurementTransition(current.status, "fulfilled");
      const { rows } = await client.query(
        `UPDATE finance_procurement_items SET status = 'fulfilled', fulfilled_at = now(), updated_at = now() WHERE tenant_id = $1 AND procurement_item_id = $2 RETURNING *`,
        [tenantId, procurementItemId]
      );
      return rows[0] as FinanceProcurementItem;
    });
  }

  async cancelProcurementItem(tenantId: string, memorySpace: MemorySpace, procurementItemId: string): Promise<FinanceProcurementItem> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readProcurementForUpdate(client, tenantId, procurementItemId, true);
      if (!current) throw new ProcurementItemNotFoundError(procurementItemId);
      assertValidProcurementTransition(current.status, "cancelled");
      const { rows } = await client.query(
        `UPDATE finance_procurement_items SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE tenant_id = $1 AND procurement_item_id = $2 RETURNING *`,
        [tenantId, procurementItemId]
      );
      return rows[0] as FinanceProcurementItem;
    });
  }

  // ---------------------------------------------------------------------
  // Normalized spend records (§3, read surface)
  // ---------------------------------------------------------------------

  async getSpendRecord(tenantId: string, memorySpace: MemorySpace, spendRecordId: string): Promise<FinanceSpendRecord | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM finance_spend_records WHERE tenant_id = $1 AND spend_record_id = $2`, [tenantId, spendRecordId]);
      return (rows[0] as FinanceSpendRecord | undefined) ?? null;
    });
  }

  async listSpendRecords(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { source_family?: FinanceSpendRecord["source_family"]; campaign_id?: string; limit?: number } = {}
  ): Promise<FinanceSpendRecord[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const limit = Math.min(filter.limit ?? 50, 200);
      const conditions = ["tenant_id = $1"];
      const values: unknown[] = [tenantId];
      if (filter.source_family) {
        values.push(filter.source_family);
        conditions.push(`source_family = $${values.length}`);
      }
      if (filter.campaign_id) {
        values.push(filter.campaign_id);
        conditions.push(`campaign_id = $${values.length}`);
      }
      values.push(limit);
      const { rows } = await client.query(
        `SELECT * FROM finance_spend_records WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC LIMIT $${values.length}`,
        values
      );
      return rows as FinanceSpendRecord[];
    });
  }

  /** §11: uløste avvik på tvers av spend-records/forpliktelser/anskaffelser - operativt inspeksjonsvindu, ikke en ny motor. */
  async listUnresolvedSpendAnomalies(tenantId: string, memorySpace: MemorySpace): Promise<{ spend_records: FinanceSpendRecord[]; commitments: FinanceRecurringCommitment[]; procurement_items: FinanceProcurementItem[] }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const [spendRecords, commitments, procurementItems] = await Promise.all([
        client.query(`SELECT * FROM finance_spend_records WHERE tenant_id = $1 AND jsonb_array_length(anomaly_flags) > 0 ORDER BY occurred_at DESC LIMIT 200`, [tenantId]),
        client.query(`SELECT * FROM finance_recurring_commitments WHERE tenant_id = $1 AND jsonb_array_length(anomaly_flags) > 0 ORDER BY updated_at DESC LIMIT 200`, [tenantId]),
        client.query(`SELECT * FROM finance_procurement_items WHERE tenant_id = $1 AND jsonb_array_length(anomaly_flags) > 0 ORDER BY updated_at DESC LIMIT 200`, [tenantId])
      ]);
      return {
        spend_records: spendRecords.rows as FinanceSpendRecord[],
        commitments: commitments.rows as FinanceRecurringCommitment[],
        procurement_items: procurementItems.rows as FinanceProcurementItem[]
      };
    });
  }

  // ---------------------------------------------------------------------
  // Sync (§4/§5/§12): idempotent, incremental, cursor-based
  // ---------------------------------------------------------------------

  private async readCursor(client: pg.PoolClient, tenantId: string, sourceFamily: "marketing" | "model_cost"): Promise<string | null> {
    const { rows } = await client.query(`SELECT cursor_value FROM finance_spend_sync_cursors WHERE tenant_id = $1 AND source_family = $2`, [tenantId, sourceFamily]);
    return (rows[0] as { cursor_value: string | null } | undefined)?.cursor_value ?? null;
  }

  private async writeCursor(client: pg.PoolClient, tenantId: string, sourceFamily: "marketing" | "model_cost", cursorValue: string): Promise<void> {
    await client.query(
      `INSERT INTO finance_spend_sync_cursors (tenant_id, source_family, cursor_value, last_synced_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (tenant_id, source_family) DO UPDATE SET cursor_value = $3, last_synced_at = now(), updated_at = now()`,
      [tenantId, sourceFamily, cursorValue]
    );
  }

  /**
   * §4: markedsføringsutgift, inkrementell/retry-trygg/idempotent/tenant-
   * skopet. Cursor er `marketing_spend_events.updated_at` (IKKE `event_date`)
   * - dette fanger BÅDE ny historikk OG sen-korrigerte eldre rader (samme
   * rad, ny `updated_at` via GrowthService sin `ON CONFLICT DO UPDATE`,
   * se 027_growth.sql). `cursor_value = null` => full backfill.
   *
   * `date_trunc('milliseconds', updated_at)` PÅ BEGGE SIDER av sammenligningen
   * er BEVISST, ikke kosmetisk: Postgres sin `timestamptz` har mikrosekund-
   * presisjon, men JS `Date` (som pg sin type-parser konstruerer `updated_at`
   * TIL, og som cursoren derfor lagres FRA via `.toISOString()`) har KUN
   * millisekund-presisjon. Uten denne avkortingen på KILDEN sin side ville en
   * rad med et mikrosekund-restledd ALLTID vært "større enn" sin egen
   * (avkortede) cursor-verdi - en uendelig re-synkroniseringssløyfe som
   * ALDRI konvergerer mot scanned=0 (funnet via ekte Postgres-integrasjonstest,
   * ikke antatt).
   */
  async syncMarketingSpend(tenantId: string, memorySpace: MemorySpace): Promise<SpendSyncResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const cursor = await this.readCursor(client, tenantId, "marketing");
      const { rows } = await client.query(
        `SELECT spend_event_id, campaign_id, event_date, spend_amount_ore, currency, source_type, source_pointer, updated_at
         FROM marketing_spend_events
         WHERE tenant_id = $1 AND date_trunc('milliseconds', updated_at) > COALESCE($2::timestamptz, '-infinity'::timestamptz)
         ORDER BY updated_at ASC LIMIT 5000`,
        [tenantId, cursor]
      );
      const result: SpendSyncResult = { scanned: rows.length, inserted: 0, updated: 0, corrected: 0, correction_conflicts: 0 };
      let maxUpdatedAt = cursor;
      for (const row of rows as Array<{
        spend_event_id: string; campaign_id: string; event_date: string; spend_amount_ore: string; currency: string;
        source_type: string; source_pointer: string | null; updated_at: Date;
      }>) {
        const existing = await client.query(
          `SELECT amount_ore, currency, reconciliation_state FROM finance_spend_records WHERE tenant_id = $1 AND source_family = 'marketing' AND source_record_id = $2`,
          [tenantId, row.spend_event_id]
        );
        const prior = existing.rows[0] as { amount_ore: string; currency: string; reconciliation_state: string } | undefined;
        let correctionState: "original" | "corrected" | "correction_conflict" = "original";
        if (prior) {
          const changed = Number(prior.amount_ore) !== Number(row.spend_amount_ore) || prior.currency !== row.currency;
          if (changed) {
            correctionState = prior.reconciliation_state === "matched" ? "correction_conflict" : "corrected";
            if (correctionState === "correction_conflict") result.correction_conflicts++;
            else result.corrected++;
          }
        }
        const spendRecordId = `fin-sr-${randomUUID()}`;
        const { rows: upserted } = await client.query(
          `INSERT INTO finance_spend_records
             (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency,
              category, campaign_id, source_correction_state, provenance)
           VALUES ($1, $2, $3, 'marketing', $4, $5::date::timestamptz, $6, $7, 'marketing_spend', $8, $9, $10)
           ON CONFLICT (tenant_id, source_family, source_record_id) DO UPDATE SET
             amount_ore = EXCLUDED.amount_ore, currency = EXCLUDED.currency, occurred_at = EXCLUDED.occurred_at,
             campaign_id = EXCLUDED.campaign_id, provenance = EXCLUDED.provenance,
             source_correction_state = CASE WHEN $9 = 'original' THEN finance_spend_records.source_correction_state ELSE $9 END,
             updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            spendRecordId, tenantId, memorySpace, row.spend_event_id, row.event_date, row.spend_amount_ore, row.currency,
            row.campaign_id, correctionState, JSON.stringify({ sync: "marketing", source_type: row.source_type, source_pointer: row.source_pointer })
          ]
        );
        if ((upserted[0] as { inserted: boolean }).inserted) result.inserted++;
        else result.updated++;
        // `updated_at` er en `timestamptz`-kolonne - pg returnerer den som et
        // JS `Date`-objekt (IKKE en streng, til tross for TS-typen andre
        // steder i denne filen) - `.toISOString()` er her TRYGT (i motsetning
        // til `pg-date.ts` sin dokumenterte `date`-kolonne-bug: en timestamptz
        // representerer et absolutt tidspunkt, ingen lokal-tidssone-tvetydighet).
        // Å lagre `Date.prototype.toString()` (implisitt hvis IKKE konvertert)
        // som cursor-tekst ville mistet sub-sekund-presisjon og ville latt
        // ALLEREDE synkroniserte rader dukke opp på nytt for alltid (aldri
        // konvergere mot scanned=0).
        maxUpdatedAt = row.updated_at.toISOString();
      }
      if (maxUpdatedAt && maxUpdatedAt !== cursor) await this.writeCursor(client, tenantId, "marketing", maxUpdatedAt);
      return result;
    });
  }

  /**
   * §5: AI/API-leverandørkostnad. `cost_events` er APPEND-ONLY (INGEN
   * UPDATE/DELETE-grant, ingen UNIQUE-constraint - se 005_rls.sql/
   * 004_audit_cost.sql) - cursor er DERFOR den monotont økende
   * `cost_id`-identiteten, `ON CONFLICT DO NOTHING` er tilstrekkelig
   * (en cost_event-rad endres ALDRI etter innsetting, ingen korrigerings-
   * håndtering er derfor mulig eller nødvendig for denne kildefamilien).
   */
  async syncModelCost(tenantId: string, memorySpace: MemorySpace): Promise<SpendSyncResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const cursor = await this.readCursor(client, tenantId, "model_cost");
      const { rows } = await client.query(
        `SELECT cost_id, at, amount_ore, currency, provider, model, purpose
         FROM cost_events
         WHERE tenant_id = $1 AND cost_id > COALESCE($2::bigint, 0)
         ORDER BY cost_id ASC LIMIT 5000`,
        [tenantId, cursor]
      );
      const result: SpendSyncResult = { scanned: rows.length, inserted: 0, updated: 0, corrected: 0, correction_conflicts: 0 };
      let maxCostId = cursor;
      for (const row of rows as Array<{ cost_id: string; at: string; amount_ore: number; currency: string; provider: string | null; model: string | null; purpose: string | null }>) {
        const spendRecordId = `fin-sr-${randomUUID()}`;
        const { rows: upserted } = await client.query(
          `INSERT INTO finance_spend_records
             (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency,
              category, source_provider, source_model_or_service, provenance)
           VALUES ($1, $2, $3, 'model_cost', $4, $5, $6, $7, 'ai_api_cost', $8, $9, $10)
           ON CONFLICT (tenant_id, source_family, source_record_id) DO NOTHING
           RETURNING spend_record_id`,
          [
            spendRecordId, tenantId, memorySpace, String(row.cost_id), row.at, row.amount_ore, row.currency,
            row.provider, row.model, JSON.stringify({ sync: "model_cost", purpose: row.purpose })
          ]
        );
        if (upserted.length > 0) result.inserted++;
        maxCostId = String(row.cost_id);
      }
      if (maxCostId && maxCostId !== cursor) await this.writeCursor(client, tenantId, "model_cost", maxCostId);
      return result;
    });
  }

  // ---------------------------------------------------------------------
  // Matching / reconciliation (§9): deterministisk, ALDRI tvetydig sammenslått
  // ---------------------------------------------------------------------

  /**
   * Kobler ukoblede spend-records til en AKTIV forpliktelse via dens
   * deterministiske `source_mapping` (campaign_id for 'marketing',
   * source_model_or_service for 'model_cost') - EKSPLISITT eier-/agent-
   * konfigurert kobling (Q-26-grensen: ingen AI-gjettet kobling). Fremgang
   * i forpliktelsens forfallsvindu (`last_expected_charge_at`/
   * `next_expected_charge_at`) skjer KUN her, ved en FAKTISK observert
   * kobling - aldri spekulativt.
   *
   * §9-krav ("never silently merge ambiguous records, leave ambiguous cases
   * unresolved"): HVIS mer enn én aktiv forpliktelse deterministisk mapper
   * til SAMME kildesignatur (f.eks. to forpliktelser begge peker på samme
   * campaign_id), er dette EKTE tvetydighet - raden kobles til INGEN av dem
   * (`HAVING count(DISTINCT commitment_id) = 1`-vakten under), fremfor at
   * "hvilken som helst forpliktelse iterasjonen traff først" stille vinner
   * (en tidligere per-forpliktelse-løkke-formulering hadde nøyaktig denne
   * defekten - funnet via ekte Postgres-integrasjonstest, ikke antatt).
   */
  async matchAndReconcile(tenantId: string, memorySpace: MemorySpace): Promise<{ matched: number; advanced_schedules: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: commitmentMatches } = await client.query(
        `WITH candidates AS (
           SELECT sr.spend_record_id, c.commitment_id, sr.occurred_at
           FROM finance_spend_records sr
           JOIN finance_recurring_commitments c ON c.tenant_id = sr.tenant_id AND c.state = 'active'
             AND ((c.source_mapping->>'campaign_id' IS NOT NULL AND c.source_mapping->>'campaign_id' = sr.campaign_id)
               OR (c.source_mapping->>'source_model_or_service' IS NOT NULL AND c.source_mapping->>'source_model_or_service' = sr.source_model_or_service))
           WHERE sr.tenant_id = $1 AND sr.memory_space_id = $2 AND sr.recurring_commitment_id IS NULL
         ),
         unambiguous AS (
           SELECT spend_record_id, min(commitment_id) AS commitment_id, max(occurred_at) AS occurred_at
           FROM candidates GROUP BY spend_record_id HAVING count(DISTINCT commitment_id) = 1
         )
         UPDATE finance_spend_records sr SET recurring_commitment_id = u.commitment_id, reconciliation_state = 'matched', updated_at = now()
         FROM unambiguous u
         WHERE sr.tenant_id = $1 AND sr.spend_record_id = u.spend_record_id
         RETURNING u.commitment_id, sr.occurred_at`,
        [tenantId, memorySpace]
      );
      let matched = commitmentMatches.length;
      let advanced = 0;
      const latestByCommitment = new Map<string, string>();
      for (const row of commitmentMatches as Array<{ commitment_id: string; occurred_at: string }>) {
        const occurredAtIso = new Date(row.occurred_at).toISOString();
        const current = latestByCommitment.get(row.commitment_id);
        if (!current || occurredAtIso > current) latestByCommitment.set(row.commitment_id, occurredAtIso);
      }
      for (const [commitmentId, latest] of latestByCommitment) {
        await client.query(
          `UPDATE finance_recurring_commitments SET
             last_expected_charge_at = $3::timestamptz,
             next_expected_charge_at = $3::timestamptz + ${cadenceIntervalSql("finance_recurring_commitments")},
             updated_at = now()
           WHERE tenant_id = $1 AND commitment_id = $2`,
          [tenantId, commitmentId, latest]
        );
        advanced++;
      }
      // Anskaffelser: match ubekreftet spend mot forventet anskaffelse via vendor+beløp+dato-vindu (deterministisk, ALDRI tvetydig - lar tvetydige tilfeller stå uløst).
      const { rows: procurementMatches } = await client.query(
        `UPDATE finance_spend_records sr SET procurement_item_id = pi.procurement_item_id, reconciliation_state = 'matched', updated_at = now()
         FROM finance_procurement_items pi
         WHERE sr.tenant_id = $1 AND pi.tenant_id = $1 AND sr.memory_space_id = $2 AND pi.memory_space_id = $2
           AND sr.procurement_item_id IS NULL AND pi.status = 'expected' AND sr.amount_ore = pi.expected_amount_ore
           AND sr.currency = pi.currency
           AND sr.occurred_at::date BETWEEN (pi.expected_date - pi.expected_window_days) AND (pi.expected_date + pi.expected_window_days)
           AND (SELECT count(*) FROM finance_spend_records sr2 WHERE sr2.tenant_id = $1 AND sr2.procurement_item_id IS NULL
                 AND sr2.amount_ore = pi.expected_amount_ore AND sr2.currency = pi.currency
                 AND sr2.occurred_at::date BETWEEN (pi.expected_date - pi.expected_window_days) AND (pi.expected_date + pi.expected_window_days)) = 1
         RETURNING sr.spend_record_id, pi.procurement_item_id`,
        [tenantId, memorySpace]
      );
      for (const row of procurementMatches as Array<{ procurement_item_id: string }>) {
        await client.query(
          `UPDATE finance_procurement_items SET status = 'fulfilled', reconciliation_state = 'matched', fulfilled_at = now(), updated_at = now() WHERE tenant_id = $1 AND procurement_item_id = $2`,
          [tenantId, row.procurement_item_id]
        );
        matched++;
      }
      return { matched, advanced_schedules: advanced };
    });
  }

  /** Manuell avstemmingsmarkering for ÉN spend-record (mirrors `FinanceService.reconcilePaymentIntent`). */
  async reconcileSpendRecord(tenantId: string, memorySpace: MemorySpace, spendRecordId: string, matched: boolean): Promise<FinanceSpendRecord> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: existing } = await client.query(`SELECT spend_record_id FROM finance_spend_records WHERE tenant_id = $1 AND spend_record_id = $2 FOR UPDATE`, [tenantId, spendRecordId]);
      if (existing.length === 0) throw new SpendRecordNotFoundError(spendRecordId);
      const { rows } = await client.query(
        `UPDATE finance_spend_records SET reconciliation_state = $3, updated_at = now() WHERE tenant_id = $1 AND spend_record_id = $2 RETURNING *`,
        [tenantId, spendRecordId, matched ? "matched" : "mismatched"]
      );
      return rows[0] as FinanceSpendRecord;
    });
  }

  // ---------------------------------------------------------------------
  // Deterministic anomaly detection (§8) - REN SQL, ALDRI AI-inferens
  // ---------------------------------------------------------------------

  /**
   * Beregner det FULLE avviksflagg-settet PÅ NYTT for hver berørt rad hver
   * kjøring (full erstatning, ikke inkrementell union) - idempotent og
   * selv-korrigerende: et avvik hvis vilkår ikke lenger er sant forsvinner
   * automatisk neste kjøring, SAMME "re-evaluer, oppdater samme rad"-prinsipp
   * som `OpenLoopService.autoResolveStale()`.
   */
  async runAnomalyDetection(tenantId: string, memorySpace: MemorySpace, deviationFactor = 1.5, minBaselineOre = 100): Promise<SpendAnomalyDetectionResult> {
    void deviationFactor;
    void minBaselineOre;
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      // A) DUPLICATE_SOURCE_SPEND - kun 'marketing' (se runAnomalyDetection-JSDoc for begrunnelse: model_cost har naturlig mange like beløp samme dag, ville vært ren støy).
      const { rows: dupGroups } = await client.query(
        `SELECT array_agg(spend_record_id) AS ids FROM finance_spend_records
         WHERE tenant_id = $1 AND memory_space_id = $2 AND source_family = 'marketing' AND campaign_id IS NOT NULL
         GROUP BY campaign_id, occurred_at::date HAVING count(*) > 1`,
        [tenantId, memorySpace]
      );
      const duplicateFlaggedIds = new Set<string>();
      for (const group of dupGroups as Array<{ ids: string[] }>) for (const id of group.ids) duplicateFlaggedIds.add(id);

      // B) UNEXPECTED_SPEND - spend etter at en tidligere-mappet forpliktelse er satt på pause/kansellert.
      const { rows: unexpected } = await client.query(
        `SELECT sr.spend_record_id FROM finance_spend_records sr
         JOIN finance_recurring_commitments c ON c.tenant_id = sr.tenant_id
           AND ((c.source_mapping->>'campaign_id') = sr.campaign_id OR (c.source_mapping->>'source_model_or_service') = sr.source_model_or_service)
         WHERE sr.tenant_id = $1 AND sr.memory_space_id = $2 AND c.state IN ('paused', 'cancelled')
           AND sr.occurred_at > COALESCE(c.cancelled_at, c.updated_at)`,
        [tenantId, memorySpace]
      );
      const unexpectedIds = new Set((unexpected as Array<{ spend_record_id: string }>).map((r) => r.spend_record_id));

      // C) AMOUNT_DEVIATION - koblet spend-record utenfor forpliktelsens toleranse.
      const { rows: deviated } = await client.query(
        `SELECT sr.spend_record_id FROM finance_spend_records sr
         JOIN finance_recurring_commitments c ON c.tenant_id = sr.tenant_id AND c.commitment_id = sr.recurring_commitment_id
         WHERE sr.tenant_id = $1 AND sr.memory_space_id = $2 AND abs(sr.amount_ore - c.expected_amount_ore) > c.amount_tolerance_ore`,
        [tenantId, memorySpace]
      );
      const deviatedIds = new Set((deviated as Array<{ spend_record_id: string }>).map((r) => r.spend_record_id));

      // F) CURRENCY_MISMATCH - koblet spend-record med annen valuta enn forpliktelsen/anskaffelsen.
      const { rows: currencyMismatch } = await client.query(
        `SELECT sr.spend_record_id FROM finance_spend_records sr
         LEFT JOIN finance_recurring_commitments c ON c.tenant_id = sr.tenant_id AND c.commitment_id = sr.recurring_commitment_id
         LEFT JOIN finance_procurement_items pi ON pi.tenant_id = sr.tenant_id AND pi.procurement_item_id = sr.procurement_item_id
         WHERE sr.tenant_id = $1 AND sr.memory_space_id = $2
           AND ((c.commitment_id IS NOT NULL AND sr.currency != c.currency) OR (pi.procurement_item_id IS NOT NULL AND sr.currency != pi.currency))`,
        [tenantId, memorySpace]
      );
      const currencyMismatchIds = new Set((currencyMismatch as Array<{ spend_record_id: string }>).map((r) => r.spend_record_id));

      // E) DUPLICATE_RECURRING_CHARGE - 2+ koblede spend-records for SAMME forpliktelse innenfor SAMME kadanse-vindu (selv-join: to distinkte rader koblet til samme forpliktelse, hvis avstand i tid er MINDRE enn forpliktelsens eget kadanse-intervall, er de for tett til å være to separate, legitime belastninger).
      const { rows: dupChargePairs } = await client.query(
        `SELECT DISTINCT a.spend_record_id AS id FROM finance_spend_records a
         JOIN finance_spend_records b ON b.tenant_id = a.tenant_id AND b.recurring_commitment_id = a.recurring_commitment_id AND b.spend_record_id != a.spend_record_id
         JOIN finance_recurring_commitments c ON c.tenant_id = a.tenant_id AND c.commitment_id = a.recurring_commitment_id
         WHERE a.tenant_id = $1 AND a.memory_space_id = $2 AND a.recurring_commitment_id IS NOT NULL
           AND abs(extract(epoch FROM (a.occurred_at - b.occurred_at))) < extract(epoch FROM ${cadenceIntervalSql("c")})`,
        [tenantId, memorySpace]
      );
      const dupChargeIds = new Set((dupChargePairs as Array<{ id: string }>).map((r) => r.id));
      const commitmentsWithDupCharge = new Set<string>();
      if (dupChargeIds.size > 0) {
        const { rows } = await client.query(
          `SELECT DISTINCT recurring_commitment_id FROM finance_spend_records WHERE tenant_id = $1 AND spend_record_id = ANY($2)`,
          [tenantId, [...dupChargeIds]]
        );
        for (const r of rows as Array<{ recurring_commitment_id: string }>) commitmentsWithDupCharge.add(r.recurring_commitment_id);
      }

      // Full erstatning av anomaly_flags for HVER spend-record som har minst ett kandidatflagg ELLER allerede hadde flagg (for å kunne klarere dem).
      const candidateIds = new Set<string>([...duplicateFlaggedIds, ...unexpectedIds, ...deviatedIds, ...currencyMismatchIds, ...dupChargeIds]);
      const { rows: alreadyFlagged } = await client.query(
        `SELECT spend_record_id FROM finance_spend_records WHERE tenant_id = $1 AND memory_space_id = $2 AND jsonb_array_length(anomaly_flags) > 0`,
        [tenantId, memorySpace]
      );
      for (const r of alreadyFlagged as Array<{ spend_record_id: string }>) candidateIds.add(r.spend_record_id);
      // G) SOURCE_CORRECTION_CONFLICT - satt av synk-koden (source_correction_state), MÅ inkluderes her selv om INGEN av A/B/C/F traff, ellers ville en rad hvis ENESTE avvik er en kildekorreksjonskonflikt aldri fått avviks-flagget sitt satt.
      const { rows: correctionConflicts } = await client.query(
        `SELECT spend_record_id FROM finance_spend_records WHERE tenant_id = $1 AND memory_space_id = $2 AND source_correction_state = 'correction_conflict'`,
        [tenantId, memorySpace]
      );
      for (const r of correctionConflicts as Array<{ spend_record_id: string }>) candidateIds.add(r.spend_record_id);

      let spendRecordFlagsAdded = 0;
      let flagsCleared = 0;
      for (const id of candidateIds) {
        const { rows: srRows } = await client.query(`SELECT source_correction_state, anomaly_flags FROM finance_spend_records WHERE tenant_id = $1 AND spend_record_id = $2`, [tenantId, id]);
        const sr = srRows[0] as { source_correction_state: string; anomaly_flags: string[] } | undefined;
        if (!sr) continue;
        const flags: string[] = [];
        if (duplicateFlaggedIds.has(id)) flags.push("DUPLICATE_SOURCE_SPEND");
        if (unexpectedIds.has(id)) flags.push("UNEXPECTED_SPEND");
        if (deviatedIds.has(id)) flags.push("AMOUNT_DEVIATION");
        if (currencyMismatchIds.has(id)) flags.push("CURRENCY_MISMATCH");
        if (dupChargeIds.has(id)) flags.push("DUPLICATE_RECURRING_CHARGE");
        if (sr.source_correction_state === "correction_conflict") flags.push("SOURCE_CORRECTION_CONFLICT");
        const previousCount = sr.anomaly_flags?.length ?? 0;
        if (flags.length > previousCount) spendRecordFlagsAdded++;
        if (flags.length < previousCount) flagsCleared++;
        await client.query(`UPDATE finance_spend_records SET anomaly_flags = $3, updated_at = now() WHERE tenant_id = $1 AND spend_record_id = $2`, [tenantId, id, JSON.stringify(flags)]);
      }

      // D) MISSING_EXPECTED_SPEND (recurring): aktiv forpliktelse hvis forventede belastning + nådeperiode har passert uten ny kobling siden sist.
      const { rows: missingRecurring } = await client.query(
        `UPDATE finance_recurring_commitments SET
           anomaly_flags = CASE WHEN next_expected_charge_at IS NOT NULL AND next_expected_charge_at + make_interval(days => $3) < now()
                                 THEN (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(anomaly_flags || '["MISSING_EXPECTED_SPEND"]'::jsonb) v)
                                 ELSE (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(anomaly_flags) v WHERE v != 'MISSING_EXPECTED_SPEND') END,
           updated_at = now()
         WHERE tenant_id = $1 AND memory_space_id = $2 AND state = 'active'
         RETURNING commitment_id`,
        [tenantId, memorySpace, MISSING_CHARGE_GRACE_DAYS]
      );
      // DUPLICATE_RECURRING_CHARGE-flagget på selve forpliktelsen (i tillegg til spend-record-nivå).
      await client.query(
        `UPDATE finance_recurring_commitments SET
           anomaly_flags = CASE WHEN commitment_id = ANY($3) THEN (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(anomaly_flags || '["DUPLICATE_RECURRING_CHARGE"]'::jsonb) v)
                                 ELSE (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(anomaly_flags) v WHERE v != 'DUPLICATE_RECURRING_CHARGE') END,
           updated_at = now()
         WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace, [...commitmentsWithDupCharge]]
      );

      // D) MISSING_EXPECTED_SPEND (procurement): forventet dato + vindu passert, fortsatt 'expected', ingen koblet spend.
      await client.query(
        `UPDATE finance_procurement_items SET
           anomaly_flags = CASE WHEN status = 'expected' AND (expected_date + expected_window_days) < current_date
                                 THEN (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(anomaly_flags || '["MISSING_EXPECTED_SPEND"]'::jsonb) v)
                                 ELSE (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(anomaly_flags) v WHERE v != 'MISSING_EXPECTED_SPEND') END,
           updated_at = now()
         WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );

      return { spend_record_flags_added: spendRecordFlagsAdded, commitment_flags_added: missingRecurring.length, flags_cleared: flagsCleared };
    });
  }

  /** §12/DailyScheduler-jobb: synk BEGGE kilder -> match/avstem -> deteksjon. Trygg å kjøre gjentatte ganger (hver del er idempotent). */
  async runFullSweep(tenantId: string, memorySpace: MemorySpace): Promise<{
    marketing: SpendSyncResult; model_cost: SpendSyncResult; reconciliation: { matched: number; advanced_schedules: number }; anomalies: SpendAnomalyDetectionResult;
  }> {
    const marketing = await this.syncMarketingSpend(tenantId, memorySpace);
    const modelCost = await this.syncModelCost(tenantId, memorySpace);
    const reconciliation = await this.matchAndReconcile(tenantId, memorySpace);
    const anomalies = await this.runAnomalyDetection(tenantId, memorySpace);
    return { marketing, model_cost: modelCost, reconciliation, anomalies };
  }
}
