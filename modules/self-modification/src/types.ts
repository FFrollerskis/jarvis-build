import { z } from "zod";

/**
 * Task #121 (D-214): Charlie sin personlighet/tone - BEVISST BEGRENSET til
 * kosmetiske, ikke-instruerende felt. Dette skjemaet er den ENESTE flaten
 * `self_modification.propose_personality_change` kan skrive til - ALDRI
 * fritekst-injeksjon i selve systemprompten. Sikkerhetskritiske klausuler
 * (ærlighet om egne evner, verktøytilgang - se `apps/api/src/conversation.ts`)
 * er HARDKODET i koden og INGEN felt her kan påvirke dem - `buildSystemPrompt()`
 * setter dem alltid til slutt, uavhengig av hva denne konfigurasjonen sier.
 *
 * Strenge lengde-/antallsgrenser er bevisste: dette er beskrivende ORD om
 * TONE (f.eks. "varm", "tørrvittig"), ikke et sted for lange, instruksjons-
 * lignende avsnitt. En eier som vil ha noe mer omfattende endret må fortsatt
 * gjennom `requires_approval`-sporet (redigere selve `conversation.ts`).
 */
export const PersonalityConfigSchema = z
  .object({
    tone_descriptors: z.array(z.string().min(1).max(40)).min(1).max(6),
    style_notes: z.string().min(1).max(400),
    updated_at: z.string().datetime(),
    updated_by: z.string().min(1)
  })
  .strict();
export type PersonalityConfig = z.infer<typeof PersonalityConfigSchema>;

/** Default/fallback - EKSAKT samme tone som den tidligere hardkodede SYSTEM_PROMPT (D-208). */
export const DEFAULT_PERSONALITY_CONFIG: PersonalityConfig = {
  tone_descriptors: ["varm", "skarp", "tørrvittig når det passer"],
  style_notes:
    "Snakk som et menneske ville gjort - naturlig og avslappet, aldri stivt eller robotaktig - " +
    "bare mye mer kunnskapsrik og alltid tilgjengelig. Svar kort og presist på norsk.",
  updated_at: "2026-09-20T00:00:00.000Z",
  updated_by: "system-default"
};

/**
 * Task #121 (D-214): den deterministiske risikoklassifiseringen - se policy.ts.
 * `zero_review`: eneste vei er `config/charlie-personality.json` alene.
 * `requires_approval`: alt annet som IKKE treffer et forbudt mønster - venter
 * på Telegram-basert eier-godkjenning (§se service.ts/transport.ts).
 * `forbidden`: rører et hardkodet sikkerhetskritisk mønster (policy/owner-
 * controls/tool-gateway-kjernen/CI/migrasjoner/lockfiler/osv.) - ALDRI
 * tilgjengelig for selvendring i det hele tatt, uansett godkjenning her.
 */
export const SelfModificationRiskSchema = z.enum(["zero_review", "requires_approval", "forbidden"]);
export type SelfModificationRisk = z.infer<typeof SelfModificationRiskSchema>;

/**
 * Speiler `self_modification_requests`-tabellen (migrasjon 060, utvidet av
 * 061). `pending_job` (task #123, D-214) er NY: en `code_change`-forespørsel
 * har, i motsetning til `personality_config`, INGEN kjent `target_paths`/
 * `branch`/PR ved opprettelsestidspunktet - den ekte kodeagent-jobben
 * (`createCodingHandler`/`ClaudeCodeAgent`) kjører ASYNKRONT via den
 * eksisterende task-køen FØR noen diff i det hele tatt eksisterer å
 * klassifisere. Raden starter derfor i `pending_job`, IKKE `pending_ci`.
 */
export type SelfModificationRequestStatus =
  | "pending_job" | "pending_ci" | "merged" | "ci_failed" | "awaiting_approval" | "approved" | "rejected" | "expired";

/**
 * INGEN `tenant_id` PÅ SELVE FORESPØRSELEN - selvendring er en GLOBAL,
 * sovereign eier-handling over DEN DELTE kodebasen/konfigurasjonen, ikke en
 * tenant-partisjonert ressurs. Samme "ingen RLS, ingen tenant_id"-presedens
 * som `owner_control_state` (058_owner_control_authority.sql) - se
 * migrasjon 060 sitt filhode for full begrunnelse.
 *
 * `coding_task_id`/`coding_tenant_id` (migrasjon 061, task #123): KUN satt
 * for `kind === "code_change"`-rader (`null` for `personality_config`) -
 * den underliggende `JobContract.task_id`/`tenant_id` som
 * `TaskService.get()` trenger for å slå opp den asynkrone kodejobbens
 * status (task-køen ER tenant-partisjonert, selv om selvendrings-raden
 * over den ikke er det).
 */
export interface SelfModificationRequest {
  request_id: string;
  kind: string;
  risk: SelfModificationRisk;
  target_paths: string[];
  branch: string;
  pr_number: string;
  pr_url: string;
  status: SelfModificationRequestStatus;
  requested_by_person_id: string;
  summary: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_person_id: string | null;
  coding_task_id: string | null;
  coding_tenant_id: string | null;
}
