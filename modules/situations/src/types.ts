import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";

/**
 * UA-10 Proactive Situation Engine: provider-nøytral, JARVIS_CANONICAL
 * hendelses-/situasjons-kontrakt (D-64 - Jarvis eier modellen, en kilde er
 * ALDRI stedet den bor). Dette er et RENT KOMPOSISJONS-/tilstandslag - se
 * `service.ts` og `docs/UA10_SITUATION_ENGINE_DESIGN.md` for full
 * arkitektur-begrunnelsen. INGEN kode i denne pakken oppfinner en ny
 * anomali-detektor eller kobler til en live hendelseskilde -
 * `evaluateCandidate()` (service.ts) er en STABIL inngangskontrakt en
 * HVILKEN SOM HELST fremtidig kilde (en `business_open_loops`-bro, et
 * vision-/helse-/lokasjonshendelses-abonnement) kan kalle uten å røre
 * denne pakken igjen.
 *
 * Tilstandsmaskinen speiler masterplanens EGEN rekkefølge ordrett:
 * ignore -> remember -> inform -> suggest -> act -> act_notify -> escalate.
 * `evaluateCandidate()` tildeler KUN ignore/remember/inform/suggest
 * (deterministiske regler, INGEN modell-assistert klassifisering i P0 -
 * det krever ModelGateway/AI Council, en leverandøravhengighet BEVISST
 * utsatt her). act/act_notify/escalate nås UTELUKKENDE via en eksplisitt
 * `actOn()`-kall - ALDRI automatisk tildelt av deteksjonssyklusen selv
 * (se `service.ts` sin `actOn()`-kommentar for hele sikkerhetsbegrunnelsen).
 */
export const SituationStageSchema = z.enum(["ignore", "remember", "inform", "suggest", "act", "act_notify", "escalate"]);
export type SituationStage = z.infer<typeof SituationStageSchema>;

export const SituationPrioritySchema = z.enum(["low", "normal", "high"]);
export type SituationPriority = z.infer<typeof SituationPrioritySchema>;

export type SituationStatus = "open" | "resolved";
/**
 * KUN "succeeded"/"denied" - den FINERE "unverified"-postcondition-
 * distinksjonen `ToolGateway` sin egen `tool_executions`-tabell fører
 * (Q-34/D-130) dupliseres BEVISST IKKE her (peker, aldri kopi). Fra
 * `SituationEngine.actOn()` sitt ståsted er BÅDE en nektet OG en
 * ubekreftet handling "ingen bekreftet suksess" (`ToolResult.ok === false`
 * for begge - se `@jarvis/tool-gateway` sin egen `gateway.ts`-kommentar).
 */
export type SituationActResult = "succeeded" | "denied";

// ---------------------------------------------------------------------
// Notification policy (eier-konfigurert, Jarvis håndhever - se 056_situations.sql)
// ---------------------------------------------------------------------

export interface SituationNotificationPolicy {
  tenant_id: string;
  memory_space_id: string;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  resuppress_hours: number;
  /** WP-G4 (139): eierens eksplisitte valg om at sikkerhetssignaler (`urgent`) får bryte stille timer. Standard false. */
  critical_bypass_quiet: boolean;
  actor_person_id: string | null;
  updated_at: string;
}

export const SetSituationNotificationPolicyInputSchema = z
  .object({
    quiet_hours_start_utc: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_end_utc: z.number().int().min(0).max(23).nullable().optional(),
    resuppress_hours: z.number().int().positive().optional(),
    actor_person_id: z.string().min(1).optional()
  })
  .refine((v) => (v.quiet_hours_start_utc == null) === (v.quiet_hours_end_utc == null), {
    message: "quiet_hours_start_utc og quiet_hours_end_utc må enten begge være satt eller begge være fraværende"
  });
export type SetSituationNotificationPolicyInput = z.infer<typeof SetSituationNotificationPolicyInputSchema>;

// ---------------------------------------------------------------------
// Situations (den kanoniske tilstandsmaskinen)
// ---------------------------------------------------------------------

/**
 * Rå input for ÉN situasjons-kandidat - formen ENHVER fremtidig kilde
 * (deteksjons-sveip, hendelses-abonnement, eller en test) produserer, OG
 * formen `SituationEngine.evaluateCandidate()` tar imot direkte.
 * `detection_key` er den SAMME idempotente dedupe-identiteten som
 * `business_open_loops` sin - en gjentatt kandidat for SAMME
 * `detection_key` oppdaterer SAMME rad, oppretter ALDRI en duplikat.
 */
export const SituationCandidateInputSchema = z
  .object({
    /** Fri-tekst domenenavn (f.eks. 'spend','pipeline','deadlines','infra','home','health') - se DomainPauseRegistry for hvordan dette brukes til pause. */
    domain: z.string().min(1),
    detection_key: z.string().min(1),
    priority: SituationPrioritySchema,
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().min(1),
    owner_person_id: z.string().min(1).optional(),
    source_open_loop_id: z.string().min(1).optional(),
    /** WP-G4: sikkerhetssignal (vannlekkasje, utløst alarm). Bryter stille timer KUN hvis eieren har valgt det (`critical_bypass_quiet`); påvirker ellers ingenting. */
    urgent: z.boolean().optional(),
    /**
     * WP-G4 fiks-runde (A-LOW-6): en signalkandidat (inntaksbussen) kan aldri SENKE en åpen situasjon som allerede bærer en høyere prioritet. Flere kilder for samme nøkkel (HA og kamera for samme åpning) ga «siste vinner» som overskrev
     * prioritet, konfidens og begrunnelse. Med flagget vinner den høyeste prioriteten, og konfidens og begrunnelse følger vinneren. Uten flagget (alle eksisterende kallere: sveipene) er oppførselen uendret.
     */
    no_downgrade: z.boolean().optional()
  })
  .strict();
export type SituationCandidateInput = z.infer<typeof SituationCandidateInputSchema>;

/** Én rad i `situations` (operasjonell tilstand, IKKE append-only - se `056_situations.sql`). */
export interface Situation {
  situation_id: string;
  tenant_id: string;
  memory_space_id: string;
  domain: string;
  owner_person_id: string | null;
  source_open_loop_id: string | null;
  detection_key: string;
  stage: SituationStage;
  priority: SituationPriority;
  confidence: number | null;
  reason: string;
  status: SituationStatus;
  last_notified_at: string | null;
  act_tool_id: string | null;
  act_action: string | null;
  act_result: SituationActResult | null;
  act_idempotency_key: string | null;
  act_claimed_at: string | null;
  act_operation_fingerprint: string | null;
  act_notify_message: string | null;
  /** D-160 (P1 aktivering): frosset INFORM/SUGGEST-varseltekst, satt ATOMISK med `last_notified_at` - se 057_situations_activation.sql. */
  inform_message: string | null;
  /** D-160: settes KUN etter BEKREFTET leveranse, alltid til det eksakte `last_notified_at`-ankeret leveransen gjaldt. */
  inform_delivered_at: string | null;
  opened_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Resultatet av `evaluateCandidate()` - `newly_actionable` skiller en
 * GENUINT ny (eller nylig re-aktualisert etter re-suppress-vinduet)
 * situasjon fra en ren, stille tilstandsoppdatering av en ALLEREDE fersk
 * varslet situasjon. Kun `newly_actionable: true` bør trigge en faktisk
 * INFORM/SUGGEST-levering (f.eks. et Telegram-varsel) hos kalleren -
 * dette forhindrer "No duplicate spam for same event" strukturelt for
 * ETT OG SAMME forhold på tvers av gjentatte deteksjonssykluser.
 */
export interface EvaluateCandidateResult {
  situation: Situation;
  newly_actionable: boolean;
}

// ---------------------------------------------------------------------
// ACT (komponerer den ALLEREDE reviewte ToolGateway.execute()-pipelinen -
// se service.ts sin actOn()-kommentar for full sikkerhetsbegrunnelsen)
// ---------------------------------------------------------------------

export interface ActOnRequest {
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  idempotency_key?: string;
}

// ---------------------------------------------------------------------
// D-160 (UA-10 P1 aktivering): eierens EKSPLISITTE autonomi-grense - se
// 057_situations_activation.sql og docs/UA10_SITUATION_ENGINE_DESIGN.md §10.
// ---------------------------------------------------------------------

/** Én rad i `situation_autonomy_policies` - hvilken handling auto-ACT får kalle `actOn()` med for situasjoner i ETT domene. FRAVÆR av rad = ingen auto-ACT. */
export interface SituationAutonomyPolicy {
  tenant_id: string;
  memory_space_id: string;
  domain: string;
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
  enabled: boolean;
  /** WP-G4 (139): valgfri utløpstid. `null` = ingen utløp. En utløpt binding gir ingen ACT. */
  expires_at: string | null;
  actor_person_id: string;
  created_at: string;
  updated_at: string;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)])
);

export const SetSituationAutonomyPolicyInputSchema = z
  .object({
    /** Aldri `*` - en autonomi-policy binder ETT domene (speiler DB-CHECK-en i 057). */
    domain: z.string().min(1).refine((d) => d !== "*", { message: "domain kan ikke være '*' - en autonomi-policy binder ett domene" }),
    tool_id: z.string().min(1),
    action: z.string().min(1),
    parameters: z.record(JsonValueSchema).optional(),
    enabled: z.boolean().optional(),
    /** WP-G4: valgfri utløpstid (ISO 8601). Må ligge i fremtiden og høyst 365 dager frem (håndheves ved binding). */
    expires_at: z.string().min(10).max(40).optional()
  })
  .strict();
export type SetSituationAutonomyPolicyInput = z.infer<typeof SetSituationAutonomyPolicyInputSchema>;

/** Én situasjon som venter på INFORM/SUGGEST-leveranse (anker satt, tekst frosset, leveranse ikke bokført for DETTE ankeret). */
export interface PendingInformNotification {
  situation: Situation;
  /** Den eksakte `last_notified_at`-ISO-strengen leveransen er bundet til (nøkkel + `inform_delivered_at`-verdi). */
  anchor: string;
  message: string;
}

/** Utfallet av én leveransesyklus (`deliverPendingInformNotifications()`). Tellinger, aldri innhold - innholdet er allerede i `tool_executions`/audit. */
export interface InformDeliveryResult {
  delivered: number;
  /** Bekreftet fra durable `tool_executions`-bevis UTEN nytt transportkall (krasj mellom sending og bokføring). */
  reconciled_from_evidence: number;
  /** Ikke levert denne syklusen (transport `ok:false`/kast) - forblir ventende, prøves igjen neste sveip under SAMME nøkkel. */
  pending: number;
  /** Bevis under nøkkelen som IKKE er en `telegram`/`notify`-rad - fail-closed, aldri godtatt. */
  evidence_mismatch: number;
  /** D-396: over per-sveip-taket - utsatt til neste sveip (ikke en feil). */
  deferred: number;
  /** D-396: hoppet over fordi domenet (eller alle domener) er satt på pause. */
  paused: number;
}

/** Utfallet av én auto-ACT-syklus (`autoActPending()`). */
export interface AutoActResult {
  /** `actOn()` faktisk kalt (uansett utfall - utfallet lever i selve situasjonen/`tool_executions`). */
  attempted: number;
  succeeded: number;
  denied: number;
  /** Hoppet over FØR noe kall: domene pauset, allerede claimet av en annen kaller, eller policy deaktivert i mellomtiden. */
  skipped: number;
}
