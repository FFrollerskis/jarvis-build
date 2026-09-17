import type { Situation, SituationPriority, SituationStage } from "@jarvis/situations";
import type { AttentionAuthorityStatus, AttentionItem, ExecutiveActionKind } from "./types.ts";

/**
 * UA-11 Executive Mode (P0, D-162): REN, deterministisk attention-ranking.
 * INGEN database-tilgang, INGEN klokke-avhengighet utover en injisert `now`,
 * INGEN modell-/AI-kall - se `docs/UA11_EXECUTIVE_MODE_DESIGN.md` §3 for
 * hvorfor rangeringen er strukturelt umulig å gjøre ikke-deterministisk.
 * Enhver endring i vektene under er en BEVISST, dokumentert avgjørelse -
 * ikke en oppfunnet sannhet dataene selv ikke sier.
 *
 * FAKTORER BRUKT (kun felt som faktisk finnes på `Situation`):
 *  1. `stage`      - hvor i tilstandsmaskinen situasjonen står (se under).
 *  2. `priority`   - eierens/motorens egen urgency/severity-klassifisering.
 *  3. `confidence`  - motorens egen konfidens (0..1, kan være null).
 *  4. `opened_at`  - tidskritikalitet/overdue: eldre åpen situasjon rangeres
 *     over en yngre med IDENTISK stage+priority+confidence (strengt
 *     sekundær tie-break, ALDRI foran stage/priority).
 *  5. `last_notified_at` (+ injisert `cooldownHours`) - "nylig varslet":
 *     en situasjon varslet FOR NYLIG uten ny stage-endring degraderes ett
 *     hakk (siste tie-break FØR situation_id) - ingenting nytt å se akkurat
 *     nå, men den forsvinner ALDRI helt (aldri stille undertrykt).
 *
 * IKKE brukt (bevisst, se byggeordren): "business impact" - `Situation` har
 * intet tallfelt for forretningsmessig konsekvens; å konstruere ett her ville
 * vært oppfunnet semantikk. Faktisk business-impact-vekting hører til en
 * SENERE UA-11-slice DERSOM en kilde som faktisk bærer det kobles til
 * `situations` (samme D-64-disiplin som resten av repoet).
 *
 * FUNN (D-162, ikke rettet i `@jarvis/situations` denne sliceen - se
 * DECISIONS_AND_ASSUMPTIONS.md): `confidence`-kolonnen er `numeric` i
 * `056_situations.sql`; `pg`-driveren returnerer PostgreSQL `numeric` som en
 * JS-STRENG med mindre en global typeparser er registrert (ingen er det i
 * dette repoet) - `Situation.confidence: number | null` sin egen deklarerte
 * TS-type stemmer derfor IKKE alltid med kjøretidsverdien fra ETT ekte
 * `situations.get_queue()`-kall (aritmetikk som `*`/`>=` fungerer likevel via
 * JS sin automatiske tvangskonvertering, men en metode som `.toFixed()`
 * krever et faktisk tall). `toNumberOrNull()` under er derfor en FORSVARENDE
 * normalisering på DENNE pakkens grense - IKKE en fiks av `@jarvis/situations`
 * selv, som ligger utenfor denne sliceens omfang.
 */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stage-vekt: avstanden til "eieren MÅ se på dette NÅ". `escalate` er
 * toppen (autonom håndtering er UTTØMT - masterplanens eskaleringsbegrep).
 * `suggest` er den ANDRE toppen: motoren spør EKSPLISITT om en beslutning.
 * `act`/`act_notify` er allerede autonomt håndtert (gjennomgang, ikke en ny
 * beslutning) - lavere enn `suggest`, men over ren FYI (`inform`).
 * `remember`/`ignore` er ALDRI attention-verdige (P0-motoren tildeler dem
 * kun for regler som eksplisitt IKKE skal forstyrre eieren - se
 * `computeTargetStage()` i `@jarvis/situations`).
 */
export const STAGE_ATTENTION_WEIGHT: Record<SituationStage, number> = {
  escalate: 6,
  suggest: 5,
  inform: 3,
  act: 2,
  act_notify: 1,
  remember: 0,
  ignore: 0
};

export const PRIORITY_WEIGHT: Record<SituationPriority, number> = { high: 2, normal: 1, low: 0 };

/** `stage` -> hva eieren faktisk kan/bør gjøre nå - se `ExecutiveActionKind` sin doc-kommentar. */
export function classifyActionKind(stage: SituationStage): ExecutiveActionKind {
  if (stage === "suggest") return "suggest";
  if (stage === "act" || stage === "act_notify" || stage === "escalate") return "act";
  return "read";
}

/** Attention-verdig = har en STAGE_ATTENTION_WEIGHT > 0 (utelater remember/ignore - se stage-vekt-kommentaren). `resolved`/pauset filtreres av kalleren, ikke her. */
export function isAttentionWorthy(stage: SituationStage): boolean {
  return STAGE_ATTENTION_WEIGHT[stage] > 0;
}

function ageHours(openedAt: string, now: Date): number {
  const opened = new Date(openedAt).getTime();
  return Math.max(0, (now.getTime() - opened) / 3_600_000);
}

/** `true` når situasjonen ble varslet innenfor `cooldownHours` FRA `now` - ren dato-aritmetikk, ingen skjult tilstand. */
export function isInNotificationCooldown(lastNotifiedAt: string | null, now: Date, cooldownHours: number): boolean {
  if (lastNotifiedAt === null || cooldownHours <= 0) return false;
  const notified = new Date(lastNotifiedAt).getTime();
  return now.getTime() - notified < cooldownHours * 3_600_000;
}

/**
 * Deterministisk komposittscore. Heltallsaritmetikk der det er mulig
 * (stage/priority/cooldown), slik at to identiske situasjoner ALLTID gir
 * IDENTISK score - "replay stability" er strukturelt garantert, ikke bare
 * testet. `confidence` bidrar med maks ±0,999 (aldri nok til å hoppe over
 * en hel priority- eller stage-terskel).
 */
export function computeAttentionScore(
  situation: Pick<Situation, "stage" | "priority" | "confidence" | "last_notified_at">,
  now: Date,
  cooldownHours: number
): number {
  const stageScore = STAGE_ATTENTION_WEIGHT[situation.stage] * 1_000;
  const priorityScore = PRIORITY_WEIGHT[situation.priority] * 100;
  const confidenceScore = (toNumberOrNull(situation.confidence) ?? 0) * 0.999;
  const cooldownPenalty = isInNotificationCooldown(situation.last_notified_at, now, cooldownHours) ? 1 : 0;
  return stageScore + priorityScore + confidenceScore - cooldownPenalty;
}

/** Menneskelesbar forklaring for HVORFOR akkurat denne scoren - samme felt som faktisk deltok i `computeAttentionScore()`, aldri mer. */
export function explainAttentionScore(
  situation: Pick<Situation, "domain" | "stage" | "priority" | "confidence" | "reason" | "last_notified_at">,
  now: Date,
  cooldownHours: number
): string[] {
  const lines = [
    `domene "${situation.domain}": ${situation.reason}`,
    `stadium=${situation.stage} (vekt ${STAGE_ATTENTION_WEIGHT[situation.stage]})`,
    `prioritet=${situation.priority} (vekt ${PRIORITY_WEIGHT[situation.priority]})`
  ];
  const confidence = toNumberOrNull(situation.confidence);
  if (confidence !== null) lines.push(`konfidens=${confidence.toFixed(2)}`);
  if (isInNotificationCooldown(situation.last_notified_at, now, cooldownHours)) {
    lines.push(`nylig varslet (< ${cooldownHours}t siden) - lett nedvektet, ikke undertrykt`);
  }
  return lines;
}

/** Deterministisk, ikke-modell-generert anbefaling - avledet KUN av stage + kjent autoritetsstatus. */
export function recommendNextAction(stage: SituationStage, authority: AttentionAuthorityStatus): string {
  if (authority.domain_paused) return "domene pauset av eier - ingen automatisk handling forventes; opphev pause for å gjenoppta";
  switch (stage) {
    case "escalate":
      return "eskalert - krever eierbeslutning nå (autonom håndtering er uttømt for denne situasjonen)";
    case "suggest":
      return authority.autonomy_bound && authority.autonomy_enabled
        ? "motoren venter på neste sveip for å utføre den bundne auto-ACT-handlingen - gjennomgå eller pause domenet for å stoppe det"
        : "gjennomgå og godkjenn/utfør manuelt - ingen auto-ACT-policy er bundet for dette domenet";
    case "act":
      return "autonom handling utført - varsel om bekreftet levering venter (act_notify)";
    case "act_notify":
      return "autonom handling utført og bekreftet levert - gjennomgå utfallet, ingen ny handling venter";
    case "inform":
      return "til orientering - løs manuelt (situations.resolve) når/hvis relevant";
    default:
      return "ingen handling anbefalt";
  }
}

export interface RankAttentionQueueOptions {
  now: Date;
  /** Timer et INFORM/SUGGEST-varsel fortsatt regnes som "nylig" - hentes fra EKSISTERENDE `situations.get_notification_policy` (resuppress_hours), aldri en ny, oppfunnet konstant. */
  cooldownHours: number;
  pausedDomains: ReadonlySet<string>;
  /** Domener med en AKTIVERT auto-ACT-binding (`list_autonomy_policies`, `enabled=true`). */
  autonomyEnabledDomains: ReadonlySet<string>;
  /** Domener med EN binding uansett `enabled` - skiller "bundet men slått av" fra "aldri bundet". */
  autonomyBoundDomains: ReadonlySet<string>;
}

/**
 * Renser/rangerer en allerede-hentet `Situation[]` (fra `situations.get_queue`,
 * ALDRI en egen spørring). Kaster ingenting - en tom/filtrert liste er et
 * gyldig resultat. Sortering: score DESC, deretter `opened_at` ASC (eldst
 * FØRST blant like scorer - "mest overdue"), deretter `situation_id` ASC som
 * en TOTAL, aldri-tvetydig siste tie-break (garanterer identisk rekkefølge
 * ved replay selv om to rader skulle dele NØYAKTIG samme `opened_at`).
 */
export function rankAttentionQueue(situations: readonly Situation[], options: RankAttentionQueueOptions): AttentionItem[] {
  const worthy = situations.filter((s) => isAttentionWorthy(s.stage));
  const scored = worthy.map((s) => ({
    situation: s,
    score: computeAttentionScore(s, options.now, options.cooldownHours)
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ageDiff = ageHours(a.situation.opened_at, options.now) - ageHours(b.situation.opened_at, options.now);
    if (ageDiff !== 0) return ageDiff > 0 ? -1 : 1; // eldre (høyere age) FØRST
    return a.situation.situation_id < b.situation.situation_id ? -1 : a.situation.situation_id > b.situation.situation_id ? 1 : 0;
  });
  return scored.map(({ situation: s, score }, index) => {
    const authority_status: AttentionAuthorityStatus = {
      domain_paused: options.pausedDomains.has(s.domain) || options.pausedDomains.has("*"),
      autonomy_bound: options.autonomyBoundDomains.has(s.domain),
      autonomy_enabled: options.autonomyEnabledDomains.has(s.domain)
    };
    return {
      situation_id: s.situation_id,
      tenant_id: s.tenant_id,
      memory_space_id: s.memory_space_id,
      domain: s.domain,
      stage: s.stage,
      action_kind: classifyActionKind(s.stage),
      priority: s.priority,
      confidence: toNumberOrNull(s.confidence),
      reason: s.reason,
      detection_key: s.detection_key,
      source_open_loop_id: s.source_open_loop_id,
      opened_at: s.opened_at,
      last_notified_at: s.last_notified_at,
      authority_status,
      recommended_next_action: recommendNextAction(s.stage, authority_status),
      explanation: explainAttentionScore(s, options.now, options.cooldownHours),
      score,
      rank: index + 1
    };
  });
}
