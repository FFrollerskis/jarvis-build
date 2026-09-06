# PROJECT STATUS

**Oppdatert:** 2026-09-06 (branch `claude/d125-ua7-telegram-inbound-owner`, base
`main=2e86e047eec98b736987bf7704c5e28c6d8c240d`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**D-125 - UA-7 femte slice: eier-Telegram inngående som samtalekanal.**
Det siste `NOT_STARTED_PROVIDER_INDEPENDENT`-elementet i UA-7, og det denne filen selv pekte ut som
neste naturlige oppgave. Full begrunnelse: D-125 i DECISIONS_AND_ASSUMPTIONS.md.

## Omfanget er bevisst begrenset - og hvorfor

D-122-matrisen i IMPLEMENTATION_PLAN registrerer den styrende begrensningen: **Telegram gir INGEN
deterministisk e-post-/telefon-nøkkel for en vilkårlig motpart.** Sliceen er derfor strukturelt
begrenset til den ALLEREDE konfigurerte eier-chatten (`JARVIS_TELEGRAM_CHAT_ID`). Motpart-identitet
gjettes ALDRI fra visningsnavn, `@username` eller meldingstekst, og banen utvides ALDRI til
ikke-eiere. `UA7_TELEGRAM_INBOUND_NON_OWNER=NOT_BUILT_BY_DESIGN_D122` - eksplisitt ikke-bygget, ikke
stille utelatt.

## Hva som faktisk ble bygget

**NULL nye leverandører, credentials, scopes, tabeller, migrasjoner, kolonner eller
system-of-record.** Telegram forblir TRANSPORT (D-64 `EXTERNAL_CANONICAL`);
`CORE_DEPENDENCY_DECISION_REQUIRED=false`.

1. **`TelegramOwnerAuthority`** (`modules/core/src/services/telegram-owner-authority.ts`) - betrodd
   server-side identitets-/sesjonsautoritet med SAMME komposisjons-disiplin som D-123 sin
   `VoiceSessionAuthority`: ingen egen autorisasjonslogikk, kun tillitsankeret (eksakt streng-likhet
   mot den KONFIGURERTE chat-ID-en) + `SessionService.resumeOrCreate()` +
   `IdentityService.resolveIdentity()`.
   **Den avgjørende egenskapen er strukturell:** `authorize()` tar KUN en chat-ID og har INGEN
   parameter for meldingstekst, avsendernavn eller `@username`. Ubetrodd innhold kan derfor ikke
   velge person, tenant, memory space, sesjon, policy, scopes eller ruting - det er umulig gjennom
   signaturen, ikke bare forbudt i en kommentar.
   Eier-sjekken kjøres FØR `resumeOrCreate()`, så en fremmed chat muterer aldri eierens server-eide
   sesjonsrad. Chat-ID-en tvinges ALDRI med `String()`. Ukonfigurert eier-chat er permanent
   fail-closed.
2. **`TelegramCommandPoller`** fikk en VALGFRI `chat`-handler. Uten den er oppførselen bit-for-bit som
   før. To strukturelle rettelser var PÅKREVD fordi en samtale er treg der kommandoene ikke er:
   **re-entrans-lås** (ellers ville tick nr. 2 hentet SAMME `update_id` mens nr. 1 ventet på modellen
   og svart dobbelt) og **behandlet-update-guard** (`update_id` markeres FØR dispatch). Sammen gir de
   at-most-once innenfor prosessens levetid - den trygge retningen. Hver oppdatering håndteres
   isolert, så én feil ikke stjeler resten av batchen.
   `/brief`, `/status` og `/ai` er **uendret** og har forrang; en UKJENT `/kommando` blir aldri stille
   omtolket til en modellsamtale.
3. **`apps/api/src/main.ts`** - ÉN delt `ConversationEngine` brukes nå av BÅDE `/chat` og
   Telegram-banen (to instanser ville gitt stille divergens mellom kanalene). Den eksisterende, aldri
   tidligere wirede `linkOwnerTelegramIdentity()` kobles inn, idempotent, `match_method` fortsatt
   `owner_configured`, KUN chat-ID-en deltar. Svaret går ut via den EKSISTERENDE ToolGateway-styrte
   `sendTelegram` - aldri en ny direkte `fetch`.
4. **`ChannelSchema` utvidet med `telegram`.** Alternativet (gjenbruke `api`) ville krevd null
   endring, men skrevet en USANN kilde i `sessions.last_channel` og audit - i strid med CLAUDE.md
   regel 4. Verifisert ufarlig mot faktisk kode: kolonnen er `text NOT NULL` uten CHECK-constraint,
   `ChannelSchema` brukes kun i én fil, og ingen uttømmende `switch` over `Channel` finnes. Ingen
   migrasjon. `auth_strength` er `active`, ALDRI `signed` - en bot-token er ingen enhetssignatur.

## Kvalitetsporter

- **51 nye tester, alle grønne lokalt på Windows-hosten:**
  `modules/core/test/d125-telegram-owner-authority.test.ts` (15, ekte embedded Postgres + ekte RLS) ·
  `modules/tool-gateway/test/d125-telegram-inbound-poller.test.ts` (15) ·
  `modules/conversation-graph/test/d125-owner-telegram-link.test.ts` (6, ekte Postgres) ·
  `apps/api/test/d125-telegram-inbound-wiring.test.ts` (15).
  Dekker alle syv verifikasjonskravene: kanonisk samtale-/svarbane, server-avledet og stabil
  identitet, fremmed chat avvist FØR modell/verktøy/sesjon, adversariell tekst kan ikke velge annen
  person/tenant/space eller lenke en gjettet kontakt, kommandoene uten regresjon, idempotent lenking
  uten meldingsinnhold, og ingen dobbel handling/svar for samme update.
- `pnpm -r typecheck`: **21/21 pakker rent.** `pnpm lint` (`eslint .`): **rent.**
- **Full lokal suite: 3071/3102 grønt.** De 31 feilene i 5 filer er **PRE-EKSISTERENDE**: nøyaktig de
  samme 5 filene og 31 testene feiler på det URØRTE base-committet `2e86e04` (verifisert ved detached
  checkout av basen og ny kjøring). Denne sliceen forårsaker **null regresjon**.
- gitleaks: egen CI-jobb over hele historikken - **IKKE kjørt lokalt** (binæren finnes ikke på hosten).
- **CI på eksakt endelig HEAD:** denne filen navngir BEVISST ingen run-id (enhver commit som skriver
  run-id-en hit endrer selv HEAD og gjør påstanden umiddelbart usann). Run-id + status for
  `build-test`, `windows-git-auth` og `gitleaks` rapporteres i `CLAUDE_REPORT` på GitHub-issue **#68**.

## Separat observerte Windows-host-gap (IKKE rørt i denne sliceen)

Rapportert, ikke opportunistisk fikset - de hindrer ikke sannferdig D-125-verifikasjon:

1. **`.cjs` EFTYPE ved `spawnSync`** - `docker-transport.test.ts`, `sandbox-docker-extra-env.test.ts`,
   `claude-code-agent.test.ts`. Windows kan ikke `spawnSync` en `.cjs`-fil direkte som kjørbar.
2. **CRLF-vs-LF i kildeteksts-assertions** - `worker-coding-wiring.test.ts`,
   `ua3-live-pool-separation.test.ts`. Root cause er nå identifisert: repoet har `core.autocrlf=true`
   og **ingen `.gitattributes`**, så assertions med innebygd `\n`
   (f.eks. `toContain("new ToolGateway(\n      pool, policy,")`) kan aldri matche en CRLF-checkout.
3. **embedded-Postgres port-race** - observert som flakiness (en kjøring ga 6 filer/45 feil der
   samme tre ellers gir 5/31). Portene velges tilfeldig uten kollisjonssjekk.

## Flagg-status

`UA7_TELEGRAM_INBOUND_OWNER=true`, `UA7_TELEGRAM_INBOUND_NON_OWNER=NOT_BUILT_BY_DESIGN_D122`,
`NEW_TABLES_ADDED=0`, `NEW_MIGRATIONS_ADDED=0`, `NEW_PROVIDERS_ADDED=0`,
`NEW_CREDENTIALS_OR_SCOPES=0`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`,
`HOST_ACCEPTANCE_REQUIRED=false`, `HARD_EXTERNAL_BLOCKER=false`.

**INGEN sannhetsflagg er flippet av denne oppgaven.** Uendret og fortsatt åpent:
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `UA7_ACCEPTANCE_4=PARTIAL`, `UA7_COMPLETE=false`,
`D108_COMPLETE=false`, `UA6_COMPLETE=false`, `UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`,
`UA7_SPEECH_EXTERNAL_PROCESSING=DENIED_PENDING_Q32_POINT1`. Denne oppgaven rørte hverken credentials,
leverandør-verifisering, juridisk vurdering eller D-108. UA-7-akseptansekriterier uendret:
**1 PASS** (D-121), **2 PASS**, **3 PASS**, **4 PARTIAL**. **Q-32 er FORTSATT ÅPEN** (punkt 1 og 3).

## Gjenstående UA-7-gap (eksakt)

- **Akseptansekriterium 4 = PARTIAL**, blokkert av **Q-32 punkt (1)** - en eier-/juridisk handling
  Tobias må gjøre selv (kontroll av OpenAI som databehandler for tale: region, databehandleravtale,
  treningsvilkår, retensjon + utfylling av `PROCESSOR_REGION_MATRIX.md`). Kode kan ikke lukke den.
- **Q-32 punkt (3)** - Tobias må installere whisper.cpp/piper-binærer på hosten før `health`-tale er
  reelt tilgjengelig.
- **Ikke-eier-Telegram-identiteter** - bevisst ikke bygget (D-122: ingen deterministisk koblingsnøkkel).
- **Møtetranskripsjon** - `DEFERRED_WITHIN_PHASE`, uendret.
- Credentials, leverandør-live-verifisering, juridisk/kontraktsverifisering og D-108 er av Tobias
  eksplisitt sekvensert til den avsluttende integrasjons-/deploy-fasen.

## PR-status

Draft-PR på branch `claude/d125-ua7-telegram-inbound-owner` mot `main`. **IKKE merget, IKKE
self-approved** (`ARCHITECT_MERGE_APPROVED=false` i byggeordren). Fersk CI på eksakt endelig HEAD
kjøres etter push og rapporteres med run-id og jobbstatus i `CLAUDE_REPORT` på issue #68. Venter på
uavhengig ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske for denne sliceen. `HARD_EXTERNAL_BLOCKER=false`.
Q-32 punkt (1) og (3) er uendret eier-/host-handlinger Tobias må utføre selv.

## Neste oppgave

Avventer uavhengig arkitekt-review av denne PR-en. INGEN merge, INGEN neste slice, INGEN D-108,
INGEN UA-8 startet av denne runden. Etter review er de dependency-korrekte kandidatene: (a) de tre
separat rapporterte Windows-host-gapene over som egen, avgrenset oppgave (samme mønster som D-124 -
de er en akkumulerende skatt på lokal verifiserbarhet), eller (b) neste masterplan-slice slik
IMPLEMENTATION_PLAN sekvenserer den. UA-7 kan IKKE lukkes av kode alene så lenge Q-32 punkt 1 er åpen.
