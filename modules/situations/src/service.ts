import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace, IdentityContext } from "@jarvis/contracts";
import type { ToolGateway, ToolResult } from "@jarvis/tool-gateway";
import {
  SetSituationNotificationPolicyInputSchema,
  SituationCandidateInputSchema,
  type ActOnRequest,
  type EvaluateCandidateResult,
  type SetSituationNotificationPolicyInput,
  type Situation,
  type SituationCandidateInput,
  type SituationNotificationPolicy,
  type SituationPriority,
  type SituationStage
} from "./types.ts";
import type { DomainPauseRegistry } from "./domain-pause.ts";

/**
 * UA-10 Proactive Situation Engine: JARVIS_CANONICAL hendelses-/situasjons-
 * tjeneste (D-64 Core-vs-Adapter-porten kjørt FØRST - se
 * docs/UA10_SITUATION_ENGINE_DESIGN.md).
 *
 * Dette er et RENT KOMPOSISJONS-/tilstandslag, IKKE en ny anomali-detektor
 * og IKKE en live hendelseskilde - `evaluateCandidate()` er en STABIL
 * inngangskontrakt (se types.ts sitt filhode). MULTI-SPACE (samme mønster
 * som `business_open_loops`/`@jarvis/location` - IKKE health-stil
 * enkelt-låst space): situasjoner spenner naturlig over flere domener.
 *
 * Tilstandsmaskinen (masterplanens egen rekkefølge): ignore -> remember ->
 * inform -> suggest -> act -> act_notify -> escalate. `evaluateCandidate()`
 * tildeler KUN ignore/remember/inform/suggest - DETERMINISTISKE regler
 * (`computeTargetStage()`), INGEN modell-assistert klassifisering i P0.
 * act/act_notify/escalate nås UTELUKKENDE via `actOn()`.
 */
export class SituationEngineValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly detail: string
  ) {
    super(`situation_invalid:${field}:${detail}`);
    this.name = "SituationEngineValidationError";
  }
}

/**
 * Kastet av `actOn()` FØR noe `ToolGateway.execute()`-kall i det hele tatt
 * gjøres - masterplanens akseptansekriterium "Owner can pause a domain or
 * entire Situation Engine instantly". Fail-closed: INGEN ekstern effekt,
 * INGEN mutasjon av situasjonens tilstand, kun en typet refusjon.
 */
export class SituationDomainPausedError extends Error {
  constructor(
    public readonly domain: string,
    public readonly reason: string | undefined
  ) {
    super(`situation_domain_paused:${domain}:${reason ?? "no_reason_given"}`);
    this.name = "SituationDomainPausedError";
  }
}

export class SituationNotFoundError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_not_found:${situationId}`);
    this.name = "SituationNotFoundError";
  }
}

/**
 * Kastet av `evaluateCandidate()` (arkitekt-review runde 1, PR #85, Funn 1):
 * en re-deteksjon for SAMME `(tenant_id, memory_space_id, detection_key)`
 * hvis IDENTITET (`domain`/`owner_person_id`/`source_open_loop_id`) er
 * ENDRET fra det som allerede er lagret. En fri-tekst `detection_key` som
 * plutselig peker på et ANNET domene/en annen eier/kilde er et
 * kollisjons-/korrupsjonstegn (to ulike forhold som tilfeldigvis fikk samme
 * nøkkel), IKKE en gyldig oppdatering av SAMME forhold - avvist EKSPLISITT
 * i stedet for stille overskrevet.
 */
export class SituationDetectionKeyConflictError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly memorySpace: string,
    public readonly detectionKey: string
  ) {
    super(`situation_detection_key_conflict:${tenantId}:${memorySpace}:${detectionKey}`);
    this.name = "SituationDetectionKeyConflictError";
  }
}

/**
 * Kastet av `actOn()` (Funn 3): situasjonen er ALLEREDE claimet av et
 * TIDLIGERE `actOn()`-kall med en ANNEN idempotens-nøkkel (en genuint
 * ANNEN handling) - FØR noe `ToolGateway.execute()`-kall gjøres, fail-
 * closed, ingen ekstern effekt. En situasjon kan KUN noensinne claimes ÉN
 * gang (masterplanens egen tilstandsmaskin: `act`/`act_notify`/`escalate`
 * er alle terminale). Et forsøk med SAMME idempotens-nøkkel som den
 * lagrede (en legitim retry) claimer på nytt trygt og kaster ALDRI dette.
 */
export class SituationActAlreadyClaimedError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_already_claimed:${situationId}`);
    this.name = "SituationActAlreadyClaimedError";
  }
}

/**
 * Kastet av `actOn()` (Funn 3): situasjonen er claimet av NØYAKTIG DENNE
 * idempotens-nøkkelen, MEN forrige forsøk har IKKE fullført persisteringen
 * ennå (`act_result IS NULL`) - ENTEN et ANNET, SANN SAMTIDIG `actOn()`-kall
 * er FORTSATT i flukt akkurat nå, ELLER et TIDLIGERE forsøk krasjet mellom
 * det eksterne kallet og persisteringen. Denne klassen kan IKKE skille de to
 * tilfellene fra hverandre - og velger derfor BEVISST det TRYGGESTE
 * utfallet (avvis, ALDRI et nytt `ToolGateway.execute()`-kall) fremfor å
 * risikere et ekte SAMTIDIG dobbelt-forsøk på den faktiske side-effekten.
 * En EKTE krasj-gjenoppretting (prosessen som eide forsøket er FAKTISK død)
 * er derfor P0 IKKE selv-helbredende innen SAMME idempotens-nøkkel - en
 * fremtidig, egen "claim med et utløpsvindu"-mekanisme er naturlig neste
 * steg, IKKE bygget her (flagget eksplisitt, ikke stilltiende utelatt).
 */
export class SituationActInFlightError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_in_flight:${situationId}`);
    this.name = "SituationActInFlightError";
  }
}

const DEFAULT_RESUPPRESS_HOURS = 24;

const STAGE_RANK: Record<SituationStage, number> = {
  ignore: 0,
  remember: 1,
  inform: 2,
  suggest: 3,
  act: 4,
  act_notify: 5,
  escalate: 6
};

/**
 * Ren funksjon (INGEN I/O, `nowMs` injisert - samme "deterministisk,
 * testbar" mønster som `classifyAttentionBucket()` i
 * `@jarvis/business/open-loop-types.ts`). Et vindu som krysser midnatt
 * (f.eks. 22 -> 6) håndteres direkte. Et NULLSTILT/likt start=slutt-vindu
 * tolkes EKSPLISITT som "deaktivert", ALDRI som "stille hele døgnet" - et
 * utilsiktet `22,22`-oppsett skal aldri stille alle varsler for alltid.
 */
export function isWithinQuietHours(nowMs: number, quietHoursStartUtc: number | null, quietHoursEndUtc: number | null): boolean {
  if (quietHoursStartUtc === null || quietHoursEndUtc === null || quietHoursStartUtc === quietHoursEndUtc) {
    return false;
  }
  const hour = new Date(nowMs).getUTCHours();
  if (quietHoursStartUtc < quietHoursEndUtc) {
    return hour >= quietHoursStartUtc && hour < quietHoursEndUtc;
  }
  return hour >= quietHoursStartUtc || hour < quietHoursEndUtc;
}

/**
 * Ren funksjon: den DETERMINISTISKE regelen for hvilket stadium en NY
 * (eller re-evaluert) kandidat kvalifiserer til. Returnerer ALDRI
 * `act`/`act_notify`/`escalate` (kun `actOn()` kan nå de stadiene) og
 * ALDRI `ignore` (kun en fremtidig eksplisitt avvisnings-handling ville
 * satt det - ikke bygget i P0, se design-notatet).
 */
export function computeTargetStage(priority: SituationPriority, confidence: number | undefined, withinQuietHours: boolean): SituationStage {
  if (withinQuietHours) return "remember";
  if (priority === "low") return "remember";
  if (priority === "high" && confidence !== undefined && confidence >= 0.75) return "suggest";
  return "inform";
}

export interface ActOnResult {
  situation: Situation;
  tool_result: ToolResult;
}

export class SituationEngine {
  constructor(
    private readonly pool: pg.Pool,
    private readonly domainPauses: DomainPauseRegistry
  ) {}

  // ---------------------------------------------------------------------
  // Notification policy (eier-konfigurert, se filhode)
  // ---------------------------------------------------------------------

  async getNotificationPolicy(tenantId: string, memorySpace: MemorySpace): Promise<SituationNotificationPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM situation_notification_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      return (rows[0] as SituationNotificationPolicy | undefined) ?? null;
    });
  }

  async setNotificationPolicy(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SetSituationNotificationPolicyInput
  ): Promise<SituationNotificationPolicy> {
    const parsed = SetSituationNotificationPolicyInputSchema.safeParse(input);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new SituationEngineValidationError(firstIssue?.path.join(".") || "input", firstIssue?.message ?? "schema_validation_failed");
    }
    const value = parsed.data;
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `INSERT INTO situation_notification_policies (tenant_id, memory_space_id, quiet_hours_start_utc, quiet_hours_end_utc, resuppress_hours, actor_person_id, updated_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, ${DEFAULT_RESUPPRESS_HOURS}), $6, now())
         ON CONFLICT (tenant_id, memory_space_id)
         DO UPDATE SET
           quiet_hours_start_utc = EXCLUDED.quiet_hours_start_utc,
           quiet_hours_end_utc = EXCLUDED.quiet_hours_end_utc,
           resuppress_hours = EXCLUDED.resuppress_hours,
           actor_person_id = EXCLUDED.actor_person_id,
           updated_at = now()
         RETURNING *`,
        [
          tenantId,
          memorySpace,
          value.quiet_hours_start_utc ?? null,
          value.quiet_hours_end_utc ?? null,
          value.resuppress_hours ?? null,
          value.actor_person_id ?? null
        ]
      );
      return rows[0] as SituationNotificationPolicy;
    });
  }

  private async policyInTransaction(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace
  ): Promise<{ quietStart: number | null; quietEnd: number | null; resuppressHours: number }> {
    const { rows } = await client.query(
      `SELECT quiet_hours_start_utc, quiet_hours_end_utc, resuppress_hours FROM situation_notification_policies WHERE tenant_id = $1 AND memory_space_id = $2`,
      [tenantId, memorySpace]
    );
    const row = rows[0] as { quiet_hours_start_utc: number | null; quiet_hours_end_utc: number | null; resuppress_hours: number } | undefined;
    return {
      quietStart: row?.quiet_hours_start_utc ?? null,
      quietEnd: row?.quiet_hours_end_utc ?? null,
      resuppressHours: row?.resuppress_hours ?? DEFAULT_RESUPPRESS_HOURS
    };
  }

  // ---------------------------------------------------------------------
  // Candidate evaluation (deteksjon -> tilstandsmaskin, se filhode)
  // ---------------------------------------------------------------------

  /**
   * Idempotent (`detection_key`, samme mønster som `business_open_loops`):
   * en gjentatt kandidat for SAMME nøkkel oppdaterer SAMME rad, oppretter
   * ALDRI en duplikat - masterplanens "No duplicate spam for same event"
   * håndheves strukturelt av `UNIQUE (tenant_id, memory_space_id, detection_key)`
   * (`056_situations.sql`) kombinert med `newly_actionable` under.
   *
   * Stadiet REGRESSERER ALDRI av en re-evaluering: hvis situasjonen
   * allerede har nådd `act`/`act_notify`/`escalate` (kun `actOn()` setter
   * disse), lar en ny kandidat-deteksjon stadiet stå URØRT - en handling
   * som allerede er utført/eskalert skal ikke stille "glemmes" tilbake til
   * `inform` av neste deteksjonssyklus. For stadier UNDER det nivået tas
   * det HØYESTE av eksisterende og nytt beregnet stadium.
   *
   * `newly_actionable` (se types.ts) skiller en GENUINT ny/re-aktualisert
   * situasjon fra en stille tilstandsoppdatering - KUN når `true` bør en
   * kaller faktisk levere en INFORM/SUGGEST-varsling (f.eks. Telegram).
   * Stille timer (`isWithinQuietHours()`) HOLDER stadiet på `remember` -
   * situasjonen persisteres, men varsler ALDRI umiddelbart.
   */
  async evaluateCandidate(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SituationCandidateInput,
    now: number = Date.now()
  ): Promise<EvaluateCandidateResult> {
    const parsed = SituationCandidateInputSchema.safeParse(input);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new SituationEngineValidationError(firstIssue?.path.join(".") || "input", firstIssue?.message ?? "schema_validation_failed");
    }
    const value = parsed.data;

    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const policy = await this.policyInTransaction(client, tenantId, memorySpace);
      const withinQuiet = isWithinQuietHours(now, policy.quietStart, policy.quietEnd);
      const computedStage = computeTargetStage(value.priority, value.confidence, withinQuiet);
      const ownerPersonId = value.owner_person_id ?? null;
      const sourceOpenLoopId = value.source_open_loop_id ?? null;

      // Funn 1 (arkitekt-review runde 1, PR #85): ATOMISK insert-or-fetch
      // (samme "prøv INSERT ... ON CONFLICT DO NOTHING FØRST"-mønster som
      // vision sin `insertValidatedInTransaction()`, modules/vision/src/
      // service.ts) - IKKE en separat SELECT-så-branch. Den GAMLE koden sin
      // `SELECT ... FOR UPDATE` fant INGEN rad å låse for en genuint NY
      // detection_key, så to SAMTIDIGE `evaluateCandidate()`-kall for SAMME
      // nøkkel kunne begge passere "finnes ikke"-sjekken og deretter race
      // på en ukontrollert unique-constraint-feil ved INSERT. Denne
      // rekkefølgen gjør racen umulig: kollisjonsdomenet inkluderer nå
      // `memory_space_id` (samme nøkkel kan brukes uavhengig i to ulike
      // spaces uten kollisjon).
      const newlyActionableOnInsert = computedStage === "inform" || computedStage === "suggest";
      const { rows: insertedRows } = await client.query(
        `INSERT INTO situations
           (situation_id, tenant_id, memory_space_id, domain, owner_person_id, source_open_loop_id, detection_key, stage, priority, confidence, reason, last_notified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, memory_space_id, detection_key) DO NOTHING
         RETURNING *`,
        [
          `sit-${randomUUID()}`,
          tenantId,
          memorySpace,
          value.domain,
          ownerPersonId,
          sourceOpenLoopId,
          value.detection_key,
          computedStage,
          value.priority,
          value.confidence ?? null,
          value.reason,
          newlyActionableOnInsert ? new Date(now).toISOString() : null
        ]
      );
      if (insertedRows[0]) {
        return { situation: insertedRows[0] as Situation, newly_actionable: newlyActionableOnInsert };
      }

      // Konflikt - raden finnes GARANTERT nå (unique constraint slo inn),
      // så denne `FOR UPDATE` er race-fri (motsatt av den gamle "kanskje
      // finnes ikke ennå"-SELECT-en over).
      const { rows: existingRows } = await client.query(
        `SELECT * FROM situations WHERE tenant_id = $1 AND memory_space_id = $2 AND detection_key = $3 FOR UPDATE`,
        [tenantId, memorySpace, value.detection_key]
      );
      const existing = existingRows[0] as Situation;

      // Funn 1: avvis EKSPLISITT (kast) i stedet for å stille overskrive
      // hvis den lagrede radens IDENTITET er en ANNEN enn kandidatens - se
      // `SituationDetectionKeyConflictError` sin doc-kommentar over.
      if (existing.domain !== value.domain || existing.owner_person_id !== ownerPersonId || existing.source_open_loop_id !== sourceOpenLoopId) {
        throw new SituationDetectionKeyConflictError(tenantId, memorySpace, value.detection_key);
      }

      const resuppressOpen =
        existing.last_notified_at === null || now - new Date(existing.last_notified_at).getTime() >= policy.resuppressHours * 3_600_000;
      const stageIsActedUpon = existing.stage === "act" || existing.stage === "act_notify" || existing.stage === "escalate";
      const nextStage = stageIsActedUpon
        ? existing.stage
        : STAGE_RANK[computedStage] > STAGE_RANK[existing.stage as SituationStage]
          ? computedStage
          : (existing.stage as SituationStage);
      // Funn 5: stille timer (`withinQuiet`) MÅ sjekkes EKSPLISITT her,
      // ALDRI kun utledet fra `nextStage` - non-regresjon (over) kan HOLDE
      // `nextStage` på et TIDLIGERE (høyere) 'inform'/'suggest'-nivå fra FØR
      // stille-timer-vinduet ble aktivt. Uten denne `!withinQuiet`-sjekken
      // ville en re-evaluering MIDT I et stille-timer-vindu feilaktig talt
      // som `newly_actionable` og trigget en varsling akkurat når eieren
      // har konfigurert IKKE å bli varslet.
      const newlyActionable = !stageIsActedUpon && !withinQuiet && resuppressOpen && (nextStage === "inform" || nextStage === "suggest");

      const { rows } = await client.query(
        `UPDATE situations
         SET priority = $4, confidence = $5, reason = $6, stage = $7,
             status = 'open', resolved_at = NULL,
             last_notified_at = CASE WHEN $8 THEN $9 ELSE last_notified_at END,
             updated_at = now()
         WHERE tenant_id = $1 AND memory_space_id = $2 AND detection_key = $3
         RETURNING *`,
        [
          tenantId,
          memorySpace,
          value.detection_key,
          value.priority,
          value.confidence ?? null,
          value.reason,
          nextStage,
          newlyActionable,
          new Date(now).toISOString()
        ]
      );
      return { situation: rows[0] as Situation, newly_actionable: newlyActionable };
    });
  }

  /** Lese-API, tenant+space-scoped (RLS + eksplisitt argument - samme "aldri et blankt gi-meg-alt-kall"-disiplin som resten av repoet). */
  async getQueue(
    tenantId: string,
    memorySpace: MemorySpace,
    filter: { domain?: string; stage?: SituationStage; statusOpenOnly?: boolean } = {}
  ): Promise<Situation[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions = ["tenant_id = $1"];
      const params: Array<string> = [tenantId];
      if (filter.statusOpenOnly !== false) conditions.push("status = 'open'");
      if (filter.domain) {
        params.push(filter.domain);
        conditions.push(`domain = $${params.length}`);
      }
      if (filter.stage) {
        params.push(filter.stage);
        conditions.push(`stage = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM situations WHERE ${conditions.join(" AND ")}
         ORDER BY (priority = 'high') DESC, (priority = 'normal') DESC, opened_at ASC`,
        params
      );
      return rows as Situation[];
    });
  }

  async resolve(tenantId: string, memorySpace: MemorySpace, situationId: string): Promise<Situation> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE situations SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND situation_id = $2 RETURNING *`,
        [tenantId, situationId]
      );
      if (!rows[0]) throw new SituationNotFoundError(situationId);
      return rows[0] as Situation;
    });
  }

  // ---------------------------------------------------------------------
  // ACT (komponerer den ALLEREDE reviewte ToolGateway.execute()-pipelinen)
  // ---------------------------------------------------------------------

  /**
   * Utfører DEN FAKTISKE klasse D/C-handlingen for én situasjon ved å
   * KOMPONERE `ToolGateway.execute()` - INGEN ny sikkerhetsmekanikk
   * oppfinnes her. `PolicyGateway.authorize()` (kalt INNENFOR `execute()`)
   * er ALLEREDE den eksisterende, ALLEREDE revierte kilden til "valid
   * owner/delegated authority" (masterplanens akseptansekriterium) - SOVEREIGN
   * eier-modus eller en gyldig signert godkjenning, uendret av denne
   * pakken. "logs reason/evidence" OG "immediate post-action notification
   * and recovery context" er OGSÅ ALLEREDE `execute()` sin egen,
   * Q-34/D-130-hardnede audit-/evidence-pipeline for klasse C/D - denne
   * metoden legger KUN til ett eksplisitt Telegram-varsel-kall ETTER en
   * BEKREFTET suksess (aldri før, aldri på en nektet/ubekreftet handling).
   *
   * DOMENE-PAUSE SJEKKES FØRST, FØR `execute()` i det hele tatt kalles
   * (`SituationDomainPausedError`, fail-closed, INGEN ekstern effekt).
   * `PolicyGateway` sin egen GLOBALE `KillSwitch` er UENDRET og gjelder
   * UANSETT (sjekkes INNENFOR `execute()` sitt eget autorisasjonskall,
   * VIRKER SAMTIDIG med, ikke erstattet av, domene-pausen her).
   *
   * BEVISST IKKE autonomt tidsstyrt/sveipet i P0 - `actOn()` krever en
   * EKSPLISITT kaller (menneske eller en fremtidig, egen-vurdert
   * autonomi-slice) - se design-notatet for hele sikkerhetsbegrunnelsen
   * for hvorfor "autonom auto-ACT uten et eksplisitt kall" er en BEVISST
   * senere, separat grense (annen sikkerhetsklasse/blast radius).
   *
   * Et ubekreftet/nektet `ToolResult` (`ok: false`, dekker BÅDE en policy-
   * nektelse OG en Q-34-postcondition-verifiseringsfeil - se `ToolResult`
   * sin egen doc-kommentar i `@jarvis/tool-gateway`) flytter situasjonen
   * til `escalate` MED den faktiske avslagsgrunnen i `reason` - ALDRI
   * stille tilbake til et tidligere stadium, og ALDRI et Telegram-varsel
   * om en handling som faktisk IKKE ble bekreftet utført.
   */
  async actOn(
    tenantId: string,
    memorySpace: MemorySpace,
    situationId: string,
    request: ActOnRequest,
    gateway: ToolGateway,
    identity: IdentityContext
  ): Promise<ActOnResult> {
    // Funn 3 (arkitekt-review runde 1, PR #85): en STABIL, deterministisk
    // idempotens-nøkkel BUNDET til situasjonen - en kaller kan fortsatt gi
    // sin EGEN `request.idempotency_key` (f.eks. for å binde ekstra
    // kontekst), men `actOn()` GARANTERER ALLTID at NOEN stabil nøkkel
    // brukes, BÅDE for den varige claim-en under OG for selve
    // `ToolGateway.execute()`-kallet.
    const idempotencyKey = request.idempotency_key ?? `situation-act:${situationId}`;

    const situation = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM situations WHERE tenant_id = $1 AND situation_id = $2`, [tenantId, situationId]);
      if (!rows[0]) throw new SituationNotFoundError(situationId);
      return rows[0] as Situation;
    });

    if (this.domainPauses.isPaused(situation.domain)) {
      throw new SituationDomainPausedError(situation.domain, this.domainPauses.pauseReason(situation.domain));
    }

    // Funn 3: ATOMISK, VARIG, EKSKLUSIV claim FØR noe eksternt
    // `ToolGateway.execute()`-kall gjøres. `WHERE act_idempotency_key IS
    // NULL` er BEVISST eksklusiv (IKKE "eller samme nøkkel") - KUN ÉN
    // caller, uansett om den er en SANN samtidig konkurrent eller en enkel
    // sekvensiell kaller, vinner NOENSINNE denne claimen for en gitt
    // situasjon. En SAMTIDIG "taper" (SAMME utledede nøkkel som allerede er
    // claimet, men IKKE ferdig persistert ennå - `act_result IS NULL`) kan
    // IKKE skilles fra "et tidligere forsøk krasjet" - `actOn()` velger
    // derfor det TRYGGESTE utfallet og kaster `SituationActInFlightError`
    // i STEDET for å risikere et EKTE samtidig dobbelt `execute()`-kall (se
    // den klassens doc-kommentar). En SEKVENSIELL retry med SAMME nøkkel
    // ETTER at forrige forsøk faktisk FULLFØRTE persisteringen
    // (`act_result` er satt) er derimot TRYGG: `ToolGateway.execute()` sin
    // EGEN idempotency_key-dedupe (tool_executions) er pålitelig for et
    // SEKVENSIELT kall (den forrige raden er allerede committet), så den
    // FAKTISKE side-effekten skjer likevel aldri to ganger.
    await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: claimedRows } = await client.query(
        `UPDATE situations
         SET act_claimed_at = now(), act_idempotency_key = $3
         WHERE tenant_id = $1 AND situation_id = $2 AND act_idempotency_key IS NULL
         RETURNING *`,
        [tenantId, situationId, idempotencyKey]
      );
      if (claimedRows[0]) {
        return;
      }
      const { rows: existingRows } = await client.query(`SELECT * FROM situations WHERE tenant_id = $1 AND situation_id = $2`, [tenantId, situationId]);
      const existingSituation = existingRows[0] as Situation;
      if (existingSituation.act_idempotency_key !== idempotencyKey) {
        throw new SituationActAlreadyClaimedError(situationId);
      }
      if (existingSituation.act_result === null) {
        throw new SituationActInFlightError(situationId);
      }
    });

    const toolResult = await gateway.execute({
      identity,
      tool_id: request.tool_id,
      action: request.action,
      parameters: request.parameters,
      idempotency_key: idempotencyKey
    });

    const nextStage: SituationStage = toolResult.ok ? "act" : "escalate";
    const reasonUpdate = toolResult.ok ? situation.reason : `${situation.reason} | act_denied: ${toolResult.reason}`;

    const updated = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `UPDATE situations
         SET stage = $3, act_tool_id = $4, act_action = $5, act_result = $6, reason = $7, updated_at = now()
         WHERE tenant_id = $1 AND situation_id = $2
         RETURNING *`,
        [tenantId, situationId, nextStage, request.tool_id, request.action, toolResult.ok ? "succeeded" : "denied", reasonUpdate]
      );
      return rows[0] as Situation;
    });

    if (!toolResult.ok) {
      return { situation: updated, tool_result: toolResult };
    }

    // ACT+NOTIFY: best-effort - en varslingsfeil reverserer ALDRI den allerede bekreftede ACT-raden.
    let finalSituation = updated;
    try {
      // Funn 4 (arkitekt-review runde 1, PR #85): `notifyResult.ok` MÅ
      // sjekkes EKSPLISITT under - et Telegram-kall som returnerer NORMALT
      // med `{ok: false, ...}` (f.eks. policy-nektet av `PolicyGateway`,
      // INGEN kastet feil) skal ALDRI stille tolkes som en vellykket
      // levering. Den gamle koden stolte KUN på try/catch, som fanger en
      // KASTET feil men IKKE en normalt returnert `ok: false` - dermed
      // avanserte stadiet til 'act_notify' selv når Telegram-varselet
      // faktisk aldri ble bekreftet sendt.
      const notifyResult = await gateway.execute({
        identity,
        tool_id: "telegram",
        action: "notify",
        parameters: { message: `Jarvis utførte en handling: ${situation.reason} (${request.tool_id}.${request.action})` }
      });
      if (notifyResult.ok) {
        finalSituation = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
          const { rows } = await client.query(
            `UPDATE situations SET stage = 'act_notify', updated_at = now() WHERE tenant_id = $1 AND situation_id = $2 RETURNING *`,
            [tenantId, situationId]
          );
          return rows[0] as Situation;
        });
      }
      // notifyResult.ok === false: stadiet forblir 'act' - en ærlig, synlig
      // indikasjon på at varselet IKKE ble bekreftet levert (se filhode).
    } catch {
      // Varsel-kallet KASTET - ACT-raden (allerede skrevet over) er UENDRET beviset på at handlingen skjedde.
      // Stadiet forblir 'act' (ikke 'act_notify') - en ærlig, synlig indikasjon på at varselet IKKE ble bekreftet levert.
    }

    return { situation: finalSituation, tool_result: toolResult };
  }
}
