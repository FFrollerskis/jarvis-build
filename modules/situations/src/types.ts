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
    source_open_loop_id: z.string().min(1).optional()
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
