import type pg from "pg";
import { channelAllowedForDeviceKind, displayKindLabel, type AuthStrength, type Channel, type IdentityContext, type MemorySpace, type StepUpBindingMode } from "@jarvis/contracts";
import { withTenantTransaction } from "../db/pool.ts";
import { writeAudit } from "./audit-writer.ts";
import type { DeviceService } from "./device-service.ts";
import type { IdentityDenialReason, IdentityService } from "./identity-service.ts";
import type { IssuedSessionGrant, SessionGrantService } from "./session-grant-service.ts";
import type { SessionRef, SessionService } from "./session-service.ts";

/**
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 1 og 3): DEN ENE
 * transaksjonelle autorisasjonskjernen som brukes av BÅDE
 * `ChannelSessionAuthority` og `VoiceSessionAuthority`.
 *
 * Reviewen fant to ting i den gamle rekkefølgen (`verifyChallenge()` →
 * `resumeOrCreate()` → `resolveIdentity()`):
 *
 *   1. Et gyldig enhetsbevis med et syntaktisk gyldig, men IKKE-EKSISTERENDE
 *      memory space rakk å opprette/oppdatere en sesjonsrad FØR avslaget kom.
 *      Et avslag hadde altså en varig sideeffekt på server-eid tilstand.
 *   2. Resultatet var bare en sesjons-ID - ikke et avgrenset, revokerbart bevis.
 *
 * Denne funksjonen lukker begge: HELE autorisasjonen (medlemskaps-/enhets-/
 * space-sjekk → sesjon → grant → ALLOW-audit) kjøres i ÉN transaksjon, og et
 * avslag returnerer FØR noen skriving har skjedd - eller ruller tilbake alt,
 * hvis avslaget først kan avgjøres etter en skriving. Avslaget revideres
 * etterpå i sin egen transaksjon (`IdentityService.recordDenial()`), slik at
 * sikkerhetsauditen overlever rollbacken.
 *
 * Enhetsbeviset (`DeviceService.verifyChallenge()`) er kjørt av KALLEREN, FØR
 * denne funksjonen. Rekkefølgen er uendret sikkerhetskritisk av samme grunn som
 * i D-123: uten proof-of-possession bundet til den PÅSTÅTTE personen ville en
 * angriper med sin egen registrerte enhet kunne påstå en annen persons
 * `person_id`, og sesjonsraden ville blitt rørt før avvisningen. Nonce-en er
 * konsumert på det tidspunktet - det er tilsiktet, og skal IKKE rulles tilbake:
 * en engangs-nonce som «kommer tilbake» ved avslag ville vært et replay-hull.
 *
 * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
 * `verifyChallenge()` og DENNE funksjonen kjørte tidligere i to ADSKILTE
 * transaksjoner - beviset ble sjekket mot nøkkelen SLIK DEN STO DA, mens
 * `SessionGrantService.issueOn()` fingerprintet grantet mot nøkkelen slik den
 * sto på et SENERE tidspunkt. Roterte nøkkelen i mellomrommet, kunne en
 * forespørsel signert med den GAMLE nøkkelen ende opp med et bærer-bevis
 * fingerprintet til den NYE - `verify()` sin fingerprint-sjekk ville deretter
 * ALLTID stemme, fordi begge sider av sammenligningen kom fra samme, for
 * sene, lesing. `request.proven_key_fingerprint` er fingerprinten
 * `verifyChallenge()` FAKTISK beviste besittelse over. Denne funksjonen låser
 * (`FOR UPDATE`) og leser enhetsraden PÅ NYTT som sitt FØRSTE steg inne i
 * transaksjonen, og krever et EKSAKT fingerprint-treff FØR noen sesjons-/
 * grant-mutasjon - se `DeviceService.lockDeviceKeyOn()`. Låsen holdes til
 * commit/rollback, så en SAMTIDIG rotasjon for samme enhet serialiseres mot
 * denne autorisasjonen i stedet for å kunne smette imellom.
 *
 * WP-S1 (JARVIS-111, Q-71): KANALBINDING. Kanalen i et grant var en PÅSTAND fra en klient med en gyldig nøkkel: `auth_strength: "signed"` ble gitt for enhver kanal, og step-up godtar `signed` fra
 * web/desktop/api/mobile. Samme låste lesing som gir nøkkelen (steg 1b) gir nå OGSÅ enhetens type (`devices.device_kind`, satt av serveren ved innrulling), og kanalen sjekkes mot tabellen type -> tillatte kanaler
 * (`@jarvis/contracts`, `device-kind.ts`) FØR noen sesjons-/grant-mutasjon. Typen leses derfor under SAMME radlås som fingerprinten: en samtidig typeendring serialiseres mot autorisasjonen akkurat som en
 * samtidig nøkkelrotasjon (D-131b), og et bevis kan aldri brukes mot en type som sto i raden før låsen ble tatt.
 *   - `enforce`: en kanal som ikke hører til typen nektes (`channel_not_allowed_for_device_kind`), fail-closed og uten sideeffekt (ingen sesjon, ingen grant; avslaget revideres i egen transaksjon med type/kanal/modus).
 *   - `observe` (STANDARD, også uten verdi): grantet utstedes som før (identisk med main), og en revisjonsrad `identity.channel_binding_would_deny` forteller at enforce ville nektet. Eieren gjennomgår dem før enforce.
 */
export type ChannelBindingMode = StepUpBindingMode;

export interface DeviceAuthorityDeps {
  /** SAMME pool som tjenestene under - transaksjonen eies her, ikke i dem. */
  pool: pg.Pool;
  sessions: SessionService;
  identity: IdentityService;
  grants: SessionGrantService;
  devices: DeviceService;
  /** WP-S1: kun den eksakte verdien `enforce` nekter; alt annet (utelatt, `observe`, en feiltolket verdi) er `observe`. `main.ts` gir den parsede `JARVIS_STEPUP_CHANNEL_BINDING`. */
  channelBindingMode?: ChannelBindingMode;
}

/** Påstanden, etter at enhetsbeviset ER verifisert av kalleren. */
export interface ProvenDeviceRequest {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: MemorySpace;
  channel: Channel;
  auth_strength: AuthStrength;
  /**
   * Fingerprinten `DeviceService.verifyChallenge()` FAKTISK beviste besittelse
   * over - ALDRI utledet på nytt her. Sammenlignes mot en FERSK, LÅST lesing
   * av enhetsraden inne i transaksjonen (se filhode).
   */
  proven_key_fingerprint: string;
}

export type DeviceAuthorityDenialReason = IdentityDenialReason | "device_authority_revoked" | "channel_not_allowed_for_device_kind";

export type DeviceAuthorityOutcome =
  | { ok: true; identity: IdentityContext; session: SessionRef; grant: IssuedSessionGrant }
  | { ok: false; reason: DeviceAuthorityDenialReason };

/**
 * Kastes KUN for avslag som først kan avgjøres etter at transaksjonen har
 * skrevet noe. Poenget er å tvinge en ROLLBACK - `withTenantTransaction()`
 * ruller tilbake og kaster videre ved enhver exception.
 */
class RollbackDenial extends Error {
  constructor(readonly reason: DeviceAuthorityDenialReason) {
    super(`authority_denied: ${reason}`);
    this.name = "RollbackDenial";
  }
}

export async function authorizeProvenDevice(
  deps: DeviceAuthorityDeps,
  request: ProvenDeviceRequest,
  nowMs: number = Date.now()
): Promise<DeviceAuthorityOutcome> {
  const subject = {
    tenant_id: request.tenant_id,
    person_id: request.person_id,
    device_id: request.device_id
  };

  const bindingMode: ChannelBindingMode = deps.channelBindingMode === "enforce" ? "enforce" : "observe";
  let outcome: DeviceAuthorityOutcome | { ok: false; reason: DeviceAuthorityDenialReason; audit: Record<string, unknown> };
  try {
    outcome = await withTenantTransaction(deps.pool, request.tenant_id, async (client) => {
      // 1. FULL autorisasjon FØR enhver sesjons-sideeffekt. Ved avslag her har
      //    transaksjonen ikke skrevet noe i det hele tatt, så det finnes ikke
      //    noe å rulle tilbake - vi returnerer bare avslaget.
      const check = await deps.identity.checkAuthorizationOn(client, request);
      if (!check.ok) {
        return { ok: false, reason: check.reason } as const;
      }

      // 1b. D-131b TOCTOU-lukking: lås OG les enhetens nøkkel PÅ NYTT, inne i
      //     DENNE transaksjonen, og krev et EKSAKT treff mot fingerprinten
      //     `verifyChallenge()` faktisk beviste - FØR noen sesjons-/grant-
      //     mutasjon. En rotasjon/tilbakekalling i vinduet siden beviset gir
      //     her samme avslag som om beviset aldri hadde holdt.
      const lockedKey = await deps.devices.lockDeviceKeyOn(client, {
        tenant_id: request.tenant_id,
        person_id: request.person_id,
        device_id: request.device_id
      });
      if (!lockedKey || lockedKey.fingerprint !== request.proven_key_fingerprint) {
        return { ok: false, reason: "device_authority_revoked" } as const;
      }

      // 1c. WP-S1: KANALBINDING mot typen fra SAMME låste lesing. Fail-closed: en type som ikke er i den lukkede listen (kan ikke stå i databasen, men en lesing skal aldri gi en tilfeldig sann verdi)
      //     tillater ingen kanal. I `enforce` avslås FØR sesjon/grant; i `observe` fortsetter alt som før og «ville nektet» revideres under (i samme transaksjon som grantet).
      const bindingAllowed = channelAllowedForDeviceKind(lockedKey.device_kind, request.channel);
      const bindingFact = { mode: bindingMode, device_kind: displayKindLabel(lockedKey.device_kind), channel: request.channel };
      if (!bindingAllowed && bindingMode === "enforce") {
        return { ok: false, reason: "channel_not_allowed_for_device_kind", audit: bindingFact } as const;
      }

      // 2. Først NÅ røres server-eid sesjonstilstand.
      const session = await deps.sessions.resumeOrCreateOn(
        client,
        { tenant_id: request.tenant_id, person_id: request.person_id, device_id: request.device_id },
        request.channel
      );

      // 3. Det avgrensede, revokerbare beviset, bundet til NØYAKTIG den
      //    fingerprinten vi selv nettopp låste og verifiserte over - IKKE en
      //    ny, uavhengig lesing (det var selve TOCTOU-hullet). `issueOn()` tar
      //    derfor fingerprinten som parameter i stedet for å lese raden selv.
      const grant = await deps.grants.issueOn(
        client,
        {
          tenant_id: request.tenant_id,
          person_id: request.person_id,
          device_id: request.device_id,
          session_id: session.session_id,
          memory_space: request.memory_space,
          channel: request.channel,
          auth_strength: request.auth_strength,
          device_key_fingerprint: lockedKey.fingerprint
        },
        nowMs
      );

      if (!bindingAllowed) {
        // observe: ingenting nektes (= main), men «ville nektet» står i revisjonssporet så eieren kan gjennomgå det før enforce. `decision: ALLOW` fordi autorisasjonen ble gitt; raden er en observasjon, ikke et avslag.
        await writeAudit(
          client,
          { ...subject, session_id: session.session_id },
          { type: "identity.channel_binding_would_deny", decision: "ALLOW", reason: "channel_not_allowed_for_device_kind", payload: bindingFact }
        );
      }

      const identity = deps.identity.buildContext({ ...request, session_id: session.session_id });
      await writeAudit(
        client,
        { ...subject, session_id: session.session_id },
        { type: "identity.resolved", decision: "ALLOW" }
      );
      return { ok: true, identity, session, grant } as const;
    });
  } catch (err) {
    if (err instanceof RollbackDenial) {
      await deps.identity.recordDenial(subject, err.reason);
      return { ok: false, reason: err.reason };
    }
    throw err;
  }

  if (!outcome.ok) {
    // Avslaget skjedde FØR enhver skriving. Audit-raden skrives i sin EGEN
    // transaksjon - den skal overleve nettopp fordi ingenting annet gjorde det.
    // WP-S1: et kanalbindingsavslag bærer type/kanal/modus i revisjonsraden (aldri i svaret til klienten).
    const audit = "audit" in outcome ? outcome.audit : undefined;
    await deps.identity.recordDenial(subject, outcome.reason, "identity.denied", audit);
    return { ok: false, reason: outcome.reason };
  }
  return outcome;
}
