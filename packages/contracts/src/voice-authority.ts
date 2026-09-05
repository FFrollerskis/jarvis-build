import { z } from "zod";
import { AuthStrengthSchema, MemorySpaceSchema } from "./identity.ts";
import { MemorySpaceAuthoritySchema, type MemorySpaceAuthority } from "./speech.ts";

/**
 * D-123 (UA-7, FJERDE slice) - Q-32 punkt (2): betrodd server-side
 * sesjons-/memory-space-autoritet for voice-transporten.
 *
 * Q-32 punkt (2) beskrev hullet presist: `apps/voice-gateway/src/server.ts`
 * tok `person_id`/`tenant_id`/`device_id`/`memory_space` UENDRET fra klientens
 * `start`-melding, og `VOICE_MEMORY_SPACE_AUTHORITY` var en hardkodet
 * `CLIENT_ASSERTED`-konstant. D-122 sin rutingsport kunne derfor bare NEKTE
 * ekstern behandling - den kunne aldri GARANTERE at en `personal`-merket
 * samtale ikke egentlig var en `health`-samtale. D-23 var følgelig ikke
 * strukturelt lukket for tale.
 *
 * Denne modulen definerer TILLITSGRENSEN som en kontrakt, ikke som en
 * konvensjon:
 *
 * - `VoiceAuthorizationEvidence` er ALT klienten sender. Navnet er bevisst
 *   «evidence» og ikke «identity»: feltene er PÅSTANDER som skal bevises, og
 *   ingen av dem kan promotere seg selv til autoritet. Skjemaet er `.strict()`,
 *   så en klient som prøver å smugle inn f.eks. et ferdig `grant`-felt får en
 *   parse-feil i stedet for stille aksept.
 * - `VoiceSessionGrant` er UTSTEDT AV SERVEREN, aldri mottatt fra klienten.
 *   `memory_space_authority` er en LITERAL `"SERVER_VERIFIED"` - det finnes
 *   ingen gyldig grant med et svakere nivå, og ingen klientverdi kan parses
 *   til en grant uten å ha gått gjennom Core sin autoritetstjeneste.
 *
 * ALDRI et andre identitetssystem: grant-en inneholder ikke ÉN opplysning som
 * ikke stammer fra de eksisterende kanoniske primitivene
 * (`DeviceService.verifyChallenge()` → `SessionService.resumeOrCreate()` →
 * `IdentityService.resolveIdentity()`), og den lagres ikke i noen ny tabell.
 * Den er en transportrepresentasjon av et allerede fattet, allerede revidert
 * server-side vedtak - se `modules/core/src/services/voice-session-authority.ts`.
 *
 * D-122 er UENDRET og overordnet: en grant sier KUN hvor space-verdien kom
 * fra. Den sier ingenting om databehandleren. En `SERVER_VERIFIED` grant gir
 * fortsatt AVSLAG mot OpenAI STT/TTS så lenge `processor_terms_status` er
 * `NOT_VERIFIED` (Q-32 punkt (1), en ren eier-/juridisk handling).
 */

/**
 * Enhetsbeviset klienten legger fram. Nøyaktig de to feltene den EKSISTERENDE
 * `DeviceService`-challenge-/respons-flyten allerede bruker
 * (`POST /devices/challenge` → signér nonce med den registrerte enhetsnøkkelen)
 * - ingen ny kryptomekanisme, ingen ny nøkkelhåndtering.
 */
export const VoiceDeviceProofSchema = z
  .object({
    /** Engangs-nonce utstedt av serveren via `DeviceService.issueChallenge()`. */
    challenge: z.string().min(1),
    /** Base64-signatur over nonce-en, laget med enhetens private nøkkel. */
    signature: z.string().min(1)
  })
  .strict();
export type VoiceDeviceProof = z.infer<typeof VoiceDeviceProofSchema>;

/**
 * Klientens PÅSTAND - bevismateriale, aldri autoritet.
 *
 * Merk at `memory_space` er med her: klienten har lov til å BE om en space.
 * Den får den kun hvis den kanoniske identitets-stien faktisk tillater
 * kombinasjonen person↔tenant↔enhet↔space. En avvist kombinasjon gir ingen
 * grant i det hele tatt - aldri en «nesten-grant» med lavere space.
 */
export const VoiceAuthorizationEvidenceSchema = z
  .object({
    person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    device_id: z.string().min(1),
    memory_space: MemorySpaceSchema,
    device_proof: VoiceDeviceProofSchema
  })
  .strict();
export type VoiceAuthorizationEvidence = z.infer<typeof VoiceAuthorizationEvidenceSchema>;

/**
 * Hvorfor en autorisasjon ble avvist. ALDRI en bar boolean (samme begrunnelse
 * som `SpeechRoutingOutcome` i `speech.ts`): et avslag skal kunne revideres,
 * og «enheten kunne ikke bevise seg» er en helt annen hendelse enn «personen
 * er ikke medlem av tenanten».
 *
 * Verdiene speiler nøyaktig de tilstandene de GJENBRUKTE kanoniske primitivene
 * faktisk eksponerer - ingen oppfunne feilklasser.
 */
export const VoiceAuthorizationDenialReasonSchema = z.enum([
  /**
   * `DeviceService.verifyChallenge()` returnerte false. Dekker ALLE tilstandene
   * den primitiven eksponerer: ukjent/utløpt/allerede brukt challenge (60 s,
   * engangs), signatur som ikke validerer, enhet uten registrert offentlig
   * nøkkel (= tilbakekalt enhet: `devices.public_key_pem IS NULL`), og enhet
   * som ikke tilhører den påståtte personen/tenanten.
   */
  "device_proof_invalid",
  /** `resolveIdentity()`: personen er ikke medlem av tenanten (kryss-tenant). */
  "unknown_membership",
  /** `resolveIdentity()`: enheten finnes ikke for denne personen i denne tenanten. */
  "unknown_device",
  /** `resolveIdentity()`: memory space-en finnes ikke i tenanten (kryss-space). */
  "unknown_memory_space",
  /** Forespørselen validerte ikke mot `VoiceAuthorizationEvidenceSchema`. */
  "malformed_evidence"
]);
export type VoiceAuthorizationDenialReason = z.infer<typeof VoiceAuthorizationDenialReasonSchema>;

/**
 * Hvor lenge en utstedt grant er gyldig. Bevisst kort og bevisst en konstant,
 * ikke en konfigverdi: en «konfigurerbar tillitslevetid» er en knapp noen før
 * eller siden skrur til uendelig. En samtale som varer lenger enn dette må
 * bevise enheten på nytt - det er billig (én signatur) og det er hele poenget
 * med proof-of-possession.
 */
export const VOICE_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Serverens vedtak. Utstedes KUN av `VoiceSessionAuthority.authorize()` i Core.
 *
 * `memory_space_authority` er en LITERAL, ikke `MemorySpaceAuthoritySchema`:
 * en grant med `CLIENT_ASSERTED` skal ikke kunne EKSISTERE. Det gjør det
 * umulig å konstruere en «grant» som ser gyldig ut, men bærer et svakt
 * tillitsnivå - typesystemet og parseren avviser den.
 *
 * Alle identitetsfeltene er kopiert fra den OPPLØSTE `IdentityContext`, aldri
 * fra forespørselen. Det er forskjellen på «klienten sa `health`» og «serveren
 * fant `health` i denne tenantens `memory_spaces` for denne personens enhet».
 */
export const VoiceSessionGrantSchema = z
  .object({
    person_id: z.string().min(1),
    tenant_id: z.string().min(1),
    device_id: z.string().min(1),
    /** Server-eid sesjon fra `SessionService.resumeOrCreate()` - aldri klient-oppgitt. */
    session_id: z.string().min(1),
    /** Den FAKTISK tillatte space-en, lest ut av den oppløste identiteten. */
    memory_space: MemorySpaceSchema,
    memory_space_authority: z.literal("SERVER_VERIFIED"),
    /**
     * `signed` - enheten beviste besittelse av privat nøkkel. Samme verdi som
     * den eksisterende `/devices/challenge/verify`-ruten returnerer. Tale gir
     * ALDRI i seg selv forhøyet styrke (BO-12 §43); styrken kommer fra
     * enhetssignaturen, ikke fra at kanalen er tale.
     */
    auth_strength: AuthStrengthSchema,
    /** Absolutt utløp (epoch ms). Håndheves av transporten ved hver bruk. */
    expires_at_ms: z.number().int().positive()
  })
  .strict();
export type VoiceSessionGrant = z.infer<typeof VoiceSessionGrantSchema>;

/** Resultatet av et autorisasjonsforsøk. Aldri `null` som «kanskje». */
export const VoiceAuthorizationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), grant: VoiceSessionGrantSchema }).strict(),
  z.object({ ok: z.literal(false), reason: VoiceAuthorizationDenialReasonSchema }).strict()
]);
export type VoiceAuthorizationResult = z.infer<typeof VoiceAuthorizationResultSchema>;

/**
 * DEN ENESTE funksjonen som kan gi en transport `"SERVER_VERIFIED"`.
 *
 * Alt annet - manglende grant, utløpt grant, en grant som ikke validerer -
 * faller til `"CLIENT_ASSERTED"`, som per D-122 kun kan NEKTE ekstern
 * behandling og aldri kvalifisere for den. Nedgraderingen er derfor alltid
 * innstrammende: en utløpt grant kan aldri gi MER tilgang enn ingen grant.
 *
 * Ren funksjon, eksplisitt `nowMs`: en tidsavhengig sikkerhetsgrense som leser
 * klokka selv kan ikke testes deterministisk, og en utestbar grense er i
 * praksis en uprøvd grense.
 */
export function voiceAuthorityFromGrant(
  grant: VoiceSessionGrant | null | undefined,
  nowMs: number
): MemorySpaceAuthority {
  const parsed = VoiceSessionGrantSchema.safeParse(grant);
  if (!parsed.success) {
    return "CLIENT_ASSERTED";
  }
  if (parsed.data.expires_at_ms <= nowMs) {
    return "CLIENT_ASSERTED";
  }
  return MemorySpaceAuthoritySchema.parse(parsed.data.memory_space_authority);
}
