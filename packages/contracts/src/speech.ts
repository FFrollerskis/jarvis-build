import { z } from "zod";
import { MemorySpaceSchema, type MemorySpace } from "./identity.ts";
import type { DataSensitivity } from "./model.ts";

/**
 * D-122 (UA-7 Communications Hub, TREDJE slice) - akseptansekriterium 4:
 * «Transcription/call processing has documented retention and legal basis
 * where required».
 *
 * Dette er den KANONISKE, leverandør-uavhengige rutingsporten for
 * TALE-/TRANSKRIPSJONSBEHANDLING. Den finnes fordi dokumentasjonen alene
 * ikke er en garanti: `docs/security/DPIA_VOICE.md` PÅSTO at «ingen rå lyd
 * forlater maskinen», mens `apps/voice-gateway/src/main.ts` siden BO-12 har
 * valgt `OpenAiStt`/`OpenAiTts` som baseline så snart `OPENAI_API_KEY` er
 * satt - uten ETT eneste memory-space-hensyn. Rå lyd fra `health`-space ville
 * derfor gått til en ekstern databehandler, stikk i strid med D-23
 * («sensitive spaces ... kan kreve lokal behandling») og regel 2 i
 * `docs/security/PROCESSOR_REGION_MATRIX.md` («`health`-space kan aldri
 * sendes til en radleverandør uten egen eksplisitt beslutning»).
 *
 * ALDRI en parallell sikkerhetsvei: vokabularet er den EKSISTERENDE
 * `DataSensitivity` fra D-79/D-81 (`model.ts`), og regelformen er den SAMME
 * som `isSensitivityEligible()` i `modules/model-gateway/src/router.ts`
 * (`SECRET_RESTRICTED` ⇒ kun lokale behandlere kvalifiserer, fail-closed,
 * aldri et stille sky-fallback). Forskjellen er KUN at tale-siden utleder
 * sensitiviteten DETERMINISTISK fra memory space, fordi tale-kallere aldri
 * har satt `sensitivity` selv (det dokumenterte kablings-gapet i D-79 §3/§11).
 *
 * Jarvis avgjør ALDRI selv et rettslig grunnlag her (samme prinsipp som
 * `modules/consent`, D-91): denne koden håndhever en REGISTRERT
 * databehandler-erklæring, den utleder ingen juridisk konklusjon.
 */

/**
 * Hvor en tale-/transkripsjonsbehandler faktisk kjører. Samme distinksjon som
 * `ModelProfile.locality` i `capability-registry.ts` («local» = forlater
 * aldri maskinen/huset; «external» = rå lyd eller transkript sendes til en
 * tredjeparts databehandler).
 */
export const SpeechProcessingLocalitySchema = z.enum(["local", "external"]);
export type SpeechProcessingLocality = z.infer<typeof SpeechProcessingLocalitySchema>;

/**
 * En tale-behandler sin ERKLÆRING - ikke en Jarvis-avledet vurdering.
 *
 * `processor_row_declared` er regel 1 i `PROCESSOR_REGION_MATRIX.md` («En rad
 * med "TBD" kan ikke tas i produksjonsbruk. Punktum.») gjort STRUKTURELL:
 * en ekstern behandler uten en navngitt rad i matrisen er IKKE brukbar.
 * Default-verdien i enhver ny adapter skal være `false` slik at en fremtidig
 * leverandør (SIP/telefoni/møtetranskripsjon) som legges til UTEN en
 * matriserad blokkeres automatisk, ikke stille tas i bruk.
 *
 * MERK (ærlighet, ikke skjult): `processor_row_declared=true` betyr KUN at
 * behandleren er NAVNGITT i matrisen - det er IKKE en påstand om at
 * databehandleravtale/region/treningsvilkår/retensjon er juridisk verifisert.
 * Den verifiseringen er en eier-/juridisk handling, sporet i matrisen selv og
 * i `docs/UA7_COMMUNICATIONS_DPIA.md`.
 */
export const SpeechProcessorDeclarationSchema = z
  .object({
    processor_id: z.string().min(1),
    locality: SpeechProcessingLocalitySchema,
    processor_row_declared: z.boolean()
  })
  .strict();
export type SpeechProcessorDeclaration = z.infer<typeof SpeechProcessorDeclarationSchema>;

/**
 * Utfallet av rutingsporten. ALDRI en bar boolean (samme begrunnelse som
 * `ProcessingDecisionOutcome` i `modules/consent`): kalleren og loggen skal
 * kunne se HVORFOR, og et avslag skal aldri kunne forveksles med «ingen data».
 */
export const SpeechRoutingOutcomeSchema = z.enum([
  /** Lokal behandler - rå lyd forlater aldri maskinen. Alltid tillatt. */
  "ALLOWED_LOCAL_PROCESSOR",
  /** Ekstern behandler, erklært rad, space som ikke krever lokal behandling. */
  "ALLOWED_EXTERNAL_PROCESSOR",
  /** D-23 / matrise-regel 2: space krever lokal behandling (i dag: `health`). */
  "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR",
  /** Fail-closed: ukjent/manglende memory space klassifiseres ALDRI som lav-sensitiv. */
  "DENIED_UNKNOWN_MEMORY_SPACE",
  /** Matrise-regel 1: ekstern behandler uten navngitt rad i matrisen. */
  "DENIED_PROCESSOR_ROW_NOT_DECLARED"
]);
export type SpeechRoutingOutcome = z.infer<typeof SpeechRoutingOutcomeSchema>;

export interface SpeechRoutingDecision {
  allowed: boolean;
  outcome: SpeechRoutingOutcome;
  /** Utledet sensitivitet for space-en; `null` KUN når space-en er ukjent. */
  sensitivity: DataSensitivity | null;
}

/**
 * Deterministisk, LUKKET space → `DataSensitivity`-klassifisering for tale.
 *
 * Bevisst konservativ og migrasjonssikker: KUN `health` får
 * `SECRET_RESTRICTED`, og `SECRET_RESTRICTED` er den ENESTE klassen som
 * utelukker en ekstern behandler. Alle andre gyldige spaces beholder derfor
 * NØYAKTIG dagens ruting (ingen stille atferdsendring for en host-bevist
 * kapabilitet - samme §23-migrasjonsdisiplin som D-80/D-106).
 *
 * `health` = `SECRET_RESTRICTED` er ikke en ny beslutning: den er D-23 +
 * regel 2 i `PROCESSOR_REGION_MATRIX.md` uttrykt i det eksisterende
 * sensitivitets-vokabularet. Lyd er dessuten særlig avslørende (se
 * `DPIA_VOICE.md`: «Lyd kan avsløre helse/sensitive forhold»).
 *
 * Ukjent/ugyldig verdi → `null` (fail-closed hos kalleren). Dette er D-81 sin
 * lærdom ordrett: udefinert sensitivitet tolkes ALDRI som «public».
 */
export function speechSensitivityForMemorySpace(memorySpace: string | undefined): DataSensitivity | null {
  const parsed = MemorySpaceSchema.safeParse(memorySpace);
  if (!parsed.success) return null;
  const space: MemorySpace = parsed.data;
  switch (space) {
    case "health":
      return "SECRET_RESTRICTED";
    case "business":
    case "project":
      return "BUSINESS_CONFIDENTIAL";
    case "personal":
    case "home":
    case "guest":
    case "shared":
      return "PRIVATE";
  }
}

/**
 * Selve porten. Rekkefølgen er bevisst:
 *
 * 1. Lokal behandler er ALLTID tillatt - rå lyd forlater aldri maskinen, så
 *    verken en ukjent space eller en manglende matriserad kan gjøre skade.
 * 2. Ekstern behandler UTEN erklært matriserad avvises (matrise-regel 1) FØR
 *    space vurderes - en ikke-erklært behandler skal aldri kunne «reddes» av
 *    at space-en tilfeldigvis er lav-sensitiv.
 * 3. Ukjent space avvises (fail-closed).
 * 4. `SECRET_RESTRICTED` avvises mot ekstern behandler (D-23 / regel 2).
 *
 * Funksjonen er ren og har ingen sideeffekter: den velger IKKE en annen
 * behandler og faller ALDRI stille tilbake til noe. Kalleren må selv feile
 * synlig - et stille fallback ville vært nøyaktig feilen porten finnes for.
 */
export function evaluateSpeechRouting(
  processor: SpeechProcessorDeclaration,
  memorySpace: string | undefined
): SpeechRoutingDecision {
  const sensitivity = speechSensitivityForMemorySpace(memorySpace);
  if (processor.locality === "local") {
    return { allowed: true, outcome: "ALLOWED_LOCAL_PROCESSOR", sensitivity };
  }
  if (!processor.processor_row_declared) {
    return { allowed: false, outcome: "DENIED_PROCESSOR_ROW_NOT_DECLARED", sensitivity };
  }
  if (sensitivity === null) {
    return { allowed: false, outcome: "DENIED_UNKNOWN_MEMORY_SPACE", sensitivity: null };
  }
  if (sensitivity === "SECRET_RESTRICTED") {
    return { allowed: false, outcome: "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR", sensitivity };
  }
  return { allowed: true, outcome: "ALLOWED_EXTERNAL_PROCESSOR", sensitivity };
}
