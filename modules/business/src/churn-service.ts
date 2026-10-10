import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { CHURN_RISK_RULE_VERSION, CHURN_V1, calculateChurnRiskV1 } from "./churn-rules.ts";
import type { ChurnAssessment, ChurnLevel, ChurnMetrics, ChurnOverview, ChurnSignals, ChurnSweepResult } from "./churn-types.ts";
import { ProductUsageService } from "./product-usage-service.ts";
import type { ScoreFactor } from "./scoring-types.ts";

/**
 * WP-D2 (UA-3 «churn/product usage», migrasjon 090): beregner og lagrer churn-vurderinger for KOBLEDE kundekontoer. Signal-innsamlingen spør KUN aggregerte tall fra
 * `product_usage_events` (aldri `user_ref`), `support_tickets` (antall åpne + høy prioritet, id-er) og siste `billing_status`. Selve regelen er ren (churn-rules.ts).
 *
 * Idempotent: `business_churn_assessments` har (tenant, konto, regelversjon) som nøkkel - en ny kjøring oppdaterer SAMME rad. Tjenesten handler ALDRI utad: den leser
 * og skriver kun egen vurderingstilstand; open loop-koblingen (SUGGEST/INFORM) gjør `OpenLoopService.detectChurnRisk()`.
 */

const DAY_MS = 86_400_000;

interface UsageAggRow {
  account_ref: string;
  company_id: string;
  first_usage_at: Date | null;
  last_usage_at: Date | null;
  recent_total: string | number;
  baseline_total: string | number;
}

interface TicketAggRow {
  company_id: string;
  open_count: string | number;
  high_count: string | number;
  ticket_ids: string[] | null;
}

interface BillingRow {
  account_ref: string;
  event_id: string;
  quantity: number;
}

const wholeDays = (from: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));

export class ChurnService {
  private readonly usage: ProductUsageService;

  constructor(private readonly pool: pg.Pool) {
    this.usage = new ProductUsageService(pool);
  }

  /**
   * Vurderer alle koblede kontoer i tenanten (etter å ha ryddet hendelser eldre enn oppbevaringen). `now` er injiserbar for deterministiske tester.
   * Kontoer uten kobling vurderes ikke (ingen kan handle på et pseudonym) - de telles i `unlinked_accounts` så eieren ser at det finnes noe å koble.
   */
  async assessTenant(tenantId: string, space: MemorySpace, options: { now?: Date } = {}): Promise<ChurnSweepResult> {
    const now = options.now ?? new Date();
    const purged = await this.usage.purgeExpired(tenantId, space);
    return withMemoryTransaction(this.pool, tenantId, [space], async (client): Promise<ChurnSweepResult> => {
      const linked = (await client.query(
        `SELECT a.account_ref, a.company_id,
                min(e.occurred_at) FILTER (WHERE e.kind = 'usage') AS first_usage_at,
                max(e.occurred_at) FILTER (WHERE e.kind = 'usage' AND e.occurred_at <= $2) AS last_usage_at,
                COALESCE(sum(e.quantity) FILTER (WHERE e.kind = 'usage' AND e.occurred_at > $2::timestamptz - make_interval(days => $3) AND e.occurred_at <= $2), 0) AS recent_total,
                COALESCE(sum(e.quantity) FILTER (WHERE e.kind = 'usage' AND e.occurred_at > $2::timestamptz - make_interval(days => $3 * 2) AND e.occurred_at <= $2::timestamptz - make_interval(days => $3)), 0) AS baseline_total
           FROM product_usage_accounts a
           LEFT JOIN product_usage_events e ON e.tenant_id = a.tenant_id AND e.account_ref = a.account_ref
          WHERE a.tenant_id = $1 AND a.company_id IS NOT NULL
          GROUP BY a.account_ref, a.company_id
          ORDER BY a.account_ref`,
        [tenantId, now, CHURN_V1.window_days]
      )).rows as UsageAggRow[];

      const unlinked = Number(((await client.query(
        "SELECT count(*)::int AS n FROM product_usage_accounts WHERE tenant_id = $1 AND company_id IS NULL AND last_event_at IS NOT NULL", [tenantId]
      )).rows[0] as { n: number }).n);

      const accountRefs = linked.map((r) => r.account_ref);
      const companyIds = [...new Set(linked.map((r) => r.company_id))];

      const billing = new Map<string, BillingRow>();
      if (accountRefs.length > 0) {
        const rows = (await client.query(
          `SELECT DISTINCT ON (account_ref) account_ref, event_id, quantity
             FROM product_usage_events
            WHERE tenant_id = $1 AND kind = 'billing_status' AND account_ref = ANY($2::text[])
              AND occurred_at <= $3 AND occurred_at > $3::timestamptz - make_interval(days => $4)
            ORDER BY account_ref, occurred_at DESC, received_at DESC`,
          [tenantId, accountRefs, now, CHURN_V1.billing_max_age_days]
        )).rows as BillingRow[];
        for (const r of rows) billing.set(r.account_ref, r);
      }

      const tickets = new Map<string, TicketAggRow>();
      if (companyIds.length > 0) {
        const rows = (await client.query(
          `SELECT company_id, count(*) AS open_count, count(*) FILTER (WHERE priority IN ('high', 'urgent')) AS high_count,
                  (array_agg(ticket_id ORDER BY created_at DESC))[1:5] AS ticket_ids
             FROM support_tickets
            WHERE tenant_id = $1 AND company_id = ANY($2::text[]) AND status NOT IN ('resolved', 'closed')
            GROUP BY company_id`,
          [tenantId, companyIds]
        )).rows as TicketAggRow[];
        for (const r of rows) tickets.set(r.company_id, r);
      }

      const assessments: ChurnAssessment[] = [];
      for (const row of linked) {
        const t = tickets.get(row.company_id);
        const b = billing.get(row.account_ref);
        const signals: ChurnSignals = {
          days_since_last_usage: row.last_usage_at ? wholeDays(new Date(row.last_usage_at), now) : null,
          account_age_days: row.first_usage_at ? wholeDays(new Date(row.first_usage_at), now) : null,
          usage_recent_14d: Number(row.recent_total),
          usage_baseline_prev_14d: Number(row.baseline_total),
          open_support_tickets: t ? Number(t.open_count) : 0,
          high_priority_open_tickets: t ? Number(t.high_count) : 0,
          overdue_invoices: b ? Number(b.quantity) : null,
          support_ticket_ids: t?.ticket_ids ?? [],
          billing_event_id: b?.event_id ?? null
        };
        const calc = calculateChurnRiskV1(signals);
        const stored = await client.query(
          `INSERT INTO business_churn_assessments
             (tenant_id, memory_space_id, account_ref, company_id, rule_version, risk_score, risk_level, signals, signal_families, metrics, evidence, calculated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10::jsonb, $11::jsonb, $12)
           ON CONFLICT (tenant_id, account_ref, rule_version) DO UPDATE SET
             company_id = EXCLUDED.company_id, risk_score = EXCLUDED.risk_score, risk_level = EXCLUDED.risk_level, signals = EXCLUDED.signals,
             signal_families = EXCLUDED.signal_families, metrics = EXCLUDED.metrics, evidence = EXCLUDED.evidence, calculated_at = EXCLUDED.calculated_at, updated_at = now()
           RETURNING calculated_at`,
          [
            tenantId, space, row.account_ref, row.company_id, CHURN_RISK_RULE_VERSION, calc.score, calc.level, JSON.stringify(calc.factors), calc.families,
            JSON.stringify(calc.metrics), JSON.stringify(calc.evidence), now
          ]
        );
        assessments.push({
          account_ref: row.account_ref, company_id: row.company_id, rule_version: CHURN_RISK_RULE_VERSION, risk_score: calc.score, risk_level: calc.level,
          signals: calc.factors, signal_families: calc.families, metrics: calc.metrics, evidence: calc.evidence,
          calculated_at: new Date((stored.rows[0] as { calculated_at: Date }).calculated_at).toISOString()
        });
      }
      // Vurderinger for kontoer som ikke lenger er koblet (eller er koblet om) er foreldet: bort.
      await client.query(
        `DELETE FROM business_churn_assessments WHERE tenant_id = $1 AND rule_version = $2 AND NOT (account_ref = ANY($3::text[]))`,
        [tenantId, CHURN_RISK_RULE_VERSION, accountRefs]
      );
      return { assessed: assessments.length, unlinked_accounts: unlinked, purged_events: purged, assessments };
    });
  }

  /** Siste vurdering(er) for ett selskap (alle koblede kontoer), høyest risiko først. Kun lesing. */
  async assessmentsForCompany(tenantId: string, space: MemorySpace, companyId: string): Promise<ChurnAssessment[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(
        `SELECT account_ref, company_id, rule_version, risk_score, risk_level, signals, signal_families, metrics, evidence, calculated_at
           FROM business_churn_assessments WHERE tenant_id = $1 AND company_id = $2 AND rule_version = $3 ORDER BY risk_score DESC, account_ref ASC`,
        [tenantId, companyId, CHURN_RISK_RULE_VERSION]
      );
      return r.rows.map(mapAssessment);
    });
  }

  /** «Hvem risikerer vi å miste?» - kun lesing, uten pseudonymer. `at_risk` er middels/høy risiko, høyest først. */
  async overview(tenantId: string, space: MemorySpace, options: { minLevel?: Exclude<ChurnLevel, "low">; limit?: number } = {}): Promise<ChurnOverview> {
    const atRisk = await this.listAtRisk(tenantId, space, options);
    const counts = await withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(
        `SELECT count(*) FILTER (WHERE company_id IS NOT NULL)::int AS linked,
                count(*) FILTER (WHERE company_id IS NULL AND last_event_at IS NOT NULL)::int AS unlinked,
                (SELECT count(*)::int FROM business_churn_assessments WHERE tenant_id = $1 AND rule_version = $2) AS assessed
           FROM product_usage_accounts WHERE tenant_id = $1`,
        [tenantId, CHURN_RISK_RULE_VERSION]
      );
      return r.rows[0] as { linked: number; unlinked: number; assessed: number };
    });
    return {
      rule_version: CHURN_RISK_RULE_VERSION,
      at_risk: atRisk.map((a) => ({
        company_id: a.company_id, company_name: a.company_name, risk_score: a.risk_score, risk_level: a.risk_level, signals: a.signals.map((s) => s.label),
        metrics: {
          days_since_last_usage: a.metrics.days_since_last_usage, usage_drop_pct: a.metrics.usage_drop_pct,
          open_support_tickets: a.metrics.open_support_tickets, overdue_invoices: a.metrics.overdue_invoices
        },
        calculated_at: a.calculated_at
      })),
      linked_accounts: counts.linked, assessed_accounts: counts.assessed, unlinked_accounts: counts.unlinked,
      note: "Vurderingene er regelbaserte forslag til oppmerksomhet (churn_risk_v1, terskler er forslag) - ikke avgjørelser. Kontoer uten kobling til et kundeselskap vurderes ikke."
    };
  }

  /** Kunder med forhøyet risiko (middels/høy), høyest først, med selskapsnavn. Kun lesing - grunnlaget for «hvem risikerer vi å miste?». */
  async listAtRisk(
    tenantId: string, space: MemorySpace, options: { minLevel?: Exclude<ChurnLevel, "low">; limit?: number } = {}
  ): Promise<Array<ChurnAssessment & { company_name: string | null }>> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
    const min = options.minLevel === "high" ? CHURN_V1.level_high : CHURN_V1.level_medium;
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const r = await client.query(
        `SELECT a.account_ref, a.company_id, a.rule_version, a.risk_score, a.risk_level, a.signals, a.signal_families, a.metrics, a.evidence, a.calculated_at, c.name AS company_name
           FROM business_churn_assessments a
           LEFT JOIN business_companies c ON c.tenant_id = a.tenant_id AND c.company_id = a.company_id
          WHERE a.tenant_id = $1 AND a.rule_version = $2 AND a.risk_score >= $3
          ORDER BY a.risk_score DESC, a.account_ref ASC LIMIT $4`,
        [tenantId, CHURN_RISK_RULE_VERSION, min, limit]
      );
      return r.rows.map((row) => ({ ...mapAssessment(row), company_name: (row as { company_name: string | null }).company_name }));
    });
  }
}

function mapAssessment(row: unknown): ChurnAssessment {
  const r = row as {
    account_ref: string; company_id: string; rule_version: string; risk_score: string | number; risk_level: ChurnLevel; signals: ScoreFactor[];
    signal_families: string[]; metrics: ChurnMetrics; evidence: ChurnAssessment["evidence"]; calculated_at: Date | string;
  };
  return {
    account_ref: r.account_ref, company_id: r.company_id, rule_version: r.rule_version, risk_score: Number(r.risk_score), risk_level: r.risk_level,
    signals: r.signals, signal_families: r.signal_families as ChurnAssessment["signal_families"], metrics: r.metrics, evidence: r.evidence,
    calculated_at: new Date(r.calculated_at).toISOString()
  };
}
