import type { ScoreFactor } from "./scoring-types.ts";

/**
 * WP-D2 (UA-3 «churn/product usage», migrasjon 090): typer for deterministiske churn-signaler. Vurderingen gjelder en KUNDEKONTO (konto -> selskap), aldri en person:
 * `user_ref` leses av ingen regel, og ingen signal kan referere en beskyttet persontrekk-kategori (se `assertNoProhibitedFactorCodes` i churn-rules.ts).
 */

export type ChurnLevel = "low" | "medium" | "high";
/** Signalfamiliene reglene henter fra. Flere UAVHENGIGE familier som slår ut samtidig gir høyere sikkerhet (JARVIS-045). */
export type ChurnFamily = "usage" | "support" | "billing";

/** Aggregerte, rå mål en regel ser. Tall og id-er - aldri persondata eller fritekst. */
export interface ChurnSignals {
  /** Hele dager siden siste `usage`-hendelse. `null` = kontoen har aldri hatt bruk registrert. */
  days_since_last_usage: number | null;
  /** Hele dager siden første `usage`-hendelse. `null` = aldri bruk. */
  account_age_days: number | null;
  /** Sum `quantity` siste 14 dager (til og med nå). */
  usage_recent_14d: number;
  /** Sum `quantity` de 14 dagene før det. */
  usage_baseline_prev_14d: number;
  open_support_tickets: number;
  high_priority_open_tickets: number;
  /** Antall forfalte fakturaer i SISTE `billing_status`-hendelse (maks 45 dager gammel). `null` = ukjent (ingen ferske data). */
  overdue_invoices: number | null;
  /** Løse pekere (maks 5) - bevis, ikke kopi. */
  support_ticket_ids: string[];
  billing_event_id: string | null;
}

export type ChurnEvidenceRef = { type: "support_ticket" | "billing_event"; id: string };

/** Rent, DB-uavhengig beregningsresultat (samme form som `ScoreCalculation` i scoring-types.ts, utvidet med nivå/familier/mål). */
export interface ChurnCalculation {
  score: number;
  level: ChurnLevel;
  factors: ScoreFactor[];
  families: ChurnFamily[];
  evidence: ChurnEvidenceRef[];
  metrics: ChurnMetrics;
}

export interface ChurnMetrics {
  /** `true` når kontoen mangler data til en vurdering (ingen bruk, ingen faktura-/supportdata). Da er score 0 - «ingen data» er ikke «høy risiko». */
  insufficient_data: boolean;
  days_since_last_usage: number | null;
  account_age_days: number | null;
  usage_recent_14d: number;
  usage_baseline_prev_14d: number;
  /** Fall i bruk siste 14 dager mot forrige 14, i hele prosent (0-100). `null` når grunnlaget er for lite eller bruken ikke har falt. */
  usage_drop_pct: number | null;
  open_support_tickets: number;
  high_priority_open_tickets: number;
  overdue_invoices: number | null;
}

export interface ChurnAssessment {
  account_ref: string;
  company_id: string;
  rule_version: string;
  risk_score: number;
  risk_level: ChurnLevel;
  signals: ScoreFactor[];
  signal_families: ChurnFamily[];
  metrics: ChurnMetrics;
  evidence: ChurnEvidenceRef[];
  calculated_at: string;
}

export interface ChurnSweepResult {
  /** Antall koblede kontoer som ble vurdert. */
  assessed: number;
  /** Kontoer med data, men uten kobling til et selskap - ingen vurdering, ingen loop (eieren må koble dem). */
  unlinked_accounts: number;
  /** Hendelser slettet av oppbevaringen (eldre enn 400 dager). */
  purged_events: number;
  assessments: ChurnAssessment[];
}
