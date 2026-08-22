/**
 * D-106 HOST-FIX (2026-08-22) - "LARGE-DECISION TRIGGER" §krav fra Tobias:
 * automatisk høy-innvirkning-beslutning-klassifisering for AI Council, som
 * en distinkt trigger-kilde VED SIDEN AV eksplisitt brukertrigger (aldri en
 * erstatning for den). Reparerer et reelt gap i den opprinnelige D-106-
 * leveransen (som KUN implementerte eksplisitt trigger) - PR #51, samme
 * gren, ingen ny PR.
 *
 * **Aldri en LLM som avgjør dette selv** (samme §35-prinsipp som
 * `override-parser.ts`/`AiRouter` - "en modell kan aldri velge seg selv"):
 * 100% deterministisk mønstergjenkjenning mot teksten, INGEN modellkall.
 * "Policy-assisted" betyr her at terskler/mønstre er eksplisitte,
 * konfigurerbare policy-konstanter (f.eks. `FINANCIAL_MATERIALITY_
 * THRESHOLD_NOK`) - IKKE en fabrikkert påstand om faktisk finansiell/
 * juridisk ekspertise.
 *
 * **Risikoklasse (A-D, `modules/tool-gateway`) og beslutnings-VIKTIGHET er
 * BEVISST distinkte dimensjoner** (§ordre-krav: "Do NOT equate all class-D
 * actions with Council"): denne klassifisereren har INGEN kobling til
 * `capability_class` i det hele tatt - den ser KUN på selve samtaleteksten.
 * En klasse D-handling (f.eks. "restart the jarvis-sentinel-test container",
 * D-105) trigger IKKE Council med mindre teksten OGSÅ inneholder et
 * høy-innvirkning-signal (f.eks. "production"/"credentials"/"architecture").
 *
 * "Core dependency"-signalet gjenbruker BEVISST samme terminologi som D-64
 * sin `CORE_DEPENDENCY_DECISION_REQUIRED`-gate (docs/DECISIONS_AND_
 * ASSUMPTIONS.md) - et spørsmål om å gjøre en leverandør til en kjerne-
 * avhengighet ER per definisjon en arkitektonisk høy-innvirkning-beslutning.
 */
export type DecisionImportance = "ROUTINE" | "SIGNIFICANT" | "HIGH_IMPACT_DECISION";

export interface DecisionSignal {
  name: string;
  matched_text: string;
}

export interface DecisionClassification {
  decision_importance: DecisionImportance;
  matched_signals: DecisionSignal[];
  /** Deduplisert liste av signalnavn - samme informasjon som `matched_signals`, i det auditerbare formatet ordren eksplisitt ba om. */
  trigger_reasons: string[];
  classifier_version: string;
}

/** Endres KUN når mønstrene under endres reelt - auditerbar versjonering, aldri stille endret klassifiseringsatferd. */
export const CLASSIFIER_VERSION = "d106-decision-importance-v1";

/**
 * Materialitetsterskel for "financial magnitude" (§ordren: "material
 * financial consequence"). Eksplisitt, konfigurerbar policy-konstant - IKKE
 * en påstand om faktisk valutakurs/regnskapsekspertise. Beløp i ULIKE
 * valutaer (NOK/USD/EUR/GBP) sammenlignes mot SAMME nominelle terskel uten
 * valutakonvertering - en kjent, eksplisitt forenkling (se filens
 * DEFERRED-kommentar nederst), ikke skjult.
 */
export const FINANCIAL_MATERIALITY_THRESHOLD = 100_000;

interface SignalCategory {
  name: string;
  patterns: RegExp[];
}

const NUMBER_PATTERN = "\\d{1,3}(?:[.,]\\d{3})+|\\d{4,}";
const CURRENCY_PATTERN = "(nok|kr\\.?|kroner|usd|eur|gbp|\\$|€|£)";
const FINANCIAL_AFTER = new RegExp(`\\b(${NUMBER_PATTERN})\\s*${CURRENCY_PATTERN}\\b`, "i");
const FINANCIAL_BEFORE = new RegExp(`${CURRENCY_PATTERN}\\s*(${NUMBER_PATTERN})\\b`, "i");

function parseAmount(numStr: string): number | undefined {
  const cleaned = numStr.replace(/[.,]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** Deterministisk beløps-uthenting - ALDRI gjettet, kun det som faktisk står i teksten. */
function extractFinancialAmount(text: string): { raw: string; value: number } | undefined {
  const after = text.match(FINANCIAL_AFTER);
  if (after) {
    const value = parseAmount(after[1] as string);
    if (value !== undefined) return { raw: after[0], value };
  }
  const before = text.match(FINANCIAL_BEFORE);
  if (before) {
    const value = parseAmount(before[2] as string);
    if (value !== undefined) return { raw: before[0], value };
  }
  return undefined;
}

/** §ordre "irreversible infrastructure change" / "irreversible/destructive action". */
const IRREVERSIBLE_DESTRUCTIVE: SignalCategory = {
  name: "irreversible_destructive_action",
  patterns: [/\birreversibl[et]?\b/i, /\bpermanent(ly)?\s+delet/i, /\bwipe\s+all\b/i, /\bslett(e)?\s+(alt|permanent)\b/i, /\bugjenkallelig\b/i]
};

/** §ordre "important architecture decision" / "core dependency" - gjenbruker D-64s eksakte terminologi. */
const ARCHITECTURE_CORE_DEPENDENCY: SignalCategory = {
  name: "architecture_core_dependency_impact",
  patterns: [
    /\bcore\s+dependency\b/i,
    /\bkjerneavhengighet\b/i,
    /\bcanonical\s+(memory\s+)?architecture\b/i,
    /\b(replace|redesign|rewrite|erstatte|bygge\s+om)\b[^.?!]{0,50}\b(architecture|arkitektur)\b/i,
    /\b(replace|erstatte)\b[^.?!]{0,50}\bcanonical\b/i
  ]
};

/** §ordre "irreversible infrastructure change" / "major production incident decision" (infra-siden). */
const PRODUCTION_INFRA_IMPACT: SignalCategory = {
  name: "production_infrastructure_impact",
  patterns: [
    /\b(migrate|migrere|migrering)\b[^.?!]{0,60}\bproduction\b/i,
    /\bproduction\b[^.?!]{0,60}\b(migrate|migration|migrere)\b/i,
    /\bproduksjon\b[^.?!]{0,60}\b(migrere|migrering)\b/i
  ]
};

/** §ordre "high-risk security change". */
const SECURITY_CREDENTIAL_IMPACT: SignalCategory = {
  name: "security_credential_impact",
  patterns: [
    /\b(rotate|revoke|reset)\b[^.?!]{0,40}\b(credential|secret|api[- ]?key|password|token)/i,
    /\b(roter|tilbakekall|nullstill)\b[^.?!]{0,40}\b(legitimasjon|hemmelighet|passord|n[øo]kkel|tilgang)/i
  ]
};

/** §ordre "consequential business decision" / "broad strategy choice". */
const BUSINESS_STRATEGY_CONSEQUENCE: SignalCategory = {
  name: "business_strategy_consequence",
  patterns: [
    /\bacquisition\b/i,
    /\boppkj[øo]p\b/i,
    /\bmerger\b/i,
    /\bfusjon\b/i,
    /\bbusiness\s+strategy\b/i,
    /\bforretningsstrategi\b/i,
    /\bstrategic\s+(direction|shift|pivot)\b/i
  ]
};

/** §ordre "consequential external commitment". */
const EXTERNAL_COMMITMENT: SignalCategory = {
  name: "consequential_external_commitment",
  patterns: [/\bsign(ing)?\s+(a\s+|the\s+)?contract\b/i, /\bsignere\s+kontrakt\b/i, /\blegally\s+binding\b/i, /\bjuridisk\s+bindende\b/i]
};

/** §ordre "major incident/recovery decision". */
const MAJOR_INCIDENT_RECOVERY: SignalCategory = {
  name: "major_incident_recovery_decision",
  patterns: [/\b(severe|alvorlig|critical|kritisk)\b[^.?!]{0,30}\b(production\s+)?incident\b/i, /\brecovery\s+strateg(y|i)\b/i, /\bgjenopprettingsstrategi\b/i]
};

/** §ordre "explicit owner language indicating major decision". */
const EXPLICIT_MAJOR_DECISION_LANGUAGE: SignalCategory = {
  name: "explicit_major_decision_language",
  patterns: [
    /\bmajor\s+decision\b/i,
    /\b(stor|viktig)\s+beslutning\b/i,
    /\bhigh[- ]risk\b/i,
    /\bh[øo]y\s+risiko\b/i,
    /\birreversible\s+infrastructure\s+change\b/i,
    /\bconsequential\b/i
  ]
};

const HARD_CATEGORIES: SignalCategory[] = [
  IRREVERSIBLE_DESTRUCTIVE,
  ARCHITECTURE_CORE_DEPENDENCY,
  PRODUCTION_INFRA_IMPACT,
  SECURITY_CREDENTIAL_IMPACT,
  BUSINESS_STRATEGY_CONSEQUENCE,
  EXTERNAL_COMMITMENT,
  MAJOR_INCIDENT_RECOVERY,
  EXPLICIT_MAJOR_DECISION_LANGUAGE
];

/** Svakere signaler - IKKE alene nok til å trigge Council (unngår falske positiver/kostbar femdobbel spend), men synlig som SIGNIFICANT for fremtidig policy-innstramming. */
const WEAK_CATEGORIES: SignalCategory[] = [
  { name: "budget_mention", patterns: [/\bbudget\b/i, /\bbudsjett\b/i] },
  { name: "policy_change_mention", patterns: [/\bpolicy\s+change\b/i, /\bpolicyendring\b/i] },
  { name: "significance_language", patterns: [/\bsignificant\b/i, /\bbetydelig\b/i] }
];

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return undefined;
}

/**
 * Deterministisk klassifisering. Samme input gir ALLTID samme output (rene
 * regex-matcher, ingen tilstand, ingen tilfeldighet, ingen modellkall).
 */
export function classifyDecisionImportance(text: string): DecisionClassification {
  const matched: DecisionSignal[] = [];

  const amount = extractFinancialAmount(text);
  if (amount && amount.value >= FINANCIAL_MATERIALITY_THRESHOLD) {
    matched.push({ name: "financial_magnitude", matched_text: amount.raw });
  }

  for (const category of HARD_CATEGORIES) {
    const hit = firstMatch(text, category.patterns);
    if (hit) matched.push({ name: category.name, matched_text: hit });
  }

  if (matched.length > 0) {
    return {
      decision_importance: "HIGH_IMPACT_DECISION",
      matched_signals: matched,
      trigger_reasons: [...new Set(matched.map((m) => m.name))],
      classifier_version: CLASSIFIER_VERSION
    };
  }

  const weak: DecisionSignal[] = [];
  for (const category of WEAK_CATEGORIES) {
    const hit = firstMatch(text, category.patterns);
    if (hit) weak.push({ name: category.name, matched_text: hit });
  }
  if (weak.length > 0) {
    return {
      decision_importance: "SIGNIFICANT",
      matched_signals: weak,
      trigger_reasons: [...new Set(weak.map((m) => m.name))],
      classifier_version: CLASSIFIER_VERSION
    };
  }

  return { decision_importance: "ROUTINE", matched_signals: [], trigger_reasons: [], classifier_version: CLASSIFIER_VERSION };
}

/**
 * Eksplisitt DEFERRED (Q-26-ærlighet, IKKE skjult - jf. filens topp-kommentar):
 * (1) INGEN valutakonvertering - et beløp i USD/EUR/GBP sammenlignes mot
 *     SAMME nominelle terskel som NOK, ikke en reell kryssvaluta-vurdering.
 * (2) INGEN "million"/"milliard"/"million"-multiplikator-parsing (f.eks.
 *     "2 million NOK" gir INGEN treff i dagens mønstre) - kun eksplisitte
 *     tall med tusen-separator eller ≥4 siffer.
 * (3) Terskelen (100 000) er en ENKELT global konstant, IKKE per-tenant/
 *     per-policy-konfigurerbar ennå.
 * Ingen av disse er skjulte begrensninger - alle er eksplisitt dokumentert
 * her og i D-106 sin closeout-rapport.
 */
