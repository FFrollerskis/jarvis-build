import { assertNoProhibitedFactorCodes } from "./scoring-rules.ts";
import type { ScoreFactor } from "./scoring-types.ts";
import type { ChurnCalculation, ChurnEvidenceRef, ChurnFamily, ChurnLevel, ChurnMetrics, ChurnSignals } from "./churn-types.ts";

/**
 * WP-D2 (UA-3 «churn/product usage»): REN, deterministisk, DB-uavhengig regelmotor for churn-risiko på en KUNDEKONTO (samme stil som scoring-rules.ts: versjonert
 * konstant, hvitelistede faktorkoder, forklarbart resultat, ingen modellkall). Hver score lister signalene som ga den (kode, vekt, begrunnelse).
 *
 * Versjonering: endrede terskler/vekter MÅ være en NY konstant (`churn_risk_v2`), aldri en stille mutasjon av v1 - en lagret `business_churn_assessments`-rad med
 * `rule_version = 'churn_risk_v1'` skal for alltid kunne forklares med DISSE reglene. Verdiene under er KALIBRERINGSFORSLAG (NEEDS_TOBIAS); kalibreringsrapporten
 * (confidence.ts) sammenligner forutsagt mot utfall og er grunnlaget for en v2.
 *
 * Personvern: input er KUN aggregerte tall per konto + id-er til supportsaker/faktura-hendelse. Ingen rå personopplysninger, ingen `user_ref`. «Ingen data» gir score 0
 * (`insufficient_data`) - fravær av data er aldri i seg selv et risikosignal.
 */
export const CHURN_RISK_RULE_VERSION = "churn_risk_v1";

export const CHURN_V1 = {
  /** Dager uten bruk: middels / høy. */
  inactive_medium_days: 14,
  inactive_high_days: 30,
  /** Sammenligningsvindu (dager): «siste» mot «forrige». */
  window_days: 14,
  /** Fall i bruk vurderes bare med nok grunnlag - ellers er prosentene støy. */
  drop_min_baseline: 20,
  drop_min_account_age_days: 28,
  drop_medium_pct: 40,
  drop_high_pct: 70,
  tickets_many: 3,
  invoices_many: 3,
  /** En faktura-status eldre enn dette sier ingenting om nå. */
  billing_max_age_days: 45,
  /** Nivågrenser for score 0-100. */
  level_high: 55,
  level_medium: 30,
  weights: {
    inactive_14d: 25,
    inactive_30d: 45,
    usage_drop_40pct: 15,
    usage_drop_70pct: 30,
    open_support_tickets: 10,
    many_open_support_tickets: 20,
    high_priority_ticket_open: 10,
    overdue_invoice: 15,
    many_overdue_invoices: 25
  }
} as const;

export const ALLOWED_CHURN_FACTOR_CODES = [
  "inactive_14d", "inactive_30d", "usage_drop_40pct", "usage_drop_70pct",
  "open_support_tickets", "many_open_support_tickets", "high_priority_ticket_open",
  "overdue_invoice", "many_overdue_invoices"
] as const;
// Samme strukturelle forbud som lead-/opportunity-scoring: ingen faktorkode kan noensinne referere en beskyttet persontrekk-kategori.
assertNoProhibitedFactorCodes(ALLOWED_CHURN_FACTOR_CODES);

const clampScore = (n: number): number => Math.max(0, Math.min(100, n));

export function churnLevelForScore(score: number): ChurnLevel {
  if (score >= CHURN_V1.level_high) return "high";
  if (score >= CHURN_V1.level_medium) return "medium";
  return "low";
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function factor(code: (typeof ALLOWED_CHURN_FACTOR_CODES)[number], label: string): ScoreFactor {
  const weight = CHURN_V1.weights[code];
  return { code, label, weight, contribution: weight };
}

/** Fall i bruk i hele prosent når grunnlaget er stort nok, ellers `null`. 100 når siste vindu er tomt (opplysende; inaktivitet dekker det i scoren). */
function usageDropPct(signals: ChurnSignals): number | null {
  if (signals.usage_baseline_prev_14d < CHURN_V1.drop_min_baseline) return null;
  if (signals.account_age_days === null || signals.account_age_days < CHURN_V1.drop_min_account_age_days) return null;
  if (signals.usage_recent_14d >= signals.usage_baseline_prev_14d) return null;
  // Heltallsaritmetikk (ikke 1 - r/b i flyttall): (1 - 0.55) * 100 blir 44.99999999999999 og ville gitt 44 i stedet for 45 på en eksakt prosentgrense.
  return Math.floor(((signals.usage_baseline_prev_14d - signals.usage_recent_14d) * 100) / signals.usage_baseline_prev_14d);
}

export function calculateChurnRiskV1(signals: ChurnSignals): ChurnCalculation {
  const hasUsage = signals.days_since_last_usage !== null;
  const dropPct = hasUsage ? usageDropPct(signals) : null;
  const metrics: ChurnMetrics = {
    insufficient_data: !hasUsage,
    days_since_last_usage: signals.days_since_last_usage,
    account_age_days: signals.account_age_days,
    usage_recent_14d: signals.usage_recent_14d,
    usage_baseline_prev_14d: signals.usage_baseline_prev_14d,
    usage_drop_pct: dropPct,
    open_support_tickets: signals.open_support_tickets,
    high_priority_open_tickets: signals.high_priority_open_tickets,
    overdue_invoices: signals.overdue_invoices
  };
  // Uten en eneste bruksobservasjon kan vi ikke si noe om produktbruk: support-/faktura-signaler alene er ikke et churn-signal (konservativt, ingen falsk alarm).
  if (!hasUsage) return { score: 0, level: "low", factors: [], families: [], evidence: [], metrics };

  const factors: ScoreFactor[] = [];
  const families = new Set<ChurnFamily>();
  const evidence: ChurnEvidenceRef[] = [];
  const days = signals.days_since_last_usage as number;

  // --- Bruk -----------------------------------------------------------------------------------------------------------------------------------------
  if (days >= CHURN_V1.inactive_high_days) {
    factors.push(factor("inactive_30d", `Ingen produktbruk på ${days} dager`));
    families.add("usage");
  } else if (days >= CHURN_V1.inactive_medium_days) {
    factors.push(factor("inactive_14d", `Ingen produktbruk på ${days} dager`));
    families.add("usage");
  } else if (dropPct !== null && signals.usage_recent_14d > 0) {
    // Delvis fall (siste vindu har bruk). Er vinduet tomt dekker inaktivitet-faktorene over det, og vi teller ikke samme fenomen to ganger.
    if (dropPct >= CHURN_V1.drop_high_pct) {
      factors.push(factor("usage_drop_70pct", `Bruken er ned ${dropPct} % siste ${CHURN_V1.window_days} dager (${signals.usage_recent_14d} mot ${signals.usage_baseline_prev_14d})`));
      families.add("usage");
    } else if (dropPct >= CHURN_V1.drop_medium_pct) {
      factors.push(factor("usage_drop_40pct", `Bruken er ned ${dropPct} % siste ${CHURN_V1.window_days} dager (${signals.usage_recent_14d} mot ${signals.usage_baseline_prev_14d})`));
      families.add("usage");
    }
  }

  // --- Support --------------------------------------------------------------------------------------------------------------------------------------
  const tickets = signals.open_support_tickets;
  if (tickets >= CHURN_V1.tickets_many) {
    factors.push(factor("many_open_support_tickets", `${tickets} åpne supportsaker`));
    families.add("support");
  } else if (tickets >= 1) {
    factors.push(factor("open_support_tickets", `${tickets} ${plural(tickets, "åpen supportsak", "åpne supportsaker")}`));
    families.add("support");
  }
  if (signals.high_priority_open_tickets >= 1) {
    const h = signals.high_priority_open_tickets;
    factors.push(factor("high_priority_ticket_open", `${h} åpen${h === 1 ? "" : "e"} ${plural(h, "sak", "saker")} med høy prioritet`));
    families.add("support");
  }
  if (families.has("support")) for (const id of signals.support_ticket_ids.slice(0, 5)) evidence.push({ type: "support_ticket", id });

  // --- Fakturering ----------------------------------------------------------------------------------------------------------------------------------
  const overdue = signals.overdue_invoices;
  if (overdue !== null && overdue >= CHURN_V1.invoices_many) {
    factors.push(factor("many_overdue_invoices", `${overdue} forfalte fakturaer`));
    families.add("billing");
  } else if (overdue !== null && overdue >= 1) {
    factors.push(factor("overdue_invoice", `${overdue} ${plural(overdue, "forfalt faktura", "forfalte fakturaer")}`));
    families.add("billing");
  }
  if (families.has("billing") && signals.billing_event_id) evidence.push({ type: "billing_event", id: signals.billing_event_id });

  assertNoProhibitedFactorCodes(factors.map((f) => f.code));
  const score = clampScore(factors.reduce((sum, f) => sum + f.contribution, 0));
  return { score, level: churnLevelForScore(score), factors, families: [...families], evidence, metrics };
}

/** Menneskelesbar begrunnelse til open loop-en: nivå, score og signalene i den rekkefølgen reglene evaluerer dem. Ingen persondata. */
export function describeChurnRisk(calc: Pick<ChurnCalculation, "score" | "level" | "factors">): string {
  const word = calc.level === "high" ? "høy" : calc.level === "medium" ? "middels" : "lav";
  return `Churn-risiko ${word} (${calc.score}/100): ${calc.factors.map((f) => f.label).join("; ")}.`;
}

/** Anbefalt neste handling for en churn-loop - deterministisk tekst (ingen modell), tilpasset signalene. */
export function churnNextAction(calc: Pick<ChurnCalculation, "factors">): string {
  const codes = new Set(calc.factors.map((f) => f.code));
  const parts = ["Ta kontakt med kunden og avklar bruk og eventuelle hindringer"];
  if (codes.has("overdue_invoice") || codes.has("many_overdue_invoices")) parts.push("følg opp forfalte fakturaer");
  if (codes.has("open_support_tickets") || codes.has("many_open_support_tickets") || codes.has("high_priority_ticket_open")) parts.push("løs de åpne supportsakene");
  return `${parts.join("; ")}.`;
}
