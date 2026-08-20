/**
 * D-91 (UA-4 NESTE SLICE): Consent / Cookie / Data-Processing Governance Core.
 *
 * KJERNEPRINSIPP (ufravikelig, se D-91 i DECISIONS_AND_ASSUMPTIONS.md):
 * dette er et DETERMINISTISK håndhevingslag over EKSPLISITT, eier-konfigurert
 * tilstand - ALDRI et system som selv utleder eller avgjør juridisk
 * compliance. Jarvis håndhever den REGISTRERTE `legal_basis`-verdien; Jarvis
 * bestemmer ALDRI hvilket rettslig grunnlag som faktisk gjelder for en gitt
 * situasjon (det er et menneskelig/juridisk spørsmål utenfor denne kodens
 * autoritet). ZERO ModelGateway - INGEN AI-utledet samtykke, INGEN
 * "sannsynligvis samtykket basert på atferd"-inferens noe sted.
 *
 * FAIL-CLOSED (SAMME lærdom som D-81 sin `isSensitivityEligible()`-fiks):
 * fravær av en registrert beslutning betyr ALDRI implisitt tillatelse.
 * `evaluateProcessingDecision()` returnerer `UNKNOWN_NOT_CONFIGURED` når
 * ingen beslutning finnes - ALDRI `ALLOWED`.
 */

/**
 * BEVISST SMALT, LUKKET formål-sett (v1) - KUN de to formålene som er
 * direkte begrunnet i eksisterende repo-sannhet:
 * - `attribution`: EKSISTERENDE kapabilitet (D-74/D-82 sin
 *   `attributeToCampaign()`/`attributeFromTracking()`) - kobler en kontakt-
 *   avledet lead/opportunity til en kampanje for attribusjonsformål.
 * - `tracking`: det EKSPLISITT navngitte fremtidige gapet fra
 *   `docs/UA3_BUSINESS_DPIA.md` ("samtykke-/cookie-/databehandlings-
 *   dokumentasjon for produksjonssporing... blir relevant FØRST når en
 *   faktisk sporingsmekanisme bygges") - forberedt her, IKKE en påstand om
 *   at en sporingsmekanisme faktisk finnes ennå (den finnes ikke, se D-91).
 *
 * IKKE lagt til uten videre begrunnelse: `advertising`/`personalization`/
 * `remarketing`/`email_marketing` - disse ville vært formål-spredning uten
 * en eksisterende kapabilitet eller et eksplisitt dokumentert gap å feste
 * dem til. En fremtidig slice kan utvide settet NÅR en reell kapabilitet
 * krever det (samme CHECK-constraint-utvidelsesmønster som
 * `observation_type` i D-89/031_growth_marketing_observations.sql).
 */
export type ConsentPurpose = "attribution" | "tracking";

/** Én registrert beslutning sin tilstand - ALDRI overskrevet, kun overgått av en NY rad (append-only). */
export type ConsentDecisionState = "granted" | "denied" | "withdrawn";

/**
 * Eier-konfigurert autoritetsreferanse - IKKE en Jarvis-avledet juridisk
 * konklusjon. Verdiene her er ETIKETTER for hvilket grunnlag eieren HAR
 * OPPGITT, ikke en påstand fra Jarvis om at grunnlaget faktisk er gyldig
 * for den aktuelle situasjonen (se §7 i byggeordren - dette er IKKE et
 * juridisk ekspertsystem).
 */
export type ConsentLegalBasis = "consent" | "legitimate_interest" | "contract" | "legal_obligation";

/**
 * Resultatet av `evaluateProcessingDecision()` - ALDRI en bar boolean.
 * `UNKNOWN_NOT_CONFIGURED` er en EGEN, eksplisitt tredje tilstand (§15 i
 * byggeordren) - fravær av data kollapses ALDRI stille til `DENIED` ELLER
 * `ALLOWED`; kalleren MÅ selv velge fail-closed-oppførsel for sin egen
 * kontekst (denne funksjonen selv returnerer ALDRI `ALLOWED` for en ukjent
 * tilstand - se `evaluateProcessingDecision()`-JSDoc i `service.ts`).
 */
export type ProcessingDecisionOutcome = "ALLOWED" | "DENIED" | "UNKNOWN_NOT_CONFIGURED";

/** Én permanent, aldri-slettet-før-erasure rad i beslutnings-loggen (se `032_consent_governance.sql`). */
export interface ConsentDecision {
  decision_id: string;
  tenant_id: string;
  memory_space_id: string;
  contact_id: string;
  purpose: ConsentPurpose;
  state: ConsentDecisionState;
  legal_basis: ConsentLegalBasis;
  /** Proveniens/kontekst for HVORDAN beslutningen ble fanget - en PEKER (kilde/skjema-versjon/kanal), ALDRI full skjema-payload eller rå personopplysninger utover det som allerede er i `contact_id`-referansen. */
  evidence: Record<string, unknown>;
  /** Hvilken versjon av EIERENS konfigurerte samtykke-/personvernpolicy som gjaldt da beslutningen ble registrert - IKKE en Jarvis-intern kodeversjon. */
  policy_version: string;
  /** Hvem (internt Jarvis-side) som registrerte beslutningen - IKKE datasubjektet selv. Samme `actor_person_id`-mønster som `CreateCampaignInput`/`RecordSpendEventInput` i @jarvis/growth. */
  actor_person_id: string | null;
  expires_at: string | null;
  recorded_at: string;
}

export interface RecordConsentDecisionInput {
  contact_id: string;
  purpose: ConsentPurpose;
  state: ConsentDecisionState;
  legal_basis: ConsentLegalBasis;
  evidence: Record<string, unknown>;
  policy_version: string;
  actor_person_id?: string;
  expires_at?: string;
}

/**
 * Fullstendig forklarbar beslutning (§33 i byggeordren) - ALDRI en opak
 * `{allowed: true}`. `provenance` peker til den FAKTISKE `decision_id` som
 * avgjørelsen ble utledet fra (eller `null` for `UNKNOWN_NOT_CONFIGURED`).
 */
export interface ProcessingDecisionResult {
  outcome: ProcessingDecisionOutcome;
  purpose: ConsentPurpose;
  contact_id: string;
  reason: string;
  policy_version: string | null;
  provenance: string | null;
  evaluated_at: string;
}

export interface ListConsentDecisionsFilter {
  contact_id?: string;
  purpose?: ConsentPurpose;
}
