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
 *
 * RETTELSE etter uavhengig arkitekt-review av PR #71 (2026-09-05, samme
 * D-122 - ingen ny beslutnings-ID): første versjon av porten lot en NAVNGITT
 * matriserad (`processor_row_declared: true`) alene kvalifisere en ekstern
 * behandler, og utledet sensitivitet fra en space-verdi klienten selv velger.
 * Begge deler er nå eksplisitte, fail-closed felt - se
 * `SpeechProcessorTermsStatusSchema` (matrise-regel 3) og
 * `MemorySpaceAuthoritySchema` (tillitsgrensen). Konsekvensen er ærlig og
 * tilsiktet: ekstern tale-behandling er AVVIST i dag, både fordi OpenAI-radene
 * står `IKKE VERIFISERT` og fordi voice-transporten mangler en betrodd
 * server-side space-autoritet (Q-32). D-23 er derfor IKKE påstått strukturelt
 * lukket - porten er eksplisitt PARTIAL, ikke ferdig.
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
 * Regel 3 i `PROCESSOR_REGION_MATRIX.md` som KANONISK STATUS: «Hver utfylt rad
 * krever: verifisert region, signert/akseptert databehandleravtale,
 * dokumenterte trenings- og retensjonsvilkår, og dato for kontroll.»
 *
 * Denne statusen er skilt fra `processor_row_declared` fordi de to sier helt
 * forskjellige ting, og å blande dem var nøyaktig feilen arkitekt-reviewen av
 * PR #71 fant: en rad kan være NAVNGITT (regel 1 oppfylt) samtidig som alle
 * regel-3-feltene står `IKKE VERIFISERT`. Å behandle «navngitt» som
 * ensbetydende med «kvalifisert for produksjon» ville gjort matrisens egen
 * regel 3 til en ren tekstpåstand.
 *
 * Jarvis avleder ALDRI verdien selv, og verdien inneholder ingen juridiske
 * eller hemmelige opplysninger - den er en REGISTRERT status som speiler
 * matrisen. Kun `VERIFIED` kvalifiserer en ekstern behandler; alt annet
 * (inkludert en feilaktig `NOT_APPLICABLE_LOCAL` på en ekstern behandler)
 * avvises fail-closed.
 */
export const SpeechProcessorTermsStatusSchema = z.enum([
  /** Lokal behandler: ingen overføring ut av huset, så regel 3 gjelder ikke. */
  "NOT_APPLICABLE_LOCAL",
  /**
   * Ett eller flere av regel 3-feltene står `IKKE VERIFISERT` i matrisen.
   * Dette er den FAIL-CLOSED default-verdien - en behandler uten uttrykkelig
   * registrert verifisering er ikke kvalifisert for ekstern behandling.
   */
  "NOT_VERIFIED",
  /**
   * ALLE regel 3-feltene er verifisert og datert i matrisen. Settes kun etter
   * en eier-/juridisk handling utenfor koden - aldri av Jarvis selv.
   */
  "VERIFIED"
]);
export type SpeechProcessorTermsStatus = z.infer<typeof SpeechProcessorTermsStatusSchema>;

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
 * `processor_terms_status` er regel 3, og den er IKKE valgfri: en navngitt rad
 * er ikke det samme som en kvalifisert rad. Feltet defaulter til
 * `NOT_VERIFIED` ved parsing, slik at en erklæring som mangler feltet (gammel
 * konfig, ny leverandør, ekstern JSON) faller til det fail-closed utfallet i
 * stedet for å bli tolket som kvalifisert.
 */
export const SpeechProcessorDeclarationSchema = z
  .object({
    processor_id: z.string().min(1),
    locality: SpeechProcessingLocalitySchema,
    processor_row_declared: z.boolean(),
    processor_terms_status: SpeechProcessorTermsStatusSchema.default("NOT_VERIFIED")
  })
  .strict();
export type SpeechProcessorDeclaration = z.infer<typeof SpeechProcessorDeclarationSchema>;

/**
 * HVOR memory space-verdien kommer fra - trusted boundary, ikke en preferanse.
 *
 * Arkitekt-reviewen av PR #71 fant at D-122 sin port utledet sensitivitet
 * direkte fra `identity.memory_space`, som i voice-transporten kommer fra
 * klientens `start`-melding (`apps/voice-gateway/src/server.ts`) og IKKE
 * valideres mot en server-side sesjonsautoritet. En feilkonfigurert eller
 * fiendtlig klient kunne derfor merke en helsesamtale `personal` og få
 * ikke-health-ruting. Påstanden om at D-23 var STRUKTURELT lukket var dermed
 * sterkere enn den faktiske tillitsgrensen.
 *
 * Re-audit av eksisterende identitets-sti (`modules/core/src/services/
 * identity-service.ts`, `session-service.ts`, `device-service.ts`) viser at
 * Core VERIFISERER at person/tenant/device/space EKSISTERER, men at INGEN
 * mekanisme i dag beviser at kalleren ER den påståtte personen, og at det
 * ikke finnes noen binding person/enhet → tillatte spaces. Voice-transporten
 * har ingen autentisering overhodet. En slik autoritet er en egen kanonisk
 * slice (Q-32) og oppfinnes IKKE her.
 *
 * Konsekvens, eksplisitt fail-closed: mens space-verdien kun er
 * `CLIENT_ASSERTED`, kan den ikke brukes til å KVALIFISERE for ekstern
 * behandling. Den kan fortsatt brukes til å NEKTE (en klient som selv oppgir
 * `health` blir tatt på ordet i innstrammende retning).
 */
export const MemorySpaceAuthoritySchema = z.enum([
  /** Space-verdien kommer fra en betrodd server-side autoritet. */
  "SERVER_VERIFIED",
  /** Space-verdien er oppgitt av klienten og er ikke verifisert server-side. */
  "CLIENT_ASSERTED"
]);
export type MemorySpaceAuthority = z.infer<typeof MemorySpaceAuthoritySchema>;

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
  "DENIED_PROCESSOR_ROW_NOT_DECLARED",
  /**
   * Matrise-regel 3: raden er navngitt, men region/databehandleravtale/
   * treningsvilkår/retensjon er ikke verifisert og datert. En NAVNGITT
   * behandler er ikke en KVALIFISERT behandler.
   */
  "DENIED_PROCESSOR_TERMS_NOT_VERIFIED",
  /**
   * Space-verdien er kun klient-oppgitt og har ingen server-side autoritet,
   * så den kan ikke brukes til å kvalifisere for ekstern behandling (D-23 kan
   * ikke garanteres på et felt kalleren selv velger). Se Q-32.
   */
  "DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED"
]);
export type SpeechRoutingOutcome = z.infer<typeof SpeechRoutingOutcomeSchema>;

export interface SpeechRoutingDecision {
  allowed: boolean;
  outcome: SpeechRoutingOutcome;
  /** Utledet sensitivitet for space-en; `null` KUN når space-en er ukjent. */
  sensitivity: DataSensitivity | null;
  /**
   * Hvilken tillit space-verdien hadde da avgjørelsen ble tatt. Tas med i
   * utfallet slik at `/status`, logg og revisjon ser tillitsgrensen, ikke bare
   * konklusjonen - et avslag skal aldri kunne feillleses som «space var trygg».
   */
  memory_space_authority: MemorySpaceAuthority;
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
 *    verken en ukjent space, en manglende matriserad eller en klient-oppgitt
 *    space kan gjøre skade.
 * 2. Ekstern behandler UTEN erklært matriserad avvises (matrise-regel 1) FØR
 *    space vurderes - en ikke-erklært behandler skal aldri kunne «reddes» av
 *    at space-en tilfeldigvis er lav-sensitiv.
 * 3. Ekstern behandler uten VERIFISERTE vilkår avvises (matrise-regel 3), også
 *    FØR space vurderes. Navngitt ≠ kvalifisert.
 * 4. Ukjent space avvises (fail-closed).
 * 5. `SECRET_RESTRICTED` avvises mot ekstern behandler (D-23 / regel 2). Denne
 *    kommer FØR autoritetssjekken med vilje: en klient som selv oppgir
 *    `health` skal tas på ordet i INNSTRAMMENDE retning, og avslaget skal
 *    rapportere den ekte grunnen (D-23), ikke en autoritetsteknikalitet.
 * 6. En space som kun er `CLIENT_ASSERTED` kan ikke KVALIFISERE for ekstern
 *    behandling - den kan bare nekte. Uten en betrodd server-side
 *    space-autoritet (Q-32) er dette den ærlige grensen for hva porten kan
 *    garantere: en klient kan ellers merke en helsesamtale `personal` og få
 *    ikke-health-ruting.
 *
 * Funksjonen er ren og har ingen sideeffekter: den velger IKKE en annen
 * behandler og faller ALDRI stille tilbake til noe. Kalleren må selv feile
 * synlig - et stille fallback ville vært nøyaktig feilen porten finnes for.
 *
 * `memorySpaceAuthority` er PÅKREVD: enhver kaller må ta stilling til hvor
 * space-verdien kom fra. Det finnes ingen default-verdi å «glemme».
 */
export function evaluateSpeechRouting(
  processor: SpeechProcessorDeclaration,
  memorySpace: string | undefined,
  memorySpaceAuthority: MemorySpaceAuthority
): SpeechRoutingDecision {
  const sensitivity = speechSensitivityForMemorySpace(memorySpace);
  const base = { sensitivity, memory_space_authority: memorySpaceAuthority };
  if (processor.locality === "local") {
    return { ...base, allowed: true, outcome: "ALLOWED_LOCAL_PROCESSOR" };
  }
  if (!processor.processor_row_declared) {
    return { ...base, allowed: false, outcome: "DENIED_PROCESSOR_ROW_NOT_DECLARED" };
  }
  if (processor.processor_terms_status !== "VERIFIED") {
    return { ...base, allowed: false, outcome: "DENIED_PROCESSOR_TERMS_NOT_VERIFIED" };
  }
  if (sensitivity === null) {
    return { ...base, allowed: false, outcome: "DENIED_UNKNOWN_MEMORY_SPACE", sensitivity: null };
  }
  if (sensitivity === "SECRET_RESTRICTED") {
    return { ...base, allowed: false, outcome: "DENIED_SENSITIVE_SPACE_REQUIRES_LOCAL_PROCESSOR" };
  }
  if (memorySpaceAuthority !== "SERVER_VERIFIED") {
    return { ...base, allowed: false, outcome: "DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED" };
  }
  return { ...base, allowed: true, outcome: "ALLOWED_EXTERNAL_PROCESSOR" };
}
