import type { IdentityContext } from "@jarvis/contracts";

/**
 * WP-B3 (D-475, EV-23): kontrakten for EIERENS AVGJØRELSE om et endringsforslag (godkjenn / avvis / utsett), registrert fra kontrollsenteret.
 *
 * DETTE ER KUN EN REGISTRERING. Selvendring er frosset (D-397): en avgjørelse utfører ingenting, aktiverer ingenting og kan aldri utløse en endring - `effect` er alltid `"none"` og `activation_decision` alltid `false`. Ingen kodevei leser
 * avgjørelsen som en tillatelse (den leses kun av Evolusjon-senteret for å vise hva du har avgjort); en framtidig aktivering krever en navngitt D-beslutning og sin egen godkjenning mot den da gjeldende tilstanden.
 *
 * Avgjørelsen er BUNDET til én bestemt versjon av forslaget: `proposal_digest` er `entry_hash` til forslagets siste rad i endringsregisteret (hash-kjeden, migrasjon 075). Et forslag som er endret, avvist, blokkert eller utført
 * siden du så det har en annen hash (eller er ikke lenger `proposed`) og kan ikke avgjøres på den gamle. Selve lagringen (revisjonssporet, ingen skriving til endringsregisteret) bor i `apps/api` - executive-pakken har ingen databasetilgang.
 */
export const EVOLUTION_DECISIONS = ["approve", "reject", "defer"] as const;
export type EvolutionDecision = (typeof EVOLUTION_DECISIONS)[number];

export function isEvolutionDecision(value: unknown): value is EvolutionDecision {
  return typeof value === "string" && (EVOLUTION_DECISIONS as readonly string[]).includes(value);
}

/** Norske ord for avgjørelsene (visning og bekreftelsestekst). */
export const EVOLUTION_DECISION_LABEL_NO: Readonly<Record<EvolutionDecision, string>> = { approve: "godkjent", reject: "avvist", defer: "utsatt" };

/** Typen på revisjonsraden som ER avgjørelsen (append-only `audit_events`, tenant-skopet). Eneste kilde for senteret og skriveren. */
export const EVOLUTION_DECISION_AUDIT_TYPE = "evolution.owner_decision";

export interface EvolutionDecisionInput {
  /** Forslagets id i endringsregisteret (`evolution_change_ledger.change_id`). */
  change_id: string;
  /** `entry_hash` (64 hex) til forslagets siste rad - det eieren så. */
  proposal_digest: string;
  decision: EvolutionDecision;
}

export interface EvolutionDecisionResult {
  /** `recorded` = en ny revisjonsrad er skrevet; `already_recorded` = samme avgjørelse var allerede registrert for akkurat denne versjonen (idempotent, ingenting skrevet). */
  outcome: "recorded" | "already_recorded";
  decision: EvolutionDecision;
  change_id: string;
  proposal_digest: string;
  /** Eierens forrige avgjørelse om samme versjon av forslaget (null = ingen). Den nye overstyrer; den forrige står i revisjonssporet. */
  previous_decision: EvolutionDecision | null;
  /** Alltid `"none"`: registreringen har ingen virkning. */
  effect: "none";
  /** Alltid false: ingenting aktiveres (selvendring er frosset, D-397). */
  activation_decision: false;
}

/** Feilkodene skriveren avviser med (`Error.message`). Faste koder - aldri tekst fra data. */
export const EVOLUTION_DECISION_REFUSALS = [
  "evolution_decisions_not_configured", "invalid_evolution_decision_input", "proposal_not_found", "proposal_not_open", "proposal_digest_mismatch", "proposal_class_forbidden", "decision_record_failed"
] as const;
export type EvolutionDecisionRefusal = (typeof EVOLUTION_DECISION_REFUSALS)[number];

/**
 * Skriveren (implementert i `apps/api`): validerer mot endringsregisteret (finnes, er `proposed`, digest = siste rad, aldri godkjenning av E3), tar en lås per forslag, sjekker forrige avgjørelse (idempotens) og skriver
 * ÉN revisjonsrad med før-bildet. Kaster `Error(<EvolutionDecisionRefusal>)` ved avslag. Skriver ALDRI til endringsregisteret og endrer ingenting annet.
 */
export interface EvolutionDecisionRecorder {
  record(identity: IdentityContext, input: EvolutionDecisionInput): Promise<EvolutionDecisionResult>;
}

/** Deterministisk norsk svar (modellen/siden skal relayere dette, aldri utbrodere): sier alltid at ingenting utføres. */
export function summarizeEvolutionDecisionNo(result: EvolutionDecisionResult): string {
  const label = EVOLUTION_DECISION_LABEL_NO[result.decision];
  const base = result.outcome === "already_recorded"
    ? `Avgjørelsen «${label}» var allerede registrert for forslaget ${result.change_id} (denne versjonen); ingenting ble skrevet på nytt.`
    : `Din avgjørelse «${label}» er registrert for forslaget ${result.change_id} (versjon ${result.proposal_digest.slice(0, 12)})${result.previous_decision ? `; den overstyrer din forrige avgjørelse «${EVOLUTION_DECISION_LABEL_NO[result.previous_decision]}» (den står i revisjonssporet)` : ""}.`;
  return `${base} Registreringen har INGEN virkning: ingenting utføres eller aktiveres (selvendring er frosset, D-397).`;
}
