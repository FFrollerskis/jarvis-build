import { MemorySpaceSchema, type Channel, type IdentityContext, type MemorySpace } from "@jarvis/contracts";
import type { DeviceService } from "./device-service.ts";
import type { IdentityService } from "./identity-service.ts";
import type { SessionRef, SessionService } from "./session-service.ts";

/**
 * UA-7-GENERALISERING av D-123 (`VoiceSessionAuthority`, se den filens egen
 * doc-kommentar): den betrodde server-side sesjons-/identitetsautoriteten for
 * ENHVER kanal med enhetsbundet proof-of-possession - ikke bare tale.
 *
 * `VoiceSessionAuthority`s doc-kommentar sa det ordrett da D-123 ble skrevet:
 * "Blir en slik hviteliste en gang ønsket, er den en egen kanonisk beslutning
 * på minne-/identitetsnivå som `resolveIdentity()` skal bære for ALLE kanaler
 * samtidig - ikke bare for tale." Denne klassen ER den generaliseringen: den
 * komponerer PRESIS de samme tre eksisterende kanoniske primitivene, i PRESIS
 * samme rekkefølge, men tar `Channel` som en eksplisitt parameter i stedet for
 * å hardkode `"voice"`. Ingen ny autorisasjonslogikk oppstår her - nøyaktig
 * samme disiplin som D-123 og D-125 (`TelegramOwnerAuthority`):
 *
 *   1. `DeviceService.verifyChallenge()` - ekte Ed25519 proof-of-possession,
 *      bundet til BÅDE påstått person og tenant (`personId`-parameteren).
 *   2. `SessionService.resumeOrCreate()` - server-EID sesjon. Klienten oppgir
 *      aldri en `session_id`. Fordi denne metoden allerede gjenopptar
 *      PERSONENS aktive sesjon UANSETT kanal (fase 2 akseptansekriterium 3),
 *      får ethvert kall via DENNE klassen "kanalbytte uten ny sesjon" helt
 *      gratis - se testen for kanalbytte (mobile → web) i
 *      `modules/core/test/channel-session-authority.test.ts`.
 *   3. `IdentityService.resolveIdentity()` - den kanoniske
 *      person↔tenant↔enhet↔space-konjunksjonen under RLS, med audit-rad for
 *      både ALLOW og DENY.
 *
 * INGEN ny tabell, INGEN ny migrasjon, INGEN ny nøkkel, INGEN kanal-spesifikk
 * autorisasjonsdatabase. Se D-123 sin egen SYSTEM-OF-RECORD-AUDIT
 * (`voice-session-authority.ts`) - den gjelder ordrett her også: den tillatte
 * space-mengden for en person er kanonisk definert av `resolveIdentity()`,
 * uavhengig av hvilken kanal som spør.
 *
 * ---
 *
 * REKKEFØLGEN ER SIKKERHETSKRITISK, av NØYAKTIG samme grunn som D-123:
 * enhetsbeviset kjøres FØRST og bindes til den påståtte personen
 * (`verifyChallenge(..., personId)`) FØR noen sesjonsrad røres. Uten den
 * bindingen ville en angriper med sin EGEN gyldig registrerte enhet kunne
 * bevise enheten, men påstå en ANNEN persons `person_id` - og
 * `resumeOrCreate()` ville da MUTERT offerets aktive sesjonsrad
 * (`last_channel`, `last_device_id`, `last_active_at`) FØR `resolveIdentity()`
 * rakk å avvise kombinasjonen. Avslaget hadde kommet, men skaden - en
 * kryss-person-sideeffekt på en server-eid tilstandsrad - hadde allerede
 * skjedd. Derfor: ingen sesjonsskriving før prinsipalen er bevist. Dette
 * gjelder for `mobile`/`watch`/`desktop`/`web`/`api` nøyaktig som for `voice`.
 *
 * Et avslag er et normalt, revidert utfall - ikke en feil. `authorize()`
 * kaster aldri på avslag, og returnerer ALDRI en delvis autoritet.
 *
 * ---
 *
 * REFAKTORERINGSBESLUTNING (påkrevd av byggeordren - dokumentert her fordi
 * DENNE filen er generaliseringen `VoiceSessionAuthority` selv pekte mot):
 *
 * `VoiceSessionAuthority` er BEVISST IKKE gjort om til en tynn wrapper rundt
 * denne klassen. Den er en egen, uendret klasse. Begrunnelse:
 *
 *   - `VoiceSessionAuthority` har en egen, adversarielt uttestet
 *     bevismateriale-kontrakt (`VoiceAuthorizationEvidenceSchema`, et ekte
 *     `.strict()` zod-skjema i `packages/contracts/src/voice-authority.ts`)
 *     og et eget utstedt objekt (`VoiceSessionGrant`, med
 *     `memory_space_authority: "SERVER_VERIFIED"` som en LITERAL og en
 *     tale-spesifikk `VOICE_GRANT_TTL_MS`). Denne klassen returnerer i stedet
 *     den oppløste `IdentityContext` direkte - riktig for en generisk
 *     kanalautoritet uten en tale-spesifikk utløpspolicy, men et ANNET
 *     kontraktformat enn `VoiceSessionGrant`.
 *   - En wrapper måtte enten (a) oversette mellom de to formatene ved hvert
 *     kall - ekstra kode i en sikkerhetskritisk sti uten sikkerhetsgevinst -
 *     eller (b) endre `VoiceAuthorizationEvidenceSchema`/`VoiceSessionGrant`
 *     for å gjøre de to formatene identiske, noe som ville rørt en
 *     kontraktfil denne oppgaven eksplisitt IKKE eier i denne runden.
 *   - `voice-session-authority.ts` har sin egen, allerede grundig
 *     adversarielt uttestede suite (kryss-person, kryss-tenant, kryss-space,
 *     tilbakekalt enhet, replay, utløpt nonce, smuglet bevismateriale). Å
 *     legge en indirection inn i den stien for DRY sin egen skyld, uten at
 *     noen ny funksjonalitet krever det, er nøyaktig den typen unødvendig
 *     regresjonsrisiko i sikkerhetskritisk kode byggeordren advarer mot.
 *
 * Konklusjon: To uavhengige, parallelle klasser som komponerer de SAMME tre
 * primitivene i den SAMME rekkefølgen - ikke fordi koden ikke KUNNE deles,
 * men fordi delingen her ikke betaler for seg sikkerhetsmessig. Skulle
 * `VoiceSessionGrant` og den generiske identitetsformen en dag konvergere (en
 * egen, eksplisitt kontraktbeslutning), er wrapping en ren, lav-risiko
 * refaktorering FORDI rekkefølgen og feilsemantikken allerede er identiske.
 */
export interface ChannelSessionAuthorityDeps {
  devices: DeviceService;
  sessions: SessionService;
  identity: IdentityService;
}

/** Nøyaktig de to feltene `DeviceService`s eksisterende challenge-/respons-flyt bruker. */
export interface ChannelDeviceProof {
  /** Engangs-nonce utstedt av serveren via `DeviceService.issueChallenge()`. */
  challenge: string;
  /** Base64-signatur over nonce-en, laget med enhetens private nøkkel. */
  signature: string;
}

/**
 * Klientens/transportens PÅSTAND - bevismateriale, aldri autoritet. Formen er
 * IDENTISK med `VoiceAuthorizationEvidence` (bevisst - bevismaterialet en
 * enhet legger fram er det samme uansett hvilken kanal den kobler til med),
 * men typet lokalt i `@jarvis/core` for å unngå å utvide en kontraktfil
 * (`packages/contracts/src/voice-authority.ts`) denne oppgaven ikke eier.
 */
export interface ChannelAuthorizationEvidence {
  person_id: string;
  tenant_id: string;
  device_id: string;
  /** Klienten har lov til å BE om en space - den kanoniske identitets-stien avgjør om den faktisk er tillatt. */
  memory_space: MemorySpace;
  device_proof: ChannelDeviceProof;
}

/**
 * Hvorfor en autorisasjon ble avvist. Verdiene speiler PRESIST de tilstandene
 * de gjenbrukte kanoniske primitivene faktisk eksponerer - samme enum-verdier
 * som `VoiceAuthorizationDenialReason`, ingen oppfunne feilklasser.
 */
export type ChannelAuthorizationDenialReason =
  | "device_proof_invalid"
  | "unknown_membership"
  | "unknown_device"
  | "unknown_memory_space"
  | "malformed_evidence";

export type ChannelAuthorizationResult =
  | { ok: true; identity: IdentityContext; session: SessionRef }
  | { ok: false; reason: ChannelAuthorizationDenialReason };

/** Nøklene `ChannelAuthorizationEvidence` og `ChannelDeviceProof` tillater - intet mer. */
const EVIDENCE_KEYS = ["person_id", "tenant_id", "device_id", "memory_space", "device_proof"] as const;
const PROOF_KEYS = ["challenge", "signature"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Fail-closed parsing av UBETRODD bevismateriale, uten å innføre en ny
 * zod-avhengighet i `@jarvis/core` (pakken har den ikke i dag - kun
 * `@jarvis/contracts` sine allerede bygde skjemaer brukes, som andre filer
 * her allerede gjør). Avviser eksplisitt smuglede felt (f.eks. et forsøk på å
 * oppgi `session_id` eller en ferdig autoritet selv), speilbildet av
 * `VoiceAuthorizationEvidenceSchema.strict()` sin oppførsel.
 */
function parseEvidence(raw: unknown): ChannelAuthorizationEvidence | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !(EVIDENCE_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const { person_id, tenant_id, device_id, memory_space, device_proof } = obj;
  if (!isNonEmptyString(person_id) || !isNonEmptyString(tenant_id) || !isNonEmptyString(device_id)) {
    return null;
  }
  if (!MemorySpaceSchema.safeParse(memory_space).success) {
    return null;
  }
  if (typeof device_proof !== "object" || device_proof === null || Array.isArray(device_proof)) {
    return null;
  }
  const proofObj = device_proof as Record<string, unknown>;
  if (Object.keys(proofObj).some((key) => !(PROOF_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const { challenge, signature } = proofObj;
  if (!isNonEmptyString(challenge) || !isNonEmptyString(signature)) {
    return null;
  }
  return {
    person_id,
    tenant_id,
    device_id,
    memory_space: memory_space as MemorySpace,
    device_proof: { challenge, signature }
  };
}

export class ChannelSessionAuthority {
  constructor(private readonly deps: ChannelSessionAuthorityDeps) {}

  /**
   * Avgjør om et enhetsbevis, PÅ EN GITT KANAL, gir en betrodd
   * sesjons-/identitetsautoritet. `channel` velges av den kallende
   * transportkoden (`mobile`/`watch`/`desktop`/`web`/`api` osv.) - aldri av
   * bevismaterialet selv.
   */
  async authorize(channel: Channel, rawEvidence: unknown): Promise<ChannelAuthorizationResult> {
    const evidence = parseEvidence(rawEvidence);
    if (!evidence) {
      return { ok: false, reason: "malformed_evidence" };
    }

    // 1. Proof-of-possession, bundet til person OG tenant - FØR noen
    //    sesjonsrad røres. Se SIKKERHETSKRITISK-avsnittet over.
    const proven = await this.deps.devices.verifyChallenge(
      evidence.tenant_id,
      evidence.device_id,
      evidence.device_proof.challenge,
      evidence.device_proof.signature,
      evidence.person_id
    );
    if (!proven) {
      return { ok: false, reason: "device_proof_invalid" };
    }

    // 2. Server-EID sesjon, på DENNE kanalen. `resumeOrCreate()` gjenopptar
    //    personens aktive sesjon uansett hvilken kanal som spør - dette er
    //    nøyaktig kanalbytte-kontinuiteten byggeordren krever, arvet
    //    uendret fra den eksisterende primitiven.
    const session = await this.deps.sessions.resumeOrCreate(
      { tenant_id: evidence.tenant_id, person_id: evidence.person_id, device_id: evidence.device_id },
      channel
    );

    // 3. Den kanoniske identitets-stien avgjør om space-en faktisk er tillatt.
    const resolved = await this.deps.identity.resolveIdentity({
      person_id: evidence.person_id,
      tenant_id: evidence.tenant_id,
      memory_space: evidence.memory_space,
      session_id: session.session_id,
      device_id: evidence.device_id,
      channel,
      // Enheten har bevist besittelse over den registrerte private nøkkelen -
      // det er enhetssignaturen som gir styrken, ikke kanalvalget (BO-12 §43,
      // samme resonnement som D-123: verken tale eller noen annen kanal alene
      // gir forhøyet styrke).
      auth_strength: "signed"
    });
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    return { ok: true, identity: resolved.identity, session };
  }
}
