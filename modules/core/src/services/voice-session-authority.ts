import { VoiceAuthorizationEvidenceSchema, type VoiceAuthorizationResult } from "@jarvis/contracts";
import { authorizeProvenDevice, type DeviceAuthorityDeps } from "./device-authority.ts";
import type { DeviceService } from "./device-service.ts";

/**
 * D-123 (UA-7, FJERDE slice) - Q-32 punkt (2): den betrodde server-side
 * sesjons-/memory-space-autoriteten for voice-transporten.
 *
 * DENNE KLASSEN INNEHOLDER INGEN EGEN AUTORISASJONSLOGIKK. Det er hele
 * poenget. Den KOMPONERER de tre eksisterende kanoniske primitivene i den
 * rekkefølgen Q-32 selv pekte ut, og alt den «vet» er hva de svarer:
 *
 *   1. `DeviceService.verifyChallenge()` - ekte proof-of-possession
 *      (Ed25519-signatur over en engangs-nonce mot den REGISTRERTE
 *      `devices.public_key_pem`). Primitiven fantes allerede (fase 8), men var
 *      kun brukt til klasse-D-godkjenninger. D-68 sin lærdom ordrett: en
 *      eksisterende, legitim primitiv brukt UTENFOR sin tillitsgrense er
 *      strukturelt feil - så her brukes den PRESIST innenfor sin egen grense
 *      («denne enheten holder den private nøkkelen»), og den utleder ingenting
 *      mer enn det.
 *   2. `SessionService.resumeOrCreate()` - server-EID sesjon. Klienten oppgir
 *      aldri en `session_id`; den får den serveren gir den. Eksisterende
 *      gjenopptaks-semantikk (samme aktive sesjon på tvers av kanaler,
 *      akseptansekriterium 3 i fase 2) er UENDRET - metoden kalles som den er.
 *   3. `IdentityService.resolveIdentity()` - den kanoniske
 *      person↔tenant↔enhet↔space-konjunksjonen under RLS, med audit-rad for
 *      både ALLOW og DENY.
 *
 * INGEN ny tabell, INGEN ny migrasjon, INGEN ny nøkkel, INGEN ny sesjonstype,
 * INGEN voice-spesifikk autorisasjonsdatabase. Se `SYSTEM-OF-RECORD-AUDIT`
 * under.
 *
 * ---
 *
 * SYSTEM-OF-RECORD-AUDIT (påkrevd av byggeordren, utført FØR implementering):
 *
 * Spørsmålet er: kan den EKSISTERENDE kanoniske modellen representere
 * bindingen «denne beviste personen, på denne beviste enheten, i denne
 * sesjonen, har lov til NØYAKTIG denne memory space-en»? Svar: JA, fullt ut.
 *
 *   - `person_tenants (person_id, tenant_id, role)` - medlemskapet.
 *   - `devices (device_id, tenant_id, person_id, public_key_pem)` - enheten er
 *     allerede bundet til BÅDE person og tenant, og `public_key_pem` er
 *     allerede både nøkkelmateriale og tilbakekallingstilstand (NULL = ingen
 *     gyldig nøkkel ⇒ ingen bevisbar besittelse).
 *   - `memory_spaces (tenant_id, space)` UNIQUE - hvilke spaces som i det hele
 *     tatt EKSISTERER i tenanten.
 *   - `sessions (session_id, tenant_id, person_id, status, last_device_id)` -
 *     server-eid sesjonstilstand med eksplisitt `active`/`closed`.
 *
 * `resolveIdentity()` håndhever allerede nøyaktig konjunksjonen av de tre
 * første under RLS. Den tillatte space-mengden for en person er derfor
 * kanonisk definert som «spaces som finnes i en tenant personen er medlem av,
 * nådd fra en enhet som tilhører personen i den tenanten» - og det er presist
 * det `resolveIdentity()` svarer på.
 *
 * En FINERE binding (per-person eller per-enhet space-hviteliste) ble vurdert
 * og BEVISST forkastet: den finnes ikke noe sted i den kanoniske modellen i
 * dag - minne-RLS er tenant+space (D-20/D-23), ikke person+space - så å
 * innføre den her ville vært å oppfinne en NY autorisasjonsmodell inne i en
 * transport-slice, altså nøyaktig det byggeordren og Q-32 forbyr («ingen
 * voice-only authorization database»). Blir en slik hviteliste en gang
 * ønsket, er den en egen kanonisk beslutning på minne-/identitetsnivå som
 * `resolveIdentity()` skal bære for ALLE kanaler samtidig - ikke bare for tale.
 *
 * KONKLUSJON: 0 nye tabeller, 0 nye migrasjoner. Ingen RLS-endring, ingen
 * Q-20-slettesemantikk berørt (denne tjenesten skriver ingen nye rader utover
 * de `sessions`-/`audit`-radene de eksisterende primitivene allerede skriver).
 */
export interface VoiceSessionAuthorityDeps extends DeviceAuthorityDeps {
  devices: DeviceService;
}

export class VoiceSessionAuthority {
  constructor(private readonly deps: VoiceSessionAuthorityDeps) {}

  /**
   * Avgjør om et talebevis gir en betrodd sesjons-/space-autoritet.
   *
   * REKKEFØLGEN ER SIKKERHETSKRITISK:
   *
   * Enhetsbeviset kjøres FØRST, og det bindes til den påståtte personen og
   * tenanten (`verifyChallenge(..., personId)`). Uten den bindingen ville en
   * angriper med sin EGEN gyldig registrerte enhet kunne bevise enheten, men
   * påstå en ANNEN persons `person_id` - og sesjonsoppslaget ville da ha
   * gjenopptatt og MUTERT offerets aktive sesjonsrad (`last_device_id`,
   * `last_active_at`) før kombinasjonen rakk å bli avvist. Avslaget ville
   * kommet, men skaden - en kryss-person-sideeffekt på en server-eid
   * tilstandsrad - hadde allerede skjedd. Derfor: ingen sesjonsskriving før
   * prinsipalen er bevist.
   *
   * D-131 (arkitektkontroll av PR #79, funn 3): den samme klassen feil fantes
   * ETT steg lenger inn - `resumeOrCreate()` kjørte FØR medlemskaps-/space-
   * sjekken, så et gyldig enhetsbevis med en ikke-eksisterende memory space
   * muterte sesjonsraden før DENY. Hele autorisasjonen kjøres nå i ÉN
   * transaksjon (`authorizeProvenDevice()`), delt med
   * `ChannelSessionAuthority`, som validerer ALT før første skriving og ruller
   * tilbake hvis et avslag først kan avgjøres senere.
   *
   * Funksjonen kaster aldri på et avslag: et avslag er et normalt, revidert
   * utfall, ikke en feil. Den returnerer ALDRI en delvis grant.
   */
  async authorize(rawEvidence: unknown, nowMs: number = Date.now()): Promise<VoiceAuthorizationResult> {
    const parsed = VoiceAuthorizationEvidenceSchema.safeParse(rawEvidence);
    if (!parsed.success) {
      return { ok: false, reason: "malformed_evidence" };
    }
    const evidence = parsed.data;

    // 1. Proof-of-possession, bundet til person OG tenant. Dekker samtidig
    //    tilbakekalt enhet (ingen registrert nøkkel), utløpt/gjenbrukt
    //    challenge og feil signatur - alle tilstandene primitiven eksponerer.
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

    // 2-4. D-131 (arkitektkontroll av PR #79, funn 1 og 3): den DELTE,
    //      transaksjonelle autorisasjonskjernen - NØYAKTIG den samme
    //      `ChannelSessionAuthority` bruker. Den validerer medlemskap/enhet/
    //      space FØR noen sesjons-sideeffekt (tidligere kunne et gyldig
    //      enhetsbevis med ukjent space mutere sesjonsraden før DENY), og
    //      utsteder deretter sesjon + et avgrenset, revokerbart grant
    //      (`session_grants`) + ALLOW-audit ATOMISK.
    //
    //      `auth_strength: "signed"` fordi enheten HAR bevist besittelse -
    //      styrken kommer fra enhetssignaturen, ikke fra at kanalen er tale.
    const outcome = await authorizeProvenDevice(
      this.deps,
      {
        person_id: evidence.person_id,
        tenant_id: evidence.tenant_id,
        device_id: evidence.device_id,
        memory_space: evidence.memory_space,
        channel: "voice",
        auth_strength: "signed"
      },
      nowMs
    );
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }

    return {
      ok: true,
      grant: {
        // Hvert eneste felt kommer fra den OPPLØSTE identiteten, den server-eide
        // sesjonen eller det utstedte grantet - ingen verdi ekkoes fra forespørselen.
        person_id: outcome.identity.person_id,
        tenant_id: outcome.identity.tenant_id,
        device_id: outcome.identity.device_id,
        session_id: outcome.identity.session_id,
        // D-131 funn 1: det FAKTISKE bærer-beviset voice-gatewayen presenterer
        // for Core. `session_id` over er kun samtalens identitet.
        grant_token: outcome.grant.grant_token,
        memory_space: outcome.identity.memory_space_id,
        memory_space_authority: "SERVER_VERIFIED",
        auth_strength: outcome.identity.auth_strength,
        // Den AUTORITATIVE utløpstiden er den som faktisk står i grant-raden,
        // ikke en verdi regnet ut på nytt her.
        expires_at_ms: outcome.grant.expires_at_ms
      }
    };
  }
}
