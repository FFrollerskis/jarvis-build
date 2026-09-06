import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import type { IdentityService } from "./identity-service.ts";
import type { SessionService } from "./session-service.ts";

/**
 * D-125 (UA-7, FEMTE slice): den betrodde server-side identitets-/sesjons-
 * autoriteten for INNGÅENDE Telegram-tekst fra den konfigurerte eier-chatten.
 *
 * DENNE KLASSEN INNEHOLDER INGEN EGEN AUTORISASJONSLOGIKK - nøyaktig samme
 * disiplin som `VoiceSessionAuthority` (D-123). Den komponerer de eksisterende
 * kanoniske primitivene og «vet» ikke annet enn hva de svarer:
 *
 *   1. Tillitsankeret: chat-ID-en fra Telegram-oppdateringen sammenlignes
 *      EKSAKT med `owner_chat_id` fra BETRODD server-side konfigurasjon.
 *   2. `SessionService.resumeOrCreate()` - server-EID sesjon. Telegram oppgir
 *      aldri en `session_id`; eksisterende gjenopptaks-semantikk på tvers av
 *      kanaler (akseptansekriterium 3, fase 2) er UENDRET.
 *   3. `IdentityService.resolveIdentity()` - den kanoniske person↔tenant↔
 *      enhet↔space-konjunksjonen under RLS, med audit-rad for ALLOW og DENY.
 *
 * ---
 *
 * TILLITSGRENSE (D-122 sin dokumenterte begrensning, CLAUDE.md regel 7):
 *
 * Telegram gir INGEN deterministisk e-post-/telefon-nøkkel for en vilkårlig
 * motpart. Derfor er DENNE sliceen strukturelt begrenset til den ALLEREDE
 * konfigurerte eier-chatten. Autoriteten kan ikke utvides til fremmede
 * Telegram-brukere ved et uhell, fordi den ikke har noen kodevei som utleder
 * en identitet fra noe annet enn den konfigurerte chat-ID-en.
 *
 * `authorize()` tar med hensikt KUN en chat-ID. Den har INGEN parameter for
 * meldingstekst, avsendernavn, `@username` eller noe annet felt en angriper
 * kontrollerer. Det er den strukturelle - ikke bare den prosedyremessige -
 * garantien for at ubetrodd innhold ALDRI kan velge person, tenant,
 * memory space, sesjon, policy, scopes eller ruting. Ingen prompt-regel,
 * ingen «husk å ikke bruke teksten»: signaturen gjør det umulig.
 *
 * REKKEFØLGEN ER SIKKERHETSKRITISK (samme resonnement som D-123):
 * eier-sjekken kjøres FØRST, FØR `resumeOrCreate()`. En sesjonsrad er
 * server-eid tilstand; å gjenoppta og MUTERE eierens aktive sesjon
 * (`last_channel`, `last_device_id`, `last_active_at`) på grunn av en melding
 * fra en fremmed chat ville vært en ekte sideeffekt selv om svaret til slutt
 * ble nektet. Derfor: ingen sesjonsskriving før chatten er bevist å være
 * eierens.
 *
 * Et avslag er et normalt, revidert utfall - ikke en feil. Funksjonen kaster
 * aldri på avslag, og returnerer ALDRI en delvis grant.
 *
 * ---
 *
 * SYSTEM-OF-RECORD-AUDIT (D-64, utført FØR implementering):
 *
 * Kan den EKSISTERENDE kanoniske modellen representere «denne konfigurerte
 * eier-chatten er Tobias, i denne tenanten, i denne memory space-en, i denne
 * sesjonen»? JA, fullt ut:
 *   - `person_tenants` / `devices` / `memory_spaces` - allerede seedet av
 *     `seedOwner()` (`apps/api/src/seed.ts`), inkl. tjeneste-enheten
 *     `jarvis-core` som denne prosessen allerede opptrer som.
 *   - `sessions` - server-eid sesjonstilstand.
 *   - `conversation_channel_links` (D-119) - kanal↔identitet-pekeren, med
 *     `match_method='owner_configured'`.
 * KONKLUSJON: 0 nye tabeller, 0 nye migrasjoner, 0 nye leverandører, 0 nye
 * credentials/scopes, 0 nye system-of-record. Telegram forblir transport.
 */
export interface TelegramOwnerAuthorityDeps {
  sessions: SessionService;
  identity: IdentityService;
}

/**
 * BETRODD server-side konfigurasjon. Hver eneste verdi her kommer fra
 * prosessens egen konfigurasjon - ALDRI fra en Telegram-oppdatering.
 */
export interface TelegramOwnerAuthorityConfig {
  /** `JARVIS_TELEGRAM_CHAT_ID`. Tom/uangitt ⇒ autoriteten er permanent lukket. */
  owner_chat_id: string;
  tenant_id: string;
  person_id: string;
  /** Tjeneste-enheten prosessen allerede er seedet som (`jarvis-core`). */
  device_id: string;
  memory_space: MemorySpace;
}

export type TelegramOwnerAuthorizationResult =
  | { ok: true; identity: IdentityContext; chat_id: string }
  | {
      ok: false;
      reason:
        | "not_owner_chat"
        | "owner_chat_not_configured"
        | "malformed_chat_id"
        | "unknown_membership"
        | "unknown_device"
        | "unknown_memory_space";
    };

export class TelegramOwnerAuthority {
  constructor(
    private readonly deps: TelegramOwnerAuthorityDeps,
    private readonly config: TelegramOwnerAuthorityConfig
  ) {}

  /**
   * Avgjør om en inngående Telegram-chat-ID gir eierens kanoniske identitet.
   *
   * `rawChatId` er UBETRODD input og typet `unknown` med vilje: den kommer fra
   * en ekstern JSON-payload. Kun en ikke-tom `string` aksepteres - ingen
   * `String(...)`-tvang, som ville latt `{toString(){...}}`, `["123"]` eller
   * et tall-med-annen-presisjon smyge seg gjennom en likhetstest.
   */
  async authorize(rawChatId: unknown): Promise<TelegramOwnerAuthorizationResult> {
    // 0. En ukonfigurert eier-chat gir ALDRI autoritet. Fail-closed FØR alt
    //    annet - ellers ville `"" === ""` gjort enhver chat til eieren.
    if (this.config.owner_chat_id.length === 0) {
      return { ok: false, reason: "owner_chat_not_configured" };
    }
    if (typeof rawChatId !== "string" || rawChatId.length === 0) {
      return { ok: false, reason: "malformed_chat_id" };
    }

    // 1. Tillitsankeret. Eksakt streng-likhet mot BETRODD konfigurasjon -
    //    aldri prefiks/suffiks/«inneholder», aldri navne- eller tekstbasert
    //    gjenkjenning. Kjøres FØR enhver sesjons- eller identitetsskriving.
    if (rawChatId !== this.config.owner_chat_id) {
      return { ok: false, reason: "not_owner_chat" };
    }

    // 2. Server-EID sesjon. Telegram har aldri sagt noe om sesjons-ID.
    const session = await this.deps.sessions.resumeOrCreate(
      {
        tenant_id: this.config.tenant_id,
        person_id: this.config.person_id,
        device_id: this.config.device_id
      },
      "telegram"
    );

    // 3. Den kanoniske identitets-stien avgjør om kombinasjonen faktisk er
    //    tillatt - og skriver audit-raden for både ALLOW og DENY.
    const resolved = await this.deps.identity.resolveIdentity({
      person_id: this.config.person_id,
      tenant_id: this.config.tenant_id,
      memory_space: this.config.memory_space,
      session_id: session.session_id,
      device_id: this.config.device_id,
      channel: "telegram",
      // En bot-token er en delt hemmelighet på transporten, IKKE et
      // proof-of-possession fra en registrert enhet. `signed` ville vært en
      // løgn her (D-123: kun enhetssignatur gir `signed`).
      auth_strength: "active"
    });
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    return {
      ok: true,
      // Hvert felt kommer fra den OPPLØSTE identiteten - ingen verdi ekkoes
      // tilbake fra Telegram-oppdateringen.
      identity: resolved.identity,
      // Den KONFIGURERTE chat-ID-en, ikke den innkomne strengen. De er beviselig
      // like her, men å returnere konfigurasjonsverdien gjør det umulig for en
      // senere refaktorering å la en angriper-kontrollert streng lekke videre.
      chat_id: this.config.owner_chat_id
    };
  }
}
