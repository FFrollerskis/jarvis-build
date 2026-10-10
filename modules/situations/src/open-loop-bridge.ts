import type { BusinessOpenLoop, OpenLoopType } from "@jarvis/business";
import type { SituationCandidateInput } from "./types.ts";

/**
 * UA-10 P1 AKTIVERING (D-160): den FØRSTE live kilden til
 * `SituationEngine.evaluateCandidate()` - en REN, deterministisk bro fra
 * `business_open_loops` (UA-3/UA-4/UA-6-detektorene som ALLEREDE finnes)
 * til `situations`. INGEN ny anomali-detektor oppfinnes her (design-notatet
 * §5 står): broen OVERSETTER en allerede-detektert open loop til
 * situasjonskontrakten, og ingenting annet.
 *
 * Ren funksjon, ingen I/O - `runSituationSweep()` (sweep.ts) er den som
 * faktisk leser loops og kaller motoren. Alt her er testbart uten database.
 *
 * DOMENE-KARTLEGGINGEN er UTTØMMENDE over `OpenLoopType` (`never`-sjekken i
 * `domainForLoopType()`): en NY loop-type i `@jarvis/business` uten en
 * eksplisitt domene-avgjørelse her feiler typecheck - den kan ALDRI stille
 * havne i et tilfeldig domene som eieren aldri pauset/bandt en policy for.
 * Domenenavnene er de SAMME fri-tekst-navnene `DomainPauseRegistry` og
 * `situation_autonomy_policies` bruker ('spend','pipeline','deadlines',...).
 */
export type BridgedSituationDomain = "pipeline" | "support" | "deadlines" | "spend" | "product" | "operations" | "retention";

/** Prefiks på `detection_key` slik at en bro-produsert situasjon ALDRI kolliderer med en kandidat en fremtidig annen kilde (vision/helse/lokasjon) sender med samme rå nøkkel. */
export const OPEN_LOOP_DETECTION_KEY_PREFIX = "open_loop:";

export function domainForLoopType(loopType: OpenLoopType): BridgedSituationDomain {
  switch (loopType) {
    case "overdue_followup":
    case "stalled_opportunity":
      return "pipeline";
    case "support_ticket_needs_reply":
    case "support_ticket_overdue":
    case "support_ticket_unassigned":
    case "support_ticket_waiting_internal":
      return "support";
    case "contract_renewal_due":
    case "contract_termination_deadline":
    case "contract_obligation_due":
    case "contract_review_required":
      return "deadlines";
    case "marketing_spend_anomaly":
    case "payment_intent_anomaly":
    case "payment_intent_reconciliation_mismatch":
    case "finance_spend_unexpected":
    case "finance_spend_amount_deviation":
    case "finance_recurring_charge_missing":
    case "finance_recurring_charge_duplicate":
    case "finance_spend_correction_conflict":
    case "bank_transaction_unmatched":
    case "bank_consent_attention":
    case "card_anomaly_attention":
    case "finance_procurement_missing":
      return "spend";
    case "product_item_needs_triage":
    case "product_item_high_priority_stalled":
      return "product";
    case "operations_task_overdue":
    case "operations_task_escalation_needed":
      return "operations";
    // WP-D2: kundefrafall (churn) er et EGET domene, ikke «pipeline»: en autonomi-policy eieren har bundet til pipeline-loops (f.eks. oppfølging av stagnerte muligheter)
    // skal aldri stille gjelde for churn-risiko. Uten en eksplisitt policy for «retention» finnes ingen auto-ACT (fail closed) - loopen er INFORM/SUGGEST.
    case "customer_churn_risk":
      return "retention";
    default: {
      // Uttømmende: en ny OpenLoopType MÅ få en eksplisitt domene-avgjørelse her.
      const exhaustive: never = loopType;
      throw new Error(`unmapped_open_loop_type:${String(exhaustive)}`);
    }
  }
}

/**
 * Én open loop -> én situasjonskandidat. BEVISST:
 *  - `detection_key` = prefiks + loopens EGEN `detection_key` (SAMME
 *    idempotente identitet som loopen selv - en re-sveip av samme loop
 *    oppdaterer SAMME situasjon, "No duplicate spam for same event").
 *  - `source_open_loop_id` settes ALLTID (scope-safe sammensatt FK i 056
 *    garanterer at loopen hører til SAMME tenant+space).
 *  - `owner_person_id` settes IKKE fra loopen: `evaluateCandidate()` avviser
 *    (korrekt, arkitekt-review runde 1 Funn 1) en re-deteksjon der
 *    identiteten (inkl. eier) er ENDRET - og en open loop kan lovlig
 *    re-tildeles (`assignOpenLoop()`). Eieren er derfor ikke en del av
 *    SITUASJONENS identitet; den leses via `source_open_loop_id` når den
 *    trengs. Personskopet Q-20-erasure for situasjoner forblir dermed det
 *    ALLEREDE aksepterte "peker til loop"-tilfellet (design-notatet §7).
 *  - `reason` er loopens egen begrunnelse (+ anbefalt neste handling når
 *    den finnes) - INGEN modell-generert tekst, ren deterministisk
 *    sammensetting av felt som allerede er reviewet i UA-3.
 */
export function mapOpenLoopToCandidate(loop: BusinessOpenLoop): SituationCandidateInput {
  const reason = loop.next_action ? `${loop.reason} Anbefalt neste handling: ${loop.next_action}` : loop.reason;
  // `business_open_loops.confidence` er `numeric` - node-postgres leverer den
  // som STRENG ved kjøretid selv om typen sier `number`. Normaliseres her,
  // eksplisitt, så `SituationCandidateInputSchema` (z.number()) aldri avviser
  // en gyldig loop stille. En uparsbar verdi utelates (=> `inform`, aldri
  // `suggest`) i stedet for å gjettes.
  const confidence = loop.confidence === null ? Number.NaN : Number(loop.confidence);
  return {
    domain: domainForLoopType(loop.loop_type),
    detection_key: `${OPEN_LOOP_DETECTION_KEY_PREFIX}${loop.detection_key}`,
    priority: loop.priority,
    ...(Number.isFinite(confidence) ? { confidence } : {}),
    reason,
    source_open_loop_id: loop.open_loop_id
  };
}
