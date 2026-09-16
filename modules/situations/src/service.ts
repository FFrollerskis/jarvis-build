import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { JsonValue, MemorySpace, IdentityContext } from "@jarvis/contracts";
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
import { withDomainAdvisoryLocks } from "./advisory-lock.ts";
import { ALL_DOMAINS, type DomainPauseRegistry } from "./domain-pause.ts";

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
 * Kastet av `actOn()` (Funn 3, SKJERPET i runde 2 Funn 2): situasjonen er
 * claimet av NØYAKTIG DENNE idempotens-nøkkelen (SAMME operasjons-
 * fingeravtrykk), MEN `actOn()` fant INGEN `tool_executions`-bevis for
 * nøkkelen i det hele tatt (se rekonsilieringen i `actOn()`) - ENTEN et
 * ANNET, SANN SAMTIDIG `actOn()`-kall er FORTSATT i flukt akkurat nå, ELLER
 * et TIDLIGERE forsøk krasjet FØR selve transport-kallet i det hele tatt
 * ble gjort (eller mellom transport-kallet og `tool_executions`-INSERT-en -
 * et vindu der den eksterne handlingen FAKTISK kan ha skjedd uten bevis).
 * Denne klassen kan IKKE skille disse tilfellene fra hverandre - og velger
 * derfor BEVISST det TRYGGESTE utfallet (avvis, ALDRI et nytt
 * `ToolGateway.execute()`-kall). Et NÅR et `tool_executions`-bevis FAKTISK
 * finnes (succeeded/unverified/failed - uansett status) er derimot ALLTID
 * trygt å la passere automatisk (ToolGateway sin egen idempotency_key-
 * dedupe garanterer transporten ALDRI re-invokeres) - se
 * `actOn()` sin egen rekonsilierings-kommentar. En EKTE krasj UTEN noe
 * bevis krever `releaseStuckActClaim()` - en EKSPLISITT, fail-closed
 * administrativ transisjon som RE-VERIFISERER (race-fritt, samme
 * transaksjon) at INGEN bevis har dukket opp FØR den faktisk frigjør
 * claimen - ALDRI en blind tidsavbrudd-basert auto-frigjøring (den eksterne
 * effekten kan faktisk allerede ha skjedd).
 */
export class SituationActInFlightError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_in_flight:${situationId}`);
    this.name = "SituationActInFlightError";
  }
}

/**
 * Kastet av `actOn()` (arkitekt-review runde 2, PR #85, Funn 1): situasjonen
 * er claimet med SAMME idempotens-nøkkel, MEN et ULIKT operasjons-
 * fingeravtrykk (`tool_id`/`action`/parametre er ANNERLEDES enn det som
 * faktisk ble claimet FØRST). Uten denne sjekken kunne et senere kall med
 * samme nøkkel men et annet tool/action FEILAKTIG bli persistert som
 * "succeeded" ved å gjenbruke det FØRSTE, ANNERLEDES kallets bekreftede
 * resultat (se `computeActOperationFingerprint()`).
 */
export class SituationActOperationMismatchError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_operation_mismatch:${situationId}`);
    this.name = "SituationActOperationMismatchError";
  }
}

/**
 * Kastet av `actOn()`/`releaseStuckActClaim()` (Funn 4): den oppgitte
 * `IdentityContext` sitt EGET tenant/space matcher IKKE situasjonens
 * eksplisitte `tenantId`/`memorySpace`. Sjekket FØRST, FØR noe som helst
 * DB- eller gateway-kall - en handling autorisert/utført for ETT tenant/
 * space skal ALDRI kunne registreres som resultatet av en situasjon i et
 * ANNET.
 */
export class SituationActScopeMismatchError extends Error {
  constructor(
    public readonly situationTenantId: string,
    public readonly situationMemorySpace: string,
    public readonly identityTenantId: string,
    public readonly identityMemorySpace: string
  ) {
    super(
      `situation_act_scope_mismatch:situation(${situationTenantId},${situationMemorySpace}):identity(${identityTenantId},${identityMemorySpace})`
    );
    this.name = "SituationActScopeMismatchError";
  }
}

/**
 * Kastet av `releaseStuckActClaim()` (Funn 2): et `tool_executions`-bevis
 * FAKTISK finnes for den claimede nøkkelen - claimen er IKKE "stuck", den
 * er en normal, allerede-gjenkjennelig `actOn()`-retry (se rekonsiliering i
 * `actOn()` selv). Frigjøring nektes fail-closed - en manuell frigjøring
 * her ville vært en STILLE dobbel-utførelses-risiko dersom en fremtidig
 * retry likevel invoker transporten på nytt uten evidensen intakt.
 */
export class SituationActClaimNotReleasableError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_claim_not_releasable:${situationId}`);
    this.name = "SituationActClaimNotReleasableError";
  }
}

/**
 * Kastet av `actOn()` sin varsel-rekonsiliering (arkitekt-review runde 7,
 * PR #85, Funn 1): en `tool_executions`-rad FINNES for varsel-nøkkelen,
 * MEN dens EGNE `tool_id`/`action` er IKKE `telegram`/`notify` - raden
 * BEVISER derfor IKKE at DETTE varselet faktisk ble levert (samme
 * operasjons-bindings-klasse av funn som `act_operation_fingerprint`
 * allerede lukker for selve ACT-claimen, runde 2 Funn 1 - nå ANVENDT på
 * selve rekonsilierings-BEVISET også, ikke bare på claimen). Fail-closed:
 * ALDRI stille godtatt som "bekreftet levert", ALDRI et nytt, muterbart
 * `execute()`-kall på en allerede-mistenkelig nøkkel.
 */
export class SituationActNotificationEvidenceMismatchError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_notification_evidence_mismatch:${situationId}`);
    this.name = "SituationActNotificationEvidenceMismatchError";
  }
}

/**
 * Funn 1 (arkitekt-review runde 9, PR #85): en claimet/terminal situasjon
 * UTEN en frossen varseltekst (`act_notify_message`) er strukturelt umulig
 * (DB-CHECK `situations_act_claim_tuple_ck` - hele claim-tuppelet er alle-
 * eller-ingen, runde 10). Skulle det likevel
 * observeres, kastes dette EKSPLISITT - varselteksten/-nøkkelen re-avledes
 * ALDRI stille fra den muterbare `reason`.
 */
export class SituationActNotificationPayloadMissingError extends Error {
  constructor(public readonly situationId: string) {
    super(`situation_act_notification_payload_missing:${situationId}`);
    this.name = "SituationActNotificationPayloadMissingError";
  }
}

/** Sovereign eier-/delegert autoritet for `releaseStuckActClaim()` (arkitekt-review runde 3, PR #85, Funn 2) - SAMME minimale form som `DomainPauseAuthority` (domain-pause.ts). */
export interface SituationRecoveryAuthority {
  owner_person_id: string;
}

/**
 * Kastet av `releaseStuckActClaim()` (Funn 2, arkitekt-review runde 3,
 * PR #85): scope-likhet ALENE (Funn 4, runde 2) er IKKE tilstrekkelig
 * autorisasjon for denne administrative gjenopprettings-handlingen - ETHVERT
 * identity i riktig tenant/space kunne tidligere frigjøre en claim. Krever
 * nå et konfigurert `recoveryAuthority` (se `SituationEngine`-konstruktøren)
 * PLUSS at `identity.person_id` FAKTISK matcher - fail-closed, INGEN
 * frigjøring skjer.
 */
export class SituationRecoveryUnauthorizedError extends Error {
  constructor(
    public readonly situationId: string,
    public readonly personId: string
  ) {
    super(`situation_recovery_unauthorized:${situationId}:${personId}`);
    this.name = "SituationRecoveryUnauthorizedError";
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

/** Rekursiv, nøkkel-sortert kanonisk JSON - samme verdi gir ALLTID samme streng uansett opprinnelig nøkkel-rekkefølge (brukt av `computeActOperationFingerprint()`). */
function canonicalJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonValue((value as Record<string, JsonValue>)[key]!)}`).join(",")}}`;
}

/**
 * Funn 1 (arkitekt-review runde 2, PR #85): SHA-256 over HELE den immutable
 * operasjonen `actOn()` faktisk claimer - `situation_id` (ALDRI kun i selve
 * nøkkelen, se `actOn()` sin `finalIdempotencyKey`) + `tool_id` + `action` +
 * kanonisk (nøkkel-sortert, rekursiv) JSON av parametrene. Bundet ATOMISK
 * sammen med selve claim-UPDATE-en - en retry med SAMME nøkkel men et ULIKT
 * fingeravtrykk avvises eksplisitt (`SituationActOperationMismatchError`).
 */
export function computeActOperationFingerprint(
  situationId: string,
  toolId: string,
  action: string,
  parameters: Record<string, JsonValue>
): string {
  const canonical = `${situationId} ${toolId} ${action} ${canonicalJsonValue(parameters)}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** Den EKSAKTE meldingsteksten ACT+NOTIFY sender - EGEN funksjon slik at BÅDE selve sendingen OG rekonsilieringen (se `computeNotifyKey()`) GARANTERT bruker NØYAKTIG samme tekst. */
export function buildNotifyMessage(reason: string, toolId: string, action: string): string {
  return `Jarvis utførte en handling: ${reason} (${toolId}.${action})`;
}

/**
 * Funn 1 (arkitekt-review runde 8, PR #85): `tool_id`/`action` ALENE
 * (runde 7 Funn 1) er IKKE den KOMPLETTE operasjonen - `tool_executions`
 * lagrer INGEN meldingstekst, så en rad UNDER en forutsigbar nøkkel
 * (`situation:<id>:<nøkkel>:notify`) fra et ANNET, tidligere ELLER
 * gjenbrukt `telegram.notify`-forsøk MED ET ANNET INNHOLD kunne likevel
 * blitt godtatt som "bekreftet levert" for DENNE meldingen. Løsningen
 * bruker SAMME primitiv som `act_operation_fingerprint` (runde 2 Funn 1) -
 * et innholds-avledet SHA-256-fingeravtrykk - men BINDER det DIREKTE INN I
 * selve nøkkelen (ikke en separat lagret kolonne, siden `tool_executions`
 * er ToolGateway sin EGEN, allerede reviewte tabell - runde 3 sin
 * beskjed "keep ... ToolGateway gates intact" respekteres ved å ALDRI
 * legge til en ny kolonne der). En `succeeded`-rad kan derfor KUN
 * eksistere under DENNE EKSAKTE nøkkelen hvis meldingsteksten var
 * IDENTISK - et forsøk med et ANNET innhold produserer en HELT ANNEN
 * nøkkel og treffer ALDRI denne rekonsilieringen sin SELECT i det hele
 * tatt (faller naturlig tilbake til "INGEN bevis", en trygg
 * førstegangs-utsendelse - ALDRI en stille feilaktig "bekreftet"-status).
 *
 * Funn 1 (arkitekt-review runde 9, PR #85): nøkkelen avledes KUN av den
 * FROSNE meldingsteksten `situations.act_notify_message` (satt ATOMISK i
 * selve claim-transaksjonen, se `actOn()`), ALDRI av `reason` lest på nytt
 * ved rekonsilieringstidspunktet. `evaluateCandidate()` oppdaterer `reason`
 * ved en re-deteksjon OGSÅ etter at stadiet har nådd 'act' (stadie-non-
 * regresjonen beskytter kun `stage`). Runde 8 avledet nøkkelen av den
 * MUTERBARE `reason`: ACT+varsel lyktes under nøkkelen for reason A,
 * prosessen krasjet FØR `stage='act_notify'`, en re-deteksjon endret reason
 * til B, og retryen regnet ut en ANNEN nøkkel, fant ALDRI det bekreftede
 * beviset og sendte et DUPLIKAT. Med en frossen tekst er nøkkelen identisk
 * i første sending OG i ALL senere gjenoppretting, uansett hva `reason`
 * senere blir.
 */
export function computeNotifyKey(finalIdempotencyKey: string, situationId: string, message: string): string {
  const fingerprint = computeActOperationFingerprint(situationId, "telegram", "notify", { message });
  return `${finalIdempotencyKey}:notify:${fingerprint}`;
}

function requireNotifyMessage(situation: Situation): string {
  if (situation.act_notify_message === null) {
    throw new SituationActNotificationPayloadMissingError(situation.situation_id);
  }
  return situation.act_notify_message;
}

export interface ActOnResult {
  situation: Situation;
  tool_result: ToolResult;
}

/**
 * Internt utfall av claim-transaksjonen i `actOn()` (arkitekt-review runde
 * 4, PR #85, Funn 1): skiller en HELT NY claim fra de TO replay-tilfellene
 * - BEGGE MÅ unngå et nytt `gateway.execute()`-kall (se `actOn()` sin egen
 * kommentar for HELE begrunnelsen: ToolGateway sin idempotency_key-dedupe
 * er IKKE dens FØRSTE port, så et nytt kall kan returnere `ok:false` av en
 * grunn som er HELT UBESLEKTET med selve operasjonen og dermed feilaktig
 * overskrive et allerede bekreftet utfall).
 */
type ClaimOutcome =
  | { kind: "fresh"; notifyMessage: string }
  | { kind: "terminal_replay"; situation: Situation }
  | { kind: "evidence_replay"; status: string; externalId: string | null; reason: string | null; notifyMessage: string };

export class SituationEngine {
  constructor(
    private readonly pool: pg.Pool,
    private readonly domainPauses: DomainPauseRegistry,
    /** Funn 2 (arkitekt-review runde 3, PR #85) - se `SituationRecoveryUnauthorizedError`. `undefined` gjør `releaseStuckActClaim()` UBETINGET nektet (fail-closed default - ingen gjenoppretting uten eksplisitt konfigurert autoritet). */
    private readonly recoveryAuthority?: SituationRecoveryAuthority
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
    // Funn 4 (arkitekt-review runde 2, PR #85): identitetens EGET scope MÅ
    // matche situasjonens eksplisitte tenant/space FØRST, FØR noe som helst
    // DB- eller gateway-kall - en handling autorisert/utført for ETT
    // tenant/space skal ALDRI kunne registreres som resultatet av en
    // situasjon i et ANNET.
    if (identity.tenant_id !== tenantId || identity.memory_space_id !== memorySpace) {
      throw new SituationActScopeMismatchError(tenantId, memorySpace, identity.tenant_id, identity.memory_space_id);
    }

    // Funn 3 (arkitekt-review runde 1, PR #85), UTVIDET i runde 2 Funn 1:
    // `situationId` er ALLTID en del av selve nøkkelen som FAKTISK sendes
    // til `ToolGateway.execute()` - STRUKTURELT umulig for to ULIKE
    // situasjoner å dele samme `tool_executions`-rad (og dermed "arve"
    // hverandres bekreftede resultat), UANSETT hva en kaller måtte gi som
    // sin egen `request.idempotency_key`.
    const callerKey = request.idempotency_key ?? `situation-act:${situationId}`;
    const finalIdempotencyKey = `situation:${situationId}:${callerKey}`;
    // Funn 1 (arkitekt-review runde 2, PR #85): et komplett, immutabelt
    // fingeravtrykk av SELVE OPERASJONEN (ikke bare nøkkelen) - se
    // `computeActOperationFingerprint()`.
    const operationFingerprint = computeActOperationFingerprint(situationId, request.tool_id, request.action, request.parameters);

    const situation = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM situations WHERE tenant_id = $1 AND situation_id = $2`, [tenantId, situationId]);
      if (!rows[0]) throw new SituationNotFoundError(situationId);
      return rows[0] as Situation;
    });

    // Billig, IKKE-autoritativ "fail fast" FØR vi i det hele tatt tar en
    // advisory-lås - se domain-pause.ts sitt filhode Funn 5. Den EKTE gaten
    // er advisory-låsen + DB-sjekken under.
    if (this.domainPauses.isPaused(situation.domain)) {
      throw new SituationDomainPausedError(situation.domain, this.domainPauses.pauseReason(situation.domain));
    }

    // Funn 1+2 (arkitekt-review runde 3, PR #85): HELE den kritiske
    // seksjonen - pause-sjekk, claim OG selve det eksterne
    // `ToolGateway.execute()`-kallet - kjøres NÅ under EN advisory-lås for
    // [situation.domain, ALL_DOMAINS] (se advisory-lock.ts sitt filhode).
    // Runde 2 sin "autoritative transaksjonelle" sjekk var FORTSATT racy:
    // en SELECT låser ikke fraværet av en rad, OG selve `execute()`-kallet
    // skjedde UTENFOR claim-transaksjonen (ETTER at den allerede hadde
    // committet) - en `pauseDurable()` kunne dermed committe I DET
    // VINDUET uten noen effekt på et ALLEREDE claimet forsøk. Advisory-
    // låsen lukker BEGGE vinduene: `DomainPauseRegistry.pauseDurable()`/
    // `unpauseDurable()` tar SAMME lås FØR de skriver (domain-pause.ts) -
    // de to kan ALDRI kjøre samtidig for samme domene.
    return withDomainAdvisoryLocks(this.pool, [situation.domain, ALL_DOMAINS], async () => {
      // Funn 3 (runde 1): ATOMISK, VARIG, EKSKLUSIV claim FØR noe eksternt
      // `ToolGateway.execute()`-kall gjøres. `WHERE act_idempotency_key IS
      // NULL` er BEVISST eksklusiv (IKKE "eller samme nøkkel") - KUN ÉN
      // caller, uansett om den er en SANN samtidig konkurrent eller en
      // enkel sekvensiell kaller, vinner NOENSINNE denne claimen for en
      // gitt situasjon.
      const claimOutcome = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client): Promise<ClaimOutcome> => {
        // Funn 5 (runde 2), NÅ race-fri via advisory-låsen over: DIREKTE
        // sjekk mot `situation_domain_pauses` - ALDRI kun den synkrone
        // in-memory-cachen (prosess-lokal, kan være stille u-initialisert
        // på tvers av prosesser hvis `restore()` aldri kjøres/feiler).
        const { rows: pauseRows } = await client.query(
          `SELECT domain, reason FROM situation_domain_pauses WHERE domain = $1 OR domain = $2`,
          [situation.domain, ALL_DOMAINS]
        );
        if (pauseRows.length > 0) {
          const rows = pauseRows as Array<{ domain: string; reason: string }>;
          const chosen = rows.find((r) => r.domain === ALL_DOMAINS) ?? rows[0]!;
          throw new SituationDomainPausedError(situation.domain, chosen.reason);
        }

        // Funn 1 (arkitekt-review runde 9, PR #85): raden låses FØRST
        // (`FOR UPDATE`), og varselteksten FRYSES fra DEN LÅSTE radens
        // `reason` ATOMISK SAMMEN med selve claimen (`act_notify_message`).
        // Den re-avledes ALDRI senere fra den muterbare `reason` - se
        // `computeNotifyKey()` sin doc-kommentar for hele duplikat-scenarioet.
        const { rows: lockedRows } = await client.query(
          `SELECT * FROM situations WHERE tenant_id = $1 AND situation_id = $2 FOR UPDATE`,
          [tenantId, situationId]
        );
        const locked = lockedRows[0] as Situation | undefined;
        if (!locked) throw new SituationNotFoundError(situationId);
        if (locked.act_idempotency_key === null) {
          const notifyMessage = buildNotifyMessage(locked.reason, request.tool_id, request.action);
          const { rowCount } = await client.query(
            `UPDATE situations
             SET act_claimed_at = now(), act_idempotency_key = $3, act_operation_fingerprint = $4, act_notify_message = $5
             WHERE tenant_id = $1 AND situation_id = $2 AND act_idempotency_key IS NULL`,
            [tenantId, situationId, finalIdempotencyKey, operationFingerprint, notifyMessage]
          );
          if (rowCount !== 1) throw new SituationActAlreadyClaimedError(situationId);
          return { kind: "fresh", notifyMessage };
        }
        const existingSituation = locked;
        if (existingSituation.act_idempotency_key !== finalIdempotencyKey) {
          throw new SituationActAlreadyClaimedError(situationId);
        }
        // Funn 1 (runde 2): SAMME nøkkel, men et ULIKT operasjons-
        // fingeravtrykk (et ANNET tool_id/action/parametersett for samme
        // logiske nøkkel) - avvist EKSPLISITT, ALDRI gjenbruk av et
        // tidligere, ANNERLEDES bekreftet resultat.
        if (existingSituation.act_operation_fingerprint !== operationFingerprint) {
          throw new SituationActOperationMismatchError(situationId);
        }
        // Funn 1 (arkitekt-review runde 4, PR #85): en ALLEREDE TERMINAL
        // situasjon (act_result satt) MÅ ALDRI føre til et nytt
        // `gateway.execute()`-kall - ToolGateway sin egen idempotency_key-
        // dedupe-sjekk er IKKE dens FØRSTE port: policy/parameter-
        // autorisasjon, rate limit, frozen/revoked, credential-oppslag og
        // klasse C/D-preflight kjører ALLE FØR dedupe-oppslaget. En SENERE,
        // UBESLEKTET tilstandsendring (rotert credential, strammet policy,
        // fryst connector, oppbrukt rate limit) kunne derfor få et NYTT
        // `execute()`-kall til å returnere `ok:false` FØR dedupe i det hele
        // tatt ble konsultert - og `actOn()` ville da STILLE OVERSKREVET en
        // ALLEREDE bekreftet suksess med en avvisning, SELV OM INGEN ny
        // ekstern operasjon fant sted. Terminal tilstand MÅ være monoton -
        // se `terminal_replay`-grenen under, som ALDRI kaller
        // `gateway.execute()` igjen og ALDRI skriver til situasjonen.
        if (existingSituation.act_result !== null) {
          return { kind: "terminal_replay", situation: existingSituation };
        }
        // Funn 2 (runde 2): rekonsiliér mot VARIG ToolGateway-bevis FØR vi
        // antar en permanent floke - hvis en `tool_executions`-rad FAKTISK
        // finnes for denne nøkkelen (uansett status), er utfallet ALLEREDE
        // avgjort av EN TIDLIGERE, EKTE transport-invokering - Funn 1
        // (runde 4) gjelder OGSÅ her: vi leser DET avgjorte utfallet
        // DIREKTE fra beviset (se `evidence_replay`-grenen under) i stedet
        // for å risikere et NYTT `gateway.execute()`-kall som kunne
        // returnere `ok:false` av en UBESLEKTET, SENERE grunn og dermed
        // feilaktig persistere en avvisning for en handling som FAKTISK
        // lyktes. KUN når INGEN bevis finnes i det hele tatt (ekte samtidig
        // i flukt ELLER en krasj FØR/UNDER selve transport-kallet) forblir
        // vi fail-closed - se `SituationActInFlightError` og
        // `releaseStuckActClaim()`.
        const { rows: evidenceRows } = await client.query(
          `SELECT status, external_id, postcondition_reason FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, finalIdempotencyKey]
        );
        const evidence = evidenceRows[0] as { status: string; external_id: string | null; postcondition_reason: string | null } | undefined;
        if (!evidence) {
          throw new SituationActInFlightError(situationId);
        }
        return {
          kind: "evidence_replay",
          status: evidence.status,
          externalId: evidence.external_id,
          reason: evidence.postcondition_reason,
          notifyMessage: requireNotifyMessage(existingSituation)
        };
      });

      // Funn 1 (arkitekt-review runde 4, PR #85): en ALLEREDE TERMINAL ACT
      // returneres UENDRET - INGEN nytt `gateway.execute()`-kall for SELVE
      // handlingen, INGEN ny skriving av `act_result` (se `claimOutcome`
      // sin doc-kommentar for HELE begrunnelsen). Funn 1 (arkitekt-review
      // runde 5): dette MÅ IKKE bety å hoppe over varsel-tilstanden helt -
      // en krasj MELLOM ACT-persisteringen og selve varsel-forsøket
      // (stage FORTSATT 'act'), ELLER MELLOM et BEKREFTET varsel og
      // stage-oppdateringen til 'act_notify', ville ellers latt situasjonen
      // sitte FASTLÅST på 'act' for alltid - INGEN fremtidig retry ville
      // noensinne prøvd igjen.
      if (claimOutcome.kind === "terminal_replay") {
        const existingSituation = claimOutcome.situation;
        const definition = gateway.get(request.tool_id, request.action);
        if (existingSituation.act_result !== "succeeded" || existingSituation.stage === "act_notify") {
          // Enten en bekreftet AVVIST/eskalert handling (varsel er ALDRI
          // aktuelt for et avslag), ELLER allerede FULLT bekreftet levert -
          // ingenting mer å gjøre.
          const replayed: ToolResult =
            existingSituation.act_result === "succeeded"
              ? { ok: true, output_trust: definition?.output_trust ?? "internal", deduplicated: true }
              : { ok: false, reason: existingSituation.reason };
          return { situation: existingSituation, tool_result: replayed };
        }
        // ACT bekreftet, MEN varsel-tilstanden er UAVGJORT (stage fortsatt
        // 'act'). Funn 1 (arkitekt-review runde 6, PR #85): runde 5 sin
        // fiks kalte `gateway.execute()` for varselet PÅ NYTT her -
        // NØYAKTIG samme feilmønster som runde 4 rettet for selve ACT-en.
        // `ToolGateway.execute()` sin idempotency_key-dedupe er IKKE dens
        // FØRSTE port for VARSELET heller - policy/rate-limit/frozen/
        // revoked/credential/preflight kjører ALLE FØR dedupe-oppslaget.
        // Et varsel-bevis som FAKTISK viser 'succeeded' (krasjet FØR selve
        // stage-oppdateringen) kunne derfor ALDRI bli lest hvis en SENERE,
        // UBESLEKTET port-endring (strammet policy, tilbakekalt
        // credential, fryst connector, oppbrukt rate limit) fikk et NYTT
        // `execute()`-kall til å returnere `ok:false` FØR dedupe i det
        // hele tatt ble konsultert - situasjonen ville sittet FASTLÅST på
        // 'act' for alltid, presis den floken runde 5 skulle løse.
        //
        // Rettet: les varsel-nøkkelens EGET `tool_executions`-bevis DIREKTE
        // FØRST - ALDRI via et nytt, muterbart `execute()`-kall - FØR
        // ToolGateway sin mutable autorisasjons-/credential-/rate-limit-
        // pipeline i det hele tatt vurderes. KUN når INGEN bevis finnes i
        // det hele tatt (en EKTE førstegangs-situasjon - advisory-låsen fra
        // runde 3 Funn 1+2 GARANTERER at dette ALDRI kan være en samtidig
        // i-flukt-tilstand) er et NYTT `execute()`-kall trygt og
        // nødvendig.
        // Funn 1 (arkitekt-review runde 9, PR #85): nøkkel OG melding fra den
        // FROSNE teksten satt ved claimen - ALDRI fra `existingSituation.reason`
        // (kan ha blitt endret av en re-deteksjon ETTER ACT-en).
        const notifyMessage = requireNotifyMessage(existingSituation);
        const notifyKey = computeNotifyKey(finalIdempotencyKey, situationId, notifyMessage);
        const replayedToolResult: ToolResult = { ok: true, output_trust: definition?.output_trust ?? "internal", deduplicated: true };
        const notifyEvidence = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
          const { rows } = await client.query(
            `SELECT status, tool_id, action FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
            [tenantId, notifyKey]
          );
          return rows[0] as { status: string; tool_id: string; action: string } | undefined;
        });
        // Funn 1 (arkitekt-review runde 7, PR #85): en rad UNDER varsel-
        // nøkkelen BEVISER INGENTING om DETTE varselet med mindre den
        // FAKTISK er en `telegram`/`notify`-rad - IKKE bare tilstedeværelse
        // under nøkkelen alene (samme "bind hele operasjonen, ikke bare
        // nøkkelen"-prinsipp som `act_operation_fingerprint`, runde 2 Funn
        // 1). Fail-closed: kastes EKSPLISITT, ALDRI stille godtatt, ALDRI
        // et nytt `execute()`-kall på en allerede mistenkelig nøkkel.
        if (notifyEvidence && (notifyEvidence.tool_id !== "telegram" || notifyEvidence.action !== "notify")) {
          throw new SituationActNotificationEvidenceMismatchError(situationId);
        }
        if (notifyEvidence?.status === "succeeded") {
          // Bekreftet levert - stille selv-helbred stage-oppdateringen som krasjet, UTEN noe transportkall.
          const healed = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
            const { rows } = await client.query(
              `UPDATE situations SET stage = 'act_notify', updated_at = now() WHERE tenant_id = $1 AND situation_id = $2 RETURNING *`,
              [tenantId, situationId]
            );
            return rows[0] as Situation;
          });
          return { situation: healed, tool_result: replayedToolResult };
        }
        if (notifyEvidence) {
          // Et TIDLIGERE varsel-forsøk er ALLEREDE avgjort som IKKE bekreftet (unverified/failed) -
          // stadiet står ALLEREDE ærlig på 'act'. ALDRI et nytt, muterbart forsøk på et allerede avgjort utfall.
          return { situation: existingSituation, tool_result: replayedToolResult };
        }
        // INGEN bevis i det hele tatt - en EKTE førstegangs-situasjon (advisory-låsen garanterer dette).
        let finalSituation = existingSituation;
        try {
          const notifyResult = await gateway.execute({
            identity,
            tool_id: "telegram",
            action: "notify",
            parameters: { message: notifyMessage },
            idempotency_key: notifyKey
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
        } catch {
          // Varsel-kallet KASTET - stadiet forblir 'act', en ærlig indikasjon på at varselet IKKE ble bekreftet levert.
        }
        return { situation: finalSituation, tool_result: replayedToolResult };
      }

      let toolResult: ToolResult;
      if (claimOutcome.kind === "evidence_replay") {
        // Utfallet er ALLEREDE avgjort av et TIDLIGERE, EKTE transport-kall
        // (se `claimOutcome` sin doc-kommentar) - leses DIREKTE fra beviset,
        // ALDRI via et nytt `gateway.execute()`-kall.
        const definition = gateway.get(request.tool_id, request.action);
        toolResult =
          claimOutcome.status === "succeeded"
            ? {
                ok: true,
                ...(claimOutcome.externalId !== null ? { external_id: claimOutcome.externalId } : {}),
                output_trust: definition?.output_trust ?? "internal",
                deduplicated: true
              }
            : { ok: false, reason: claimOutcome.reason ?? "postcondition_unverified:replayed" };
      } else {
        toolResult = await gateway.execute({
          identity,
          tool_id: request.tool_id,
          action: request.action,
          parameters: request.parameters,
          idempotency_key: finalIdempotencyKey
        });
      }

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
        // levering. Funn 3 (runde 2): et EGET, deterministisk
        // `idempotency_key` (avledet av selve ACT-ens nøkkel) gjør DENNE
        // varsel-utsendelsen SELV idempotent via ToolGateway sin EGEN dedupe
        // - en `actOn()`-retry ETTER en allerede FULLFØRT ACT (Funn 2 sin
        // rekonsilieringsvei over) sender derfor ALDRI et nytt, dupliserende
        // Telegram-varsel - kun DENNE ACT-ens FØRSTE bekreftede levering
        // teller.
        const notifyResult = await gateway.execute({
          identity,
          tool_id: "telegram",
          action: "notify",
          parameters: { message: claimOutcome.notifyMessage },
          idempotency_key: computeNotifyKey(finalIdempotencyKey, situationId, claimOutcome.notifyMessage)
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
    });
  }

  /**
   * Eksplisitt, administrativ gjenopprettings-transisjon (Funn 2, arkitekt-
   * review runde 2, SKJERPET runde 3, PR #85): løser en situasjon fastlåst
   * av `SituationActInFlightError` (INGEN `tool_executions`-bevis funnet)
   * NÅR en operatør/eier EKSPLISITT har verifisert (utenfor denne koden -
   * typisk direkte mot selve leverandøren) at forsøket faktisk ALDRI
   * skjedde.
   *
   * Runde 3 Funn 2 (TO separate hull i runde 2 sin versjon):
   * 1. **Autorisasjon**: scope-likhet (Funn 4, runde 2) er IKKE
   *    tilstrekkelig - ETHVERT identity i riktig tenant/space kunne
   *    tidligere frigjøre en claim, selv om dette er ment som en
   *    operatør-/eier-handling. Krever nå et konfigurert
   *    `recoveryAuthority` (konstruktøren) PLUSS at `identity.person_id`
   *    FAKTISK matcher (`SituationRecoveryUnauthorizedError` ellers).
   * 2. **Race-frihet mot selve `execute()`-kallet**: en `FOR UPDATE`-lås på
   *    `situations`-raden fenser IKKE `ToolGateway.execute()` - gatewayen
   *    låser ALDRI den raden, og skriver `tool_executions` FØRST ETTER at
   *    transporten har returnert. En rekonsiliering som KUN sjekker
   *    "finnes det bevis NÅ" kunne derfor observere "ingen bevis ennå" MENS
   *    det opprinnelige forsøket fortsatt er i preflight/transport (eller
   *    MELLOM selve side-effekten og `tool_executions`-INSERT-en), frigjøre
   *    claimen, og la et TREDJE forsøk claime og utføre PÅ NYTT. Denne
   *    metoden tar NÅ SAMME advisory-lås (`[domain, ALL_DOMAINS]`) som
   *    `actOn()` holder gjennom HELE sin kritiske seksjon (se
   *    advisory-lock.ts) FØR den i det hele tatt rekonsiliérer - et EKTE,
   *    FORTSATT i flukt `actOn()`-forsøk for SAMME domene MÅ derfor være
   *    helt ferdig (og enten ha skrevet bevis, ELLER genuint aldri startet
   *    transport-kallet) FØR denne metoden kan fortsette forbi
   *    lås-tildelingen - "ingen bevis funnet" er NÅ et race-fritt utsagn.
   *
   * `SituationActClaimNotReleasableError` hvis bevis FAKTISK finnes - da er
   * dette IKKE en fastlåst claim, men en normal `actOn()`-retry-situasjon.
   * ALDRI en blind tidsavbrudd-basert auto-frigjøring.
   */
  async releaseStuckActClaim(tenantId: string, memorySpace: MemorySpace, situationId: string, identity: IdentityContext): Promise<Situation> {
    if (identity.tenant_id !== tenantId || identity.memory_space_id !== memorySpace) {
      throw new SituationActScopeMismatchError(tenantId, memorySpace, identity.tenant_id, identity.memory_space_id);
    }
    if (!this.recoveryAuthority || identity.person_id !== this.recoveryAuthority.owner_person_id) {
      throw new SituationRecoveryUnauthorizedError(situationId, identity.person_id);
    }

    const target = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT domain FROM situations WHERE tenant_id = $1 AND situation_id = $2`, [tenantId, situationId]);
      if (!rows[0]) throw new SituationNotFoundError(situationId);
      return rows[0] as { domain: string };
    });

    return withDomainAdvisoryLocks(this.pool, [target.domain, ALL_DOMAINS], () =>
      withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        const { rows: existingRows } = await client.query(
          `SELECT * FROM situations WHERE tenant_id = $1 AND situation_id = $2 FOR UPDATE`,
          [tenantId, situationId]
        );
        const existing = existingRows[0] as Situation | undefined;
        if (!existing) throw new SituationNotFoundError(situationId);
        if (existing.act_idempotency_key === null || existing.act_result !== null) {
          // Ingenting å frigjøre - enten aldri claimet, eller allerede fullført (normalt eller avvist).
          return existing;
        }
        const { rows: evidenceRows } = await client.query(
          `SELECT 1 FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, existing.act_idempotency_key]
        );
        if (evidenceRows[0]) {
          throw new SituationActClaimNotReleasableError(situationId);
        }
        const { rows } = await client.query(
          `UPDATE situations
           SET act_claimed_at = NULL, act_idempotency_key = NULL, act_operation_fingerprint = NULL, act_notify_message = NULL, updated_at = now()
           WHERE tenant_id = $1 AND situation_id = $2
           RETURNING *`,
          [tenantId, situationId]
        );
        return rows[0] as Situation;
      })
    );
  }
}
