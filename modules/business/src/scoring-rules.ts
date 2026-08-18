import type {
  EvidenceRef, LeadScoringSignals, OpportunityScoringSignals, ScoreCalculation, ScoreFactor
} from "./scoring-types.ts";

/**
 * UA-3 profiling/scoring slice (D-61) - REN, deterministisk, DB-uavhengig
 * regelmotor (§7/§8 i byggeordren: "Build deterministic scoring first" /
 * "If deterministic evidence is sufficient: do not call a model"). INGEN
 * AI Mesh-/ModelGateway-import her - v1 er BEVISST 100% deterministisk,
 * samme valg som open-loop-deteksjon (D-53) og Gmail/Calendar-entitets-
 * gjenkjenning (D-57). `detection_method` i skjemaet har (som
 * `business_open_loops`) et ubrukt `ai_assisted`-medlem for en fremtidig
 * regel der ekte semantisk tvetydighet faktisk krever et modellkall - se
 * Q-25.
 *
 * Versjonering (§17): endring av vektene under MÅ skje som en NY konstant
 * (`lead_priority_v2` osv.), ALDRI en stille mutasjon av v1 - eksisterende
 * persisterte `business_scores`-rader med `rule_version='lead_priority_v1'`
 * skal for alltid forbli forklarbare med DISSE reglene.
 */
export const LEAD_PRIORITY_RULE_VERSION = "lead_priority_v1";
export const OPPORTUNITY_RISK_RULE_VERSION = "opportunity_risk_v1";

/**
 * §4/§5/§11 i byggeordren: whitelist over TILLATTE, gjennomsiktige
 * forretnings-tilstandsfaktorer. Scoring-motoren tar `LeadScoringSignals`/
 * `OpportunityScoringSignals` som input - disse typene inneholder KUN
 * lead-/opportunity-tilstand + tellinger fra business_activities/
 * business_followups/business_open_loops (data Business OS allerede eier).
 * INGEN kontakt-/person-felt (navn, e-post, tittel, demografi) kan
 * strukturelt naa denne motoren - se scoring-service.ts sin signal-
 * innsamling, som ALDRI spoerrer business_contacts/people utover en
 * eksisterende owner_person_id-referanse (identitet, ikke et scoring-input).
 */
export const ALLOWED_LEAD_FACTOR_CODES = [
  "status_new", "status_contacted", "status_qualified", "status_terminal",
  "has_active_opportunity", "recent_activity_7d", "stale_30d",
  "open_followup", "overdue_followup"
] as const;

export const ALLOWED_OPPORTUNITY_FACTOR_CODES = [
  "stage_new", "stage_qualified", "stage_proposal", "stage_negotiation", "stage_terminal",
  "stale_14d", "no_open_followup", "overdue_followup", "stalled_open_loop"
] as const;

/**
 * §4 i byggeordren: eksplisitt forbudte trekk-kategorier. Brukes til å
 * strukturelt bevise (test H) at INGEN faktor-kode noensinne kan referere
 * en beskyttet/sensitiv persontrekk-kategori - selv om noen i fremtiden
 * legger til en ny faktor-kode, vil denne sjekken feile FØR den kan skrives
 * til `business_scores`.
 */
const PROHIBITED_FACTOR_KEYWORDS = [
  "race", "ethnic", "religio", "politi", "sexual", "orientation", "health", "disab",
  "genetic", "biometric", "union", "personality", "psycholog", "trust", "intellig",
  "wealth", "income", "socioeconomic", "gender", "marital"
];

export function assertNoProhibitedFactorCodes(codes: readonly string[]): void {
  for (const code of codes) {
    const lower = code.toLowerCase();
    for (const keyword of PROHIBITED_FACTOR_KEYWORDS) {
      if (lower.includes(keyword)) throw new Error(`prohibited_factor_code_detected:${code}`);
    }
  }
}
assertNoProhibitedFactorCodes(ALLOWED_LEAD_FACTOR_CODES);
assertNoProhibitedFactorCodes(ALLOWED_OPPORTUNITY_FACTOR_CODES);

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Lead-status-basert basisvekt - kun de tre ikke-terminale statusene skal noensinne score > 0. */
const LEAD_STATUS_WEIGHT: Record<string, number> = { new: 10, contacted: 20, qualified: 30 };
const OPPORTUNITY_STAGE_WEIGHT: Record<string, number> = { new: 10, qualified: 20, proposal: 35, negotiation: 45 };

export function calculateLeadPriorityV1(signals: LeadScoringSignals): ScoreCalculation {
  const factors: ScoreFactor[] = [];
  const evidence: EvidenceRef[] = [];

  if (signals.status === "disqualified" || signals.status === "converted") {
    factors.push({
      code: "status_terminal", label: `Lead er i terminal status (${signals.status}) - ikke aktivt prioritert`,
      weight: 0, contribution: 0
    });
    return { score: 0, factors, evidence };
  }

  let score = 0;
  const statusContribution = LEAD_STATUS_WEIGHT[signals.status] ?? 10;
  factors.push({ code: `status_${signals.status}`, label: `Lead-status: ${signals.status}`, weight: statusContribution, contribution: statusContribution });
  score += statusContribution;

  if (signals.has_active_opportunity) {
    factors.push({ code: "has_active_opportunity", label: "Har en aktiv, ikke-lukket opportunity koblet", weight: 15, contribution: 15 });
    score += 15;
  }
  if (signals.has_recent_activity_7d) {
    factors.push({ code: "recent_activity_7d", label: "Aktivitet registrert siste 7 dager", weight: 15, contribution: 15 });
    score += 15;
    evidence.push(...signals.recent_activity_ids.map((id): EvidenceRef => ({ type: "activity", id })));
  }
  if (signals.is_stale_30d) {
    factors.push({ code: "stale_30d", label: "Ingen aktivitet registrert siste 30 dager", weight: -15, contribution: -15 });
    score -= 15;
  }
  if (signals.has_overdue_followup) {
    factors.push({ code: "overdue_followup", label: "Har en forfalt, aapen oppfoelging - trenger oppmerksomhet", weight: 20, contribution: 20 });
    score += 20;
    evidence.push(...signals.open_followup_ids.map((id): EvidenceRef => ({ type: "followup", id })));
  } else if (signals.has_open_followup) {
    factors.push({ code: "open_followup", label: "Har en aapen, ikke-forfalt oppfoelging", weight: 5, contribution: 5 });
    score += 5;
    evidence.push(...signals.open_followup_ids.map((id): EvidenceRef => ({ type: "followup", id })));
  }

  assertNoProhibitedFactorCodes(factors.map((f) => f.code));
  return { score: clampScore(score), factors, evidence };
}

export function calculateOpportunityRiskV1(signals: OpportunityScoringSignals): ScoreCalculation {
  const factors: ScoreFactor[] = [];
  const evidence: EvidenceRef[] = [];

  if (signals.stage === "won" || signals.stage === "lost") {
    factors.push({
      code: "stage_terminal", label: `Opportunity er i terminal stage (${signals.stage}) - ikke aktivt risikovurdert`,
      weight: 0, contribution: 0
    });
    return { score: 0, factors, evidence };
  }

  let score = 0;
  const stageContribution = OPPORTUNITY_STAGE_WEIGHT[signals.stage] ?? 10;
  factors.push({
    code: `stage_${signals.stage}`,
    label: `Pipeline-stadium: ${signals.stage} (naermere lukking = hoeyere potensielt tap ved stagnasjon)`,
    weight: stageContribution, contribution: stageContribution
  });
  score += stageContribution;

  if (signals.is_stale_14d) {
    factors.push({ code: "stale_14d", label: "Ingen oppdatering registrert siste 14 dager", weight: 20, contribution: 20 });
    score += 20;
  }
  if (!signals.has_open_followup) {
    factors.push({ code: "no_open_followup", label: "Ingen aapen oppfoelging - ingen har eierskap paa neste steg", weight: 15, contribution: 15 });
    score += 15;
  }
  if (signals.has_overdue_followup) {
    factors.push({ code: "overdue_followup", label: "Har en forfalt oppfoelging", weight: 15, contribution: 15 });
    score += 15;
    evidence.push(...signals.overdue_followup_ids.map((id): EvidenceRef => ({ type: "followup", id })));
  }
  if (signals.has_stalled_open_loop) {
    factors.push({ code: "stalled_open_loop", label: "Allerede flagget som stagnert open loop av OpenLoopService", weight: 25, contribution: 25 });
    score += 25;
    evidence.push(...signals.stalled_open_loop_ids.map((id): EvidenceRef => ({ type: "open_loop", id })));
  }

  assertNoProhibitedFactorCodes(factors.map((f) => f.code));
  return { score: clampScore(score), factors, evidence };
}
