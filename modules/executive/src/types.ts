import type { Situation, SituationPriority, SituationStage } from "@jarvis/situations";

/**
 * UA-11 Executive Mode (P0, D-162): JARVIS_CANONICAL attention-ranking-
 * kontrakt. Denne pakken eier IKKE noen egen hendelses-/tilstandskilde -
 * `situations` (UA-10) er den ENE kilden P0 komponerer (D-64: en ekstern/
 * søster-pakke er ALDRI stedet kjernen bor, men her er `situations` selv
 * allerede JARVIS_CANONICAL, så komposisjon - ikke duplisering - er riktig
 * retning). Se `docs/UA11_EXECUTIVE_MODE_DESIGN.md` for full begrunnelse.
 */

/**
 * Klassifiserer HVOR i den kanoniske tilstandsmaskinen
 * (ignore -> remember -> inform -> suggest -> act -> act_notify -> escalate,
 * se `@jarvis/situations`) et attention-item står, oversatt til hva EIEREN
 * faktisk kan/bør gjøre med det NÅ - direkte avledet av `stage`, ingen ny
 * semantikk:
 * - "read": ren FYI (remember/ignore/inform) - ingen handling forventet.
 * - "suggest": motoren ber eksplisitt om en eierbeslutning (suggest).
 * - "act": autonom handling er allerede utført/bekreftet eller eskalert
 *   (act/act_notify/escalate) - eieren kan gjennomgå, men intet nytt venter.
 */
export type ExecutiveActionKind = "read" | "suggest" | "act";

/** Eierens autoritets-/pausetilstand for ETT attention-items domene - lest fra `situations.get_pause_state`/`list_autonomy_policies`, aldri egen tilstand. */
export interface AttentionAuthorityStatus {
  domain_paused: boolean;
  autonomy_bound: boolean;
  autonomy_enabled: boolean;
}

/**
 * ÉN rangert attention-post. RENT avledet av `Situation` (situations-pakken)
 * + pause-/policy-tilstand - INGEN egen persistens, INGEN felt som ikke kan
 * spores tilbake til et eksisterende kildefelt.
 */
export interface AttentionItem {
  situation_id: string;
  tenant_id: string;
  memory_space_id: string;
  domain: string;
  stage: SituationStage;
  action_kind: ExecutiveActionKind;
  priority: SituationPriority;
  confidence: number | null;
  reason: string;
  detection_key: string;
  source_open_loop_id: string | null;
  opened_at: string;
  last_notified_at: string | null;
  authority_status: AttentionAuthorityStatus;
  /** Deterministisk, forklarbar anbefaling - aldri modell-generert i P0 (se ranking.ts). */
  recommended_next_action: string;
  /** Menneskelesbare grunner rangeringen faktisk brukte - "explainable", ikke en skjult vektsum. */
  explanation: string[];
  /** Rå, deterministisk komposittscore (høyere = mer oppmerksomhet nå) - kun for sortering/tie-break-bevis, ALDRI vist som "sannhet" til eieren uten `explanation`. */
  score: number;
  /** 1-basert plassering i DENNE rangerte listen (stabil ved replay for identisk input). */
  rank: number;
}

/** Full kilde-`Situation` pluss det avledede attention-laget - "se underliggende situation" uten et nytt oppslag. */
export interface AttentionItemDetail extends AttentionItem {
  situation: Situation;
}
