import {
  ChannelSchema,
  MemorySpaceSchema,
  type Channel,
  type IdentityContext,
  type MemorySpace,
  type SessionGrant
} from "@jarvis/contracts";
import { authorizeProvenDevice, type DeviceAuthorityDeps } from "./device-authority.ts";
import type { DeviceService } from "./device-service.ts";
import type { SessionRef } from "./session-service.ts";

/**
 * UA-7-GENERALISERING av D-123 (`VoiceSessionAuthority`): den betrodde
 * server-side sesjons-/identitetsautoriteten for ENHVER kanal med enhetsbundet
 * proof-of-possession - ikke bare tale. Klassen komponerer PRESIS de samme
 * eksisterende kanoniske primitivene, men tar `Channel` som en eksplisitt
 * parameter i stedet for å hardkode `"voice"`. Ingen ny autorisasjonslogikk
 * oppstår her.
 *
 * ---
 *
 * D-131 (uavhengig arkitektkontroll av PR #79) - HVA SOM ENDRET SEG:
 *
 * **Funn 1 - samtalekontinuitet var brukt som device-authentication.**
 * `authorize()` returnerte tidligere kun en sesjons-ID, og `/chat`/`/brief`
 * slo opp `person_id`/`device_id` fra den rå sesjonsraden. Det er strukturelt
 * feil: en sesjon er BEVISST delt mellom personens kanaler, og
 * `last_device_id` overskrives ved hvert kanalbytte (se `SessionService`).
 * Nå utstedes i tillegg et SERVERUTSTEDT, AVGRENSET og REVOKERBART grant
 * (`session_grants`, migrasjon 053) bundet til NØYAKTIG den beviste enheten,
 * det autoriserte scopet, kanalen og et utløp - og med en fingerprint av
 * enhetsnøkkelen, slik at tilbakekalling/rotasjon dreper beviset STRUKTURELT.
 * `session_id` returneres fortsatt, men som ren samtalekontinuitet: mange
 * enheters grants kan peke på SAMME samtale uten å dele autoritet.
 *
 * **Funn 3 - avslått autorisasjon kunne mutere sesjonen.** Rekkefølgen var
 * `verifyChallenge()` → `resumeOrCreate()` → `resolveIdentity()`, så et gyldig
 * enhetsbevis med en ikke-eksisterende memory space rakk å opprette/oppdatere
 * en sesjonsrad før DENY. Hele autorisasjonen kjøres nå i ÉN transaksjon i
 * `authorizeProvenDevice()`, som validerer medlemskap/enhet/space FØR noen
 * sesjons-sideeffekt og ruller tilbake hvis et avslag først kan avgjøres
 * senere. I tillegg valideres `channel` mot kontraktens ENUM
 * (`ChannelSchema`) - HTTP-ruten sjekket tidligere kun `typeof === "string"`,
 * så en vilkårlig streng ble skrevet rett inn i `sessions.last_channel` og i
 * audit-radene (CLAUDE.md regel 4: kilden som merkes må være sann).
 *
 * ---
 *
 * REKKEFØLGEN ER FORTSATT SIKKERHETSKRITISK: enhetsbeviset kjøres FØRST og
 * bindes til den påståtte personen (`verifyChallenge(..., personId)`) FØR noe
 * annet. Uten den bindingen kunne en angriper med sin EGEN gyldig registrerte
 * enhet bevise enheten, men påstå en ANNEN persons `person_id`.
 *
 * Et avslag er et normalt, revidert utfall - ikke en feil. `authorize()` kaster
 * aldri på avslag, og returnerer ALDRI en delvis autoritet.
 *
 * WP-S1 (JARVIS-111): kanalen er fortsatt en PÅSTAND fra klienten, men serveren sjekker den nå mot enhetens
 * type (`devices.device_kind`) i autorisasjonskjernen (`authorizeProvenDevice`, se den filen): i `enforce`
 * nektes en kanal som ikke hører til typen med `channel_not_allowed_for_device_kind`; i `observe` (standard)
 * revideres «ville nektet». `ChannelSchema`-valideringen over er uendret (ukjent kanal gir `unknown_channel`).
 */
export interface ChannelSessionAuthorityDeps extends DeviceAuthorityDeps {
  devices: DeviceService;
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
 * (`packages/contracts/src/voice-authority.ts`) denne stien ikke eier.
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
 * de gjenbrukte kanoniske primitivene faktisk eksponerer - ingen oppfunne
 * feilklasser.
 */
export type ChannelAuthorizationDenialReason =
  | "device_proof_invalid"
  | "unknown_membership"
  | "unknown_device"
  | "unknown_memory_space"
  | "malformed_evidence"
  /** D-131 funn 3: `channel` var ikke en verdi i kontraktens `ChannelSchema`. */
  | "unknown_channel"
  /** D-131 funn 1: enhetens nøkkel forsvant mellom bevis og utstedelse - fail-closed. */
  | "device_authority_revoked"
  /** WP-S1 (JARVIS-111): kanalen hører ikke til enhetens type (kun i modus `enforce`; se `device-authority.ts`). */
  | "channel_not_allowed_for_device_kind";

export type ChannelAuthorizationResult =
  | { ok: true; identity: IdentityContext; session: SessionRef; grant: SessionGrant }
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
 * oppgi `session_id`, `grant_token` eller en ferdig autoritet selv),
 * speilbildet av `VoiceAuthorizationEvidenceSchema.strict()` sin oppførsel.
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
   * sesjons-/identitetsautoritet, og utsteder i så fall et avgrenset,
   * revokerbart grant.
   *
   * `rawChannel` er typet `unknown` med vilje: den kommer fra transportkoden,
   * som igjen kan ha lest den fra en ubetrodd HTTP-kropp. D-131 funn 3 var
   * nettopp at ruten kun sjekket `typeof === "string"` - valideringen mot
   * kontraktens enum hører hjemme HER, slik at det finnes ÉN valideringssannhet
   * uansett hvilken transport som kaller.
   */
  async authorize(rawChannel: unknown, rawEvidence: unknown): Promise<ChannelAuthorizationResult> {
    const channel = ChannelSchema.safeParse(rawChannel);
    if (!channel.success) {
      return { ok: false, reason: "unknown_channel" };
    }
    const evidence = parseEvidence(rawEvidence);
    if (!evidence) {
      return { ok: false, reason: "malformed_evidence" };
    }

    // 1. Proof-of-possession, bundet til person OG tenant - FØR noe annet.
    //    Se SIKKERHETSKRITISK-avsnittet over. Fingerprinten som kommer
    //    tilbake er NØYAKTIG nøkkelen dette beviset gjaldt - D-131b krever at
    //    `authorizeProvenDevice()` låser og sammenligner mot DENNE, ikke en
    //    senere, uavhengig lesing (se den filens filhode).
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

    // 2. Den transaksjonelle autorisasjonskjernen: medlemskap/enhet/space FØR
    //    sesjons-sideeffekt, deretter sesjon + grant + ALLOW-audit atomisk.
    //    Enheten har bevist besittelse over den registrerte private nøkkelen -
    //    det er enhetssignaturen som gir styrken, ikke kanalvalget (BO-12 §43).
    return this.finish(await this.authorizeProven(evidence, channel.data, proven));
  }

  private async authorizeProven(evidence: ChannelAuthorizationEvidence, channel: Channel, proven_key_fingerprint: string) {
    return authorizeProvenDevice(this.deps, {
      person_id: evidence.person_id,
      tenant_id: evidence.tenant_id,
      device_id: evidence.device_id,
      memory_space: evidence.memory_space,
      channel,
      auth_strength: "signed",
      proven_key_fingerprint
    });
  }

  private finish(outcome: Awaited<ReturnType<typeof authorizeProvenDevice>>): ChannelAuthorizationResult {
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    return {
      ok: true,
      identity: outcome.identity,
      session: outcome.session,
      grant: {
        // Hvert eneste felt kommer fra den OPPLØSTE identiteten, den server-eide
        // sesjonen eller det utstedte grantet - ingen verdi ekkoes fra forespørselen.
        grant_token: outcome.grant.grant_token,
        expires_at_ms: outcome.grant.expires_at_ms,
        session_id: outcome.identity.session_id,
        person_id: outcome.identity.person_id,
        tenant_id: outcome.identity.tenant_id,
        device_id: outcome.identity.device_id,
        memory_space: outcome.identity.memory_space_id,
        channel: outcome.identity.channel,
        auth_strength: outcome.identity.auth_strength
      }
    };
  }
}
