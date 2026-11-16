import type pg from "pg";
import { claudeBudgetConfigFromEnv, type ClaudeBudgetConfig } from "@jarvis/model-gateway";

/**
 * WP-B4 (D-476): en fake pool for flatene til Claude-kreditten (kontrollsenter, brief, varsler) - tilstandsbærende der det trengs (revisjonsmarkører skrives og leses tilbake, med tenant-RLS modellert via
 * `set_config`), og med knapper for å simulere at en kilde er nede. Ekte SQL mot ekte tabeller, GRANT-er og RLS bevises i `wpb4-claude-budget-db.test.ts` (embedded Postgres som app-rolle).
 *
 * Perioden: 15. nov → 15. des 2026 (30 døgn). Klokka står midt i perioden (etter 15 av 30 døgn, dag 16): kurven er 47 250 øre, 1,3 × kurven 61 425, tempobudsjettet 89 250, kreditten 105 000 øre (100 USD × 10,5 kr).
 */
export const DAY = 86_400_000;
/** 15. november 2026 00:00 Europe/Oslo (CET, UTC+1). */
export const PERIOD_START = Date.UTC(2026, 10, 14, 23, 0, 0);
/** 15 av 30 døgn gått (dag 16): akkurat halvveis. */
export const MID = PERIOD_START + 15 * DAY;
/** Neste fornyelse: 15. desember 2026 00:00 Europe/Oslo. */
export const PERIOD_END = PERIOD_START + 30 * DAY;
export const OWNER_TENANT = "tenant-owner";
export const OWNER_PERSON = "person-owner";

/** Forbruk (øre) som gir hvert nivå halvveis i perioden (se kommentaren over). */
export const SPENT = { zero: 0, on_pace: 40_000, over_50: 55_000, tight: 70_000, over_75: 80_000, over_90: 95_000, exhausted: 105_000 } as const;

export function budgetConfig(env: Record<string, string> = {}): ClaudeBudgetConfig {
  const config = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100", ...env });
  if (config === null) throw new Error("test-oppsett: kreditten må være på");
  return config;
}

export interface AuditRow {
  tenant_id: string;
  person_id: string;
  type: string;
  decision: string | null;
  reason: string | null;
  tool_id: string | null;
  action: string | null;
  payload: Record<string, unknown>;
}

export interface RecordedQuery { sql: string; params: unknown[]; tenant: string | null }

export class BudgetPool {
  /** Anthropic-forbruk (øre) per tenant i inneværende periode (samme tall brukes for «siste 7 døgn»). */
  readonly spend = new Map<string, number>();
  /** Radene `readClaudeUsage` får tilbake (en rad per formål × jobb-id × økt-id). */
  usageRows: Array<Record<string, unknown>> = [];
  /** Radene `readClaudeDecisionCounts` får tilbake (en rad per beslutning × tier). */
  decisionRows: Array<Record<string, unknown>> = [];
  readonly audit: AuditRow[] = [];
  readonly queries: RecordedQuery[] = [];
  failSpend: Error | null = null;
  failUsage: Error | null = null;
  failDecisions: Error | null = null;
  failMarkerRead: Error | null = null;
  failMarkerWrite: Error | null = null;

  pg(): pg.Pool {
    const self = this;
    return {
      // kontrollsentrene leser noen globale tabeller direkte på poolen; ingen av dem hører til kreditten
      query: async () => ({ rows: [] }),
      connect: async () => {
        let tenant: string | null = null;
        return {
          query: async (sql: string, params: unknown[] = []) => {
            const text = sql.trim();
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
            if (text.includes("set_config")) { tenant = String(params[0]); return { rows: [] }; }
            self.queries.push({ sql: text, params, tenant });
            if (text.includes("date_trunc")) return { rows: [{ spent: 0 }] }; // BudgetGuard/dailySpentOre (den eksisterende månedsgrensen), urørt av kreditten
            if (text.includes("FROM cost_events") && text.includes("provider = $4")) {
              if (self.failSpend !== null) throw self.failSpend;
              const v = self.spend.get(tenant ?? "") ?? 0;
              return { rows: [{ window_ore: v, trailing_ore: v }] };
            }
            if (text.includes("FROM cost_events") && text.includes("GROUP BY purpose")) {
              if (self.failUsage !== null) throw self.failUsage;
              return { rows: self.usageRows };
            }
            if (text.includes("FROM audit_events") && text.includes("'claude_budget.decision'")) {
              if (self.failDecisions !== null) throw self.failDecisions;
              return { rows: self.decisionRows };
            }
            if (text.includes("FROM audit_events") && text.includes("'claude_budget.alert'")) {
              if (self.failMarkerRead !== null) throw self.failMarkerRead;
              const windowStart = String(params[0]);
              // RLS: kun denne tenantens rader
              return { rows: self.audit.filter((a) => a.tenant_id === tenant && a.type === "claude_budget.alert" && a.payload["window_start"] === windowStart).map((a) => ({ key: a.payload["key"] })) };
            }
            if (text.includes("INSERT INTO audit_events")) {
              if (self.failMarkerWrite !== null) throw self.failMarkerWrite;
              self.audit.push({
                tenant_id: String(params[0]), person_id: String(params[1]), type: String(params[4]), decision: params[5] === null ? null : String(params[5]), reason: params[6] === null ? null : String(params[6]),
                tool_id: params[7] === null ? null : String(params[7]), action: params[8] === null ? null : String(params[8]), payload: JSON.parse(String(params[10])) as Record<string, unknown>
              });
              return { rows: [] };
            }
            return { rows: [] };
          },
          release: () => undefined
        };
      }
    } as unknown as pg.Pool;
  }

  /** Spørringene som leste Claude-forbruket (eller noe annet fra kreditten) - brukes til å bevise «ingen lesing» når flagget er AV eller mottakeren er en skymodell. */
  claudeQueries(): RecordedQuery[] {
    return this.queries.filter((q) => q.sql.includes("provider = $4") || q.sql.includes("provider = $3") || q.sql.includes("claude_budget."));
  }
}
