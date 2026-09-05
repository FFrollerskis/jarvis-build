# PROJECT STATUS

**Oppdatert:** 2026-09-05 (branch `claude/ua7-voice-session-authority`, base
`main=f8e849b2d1db2f65ba9c6c6d6ebbd5975a2c3347`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**D-123 - UA-7 Communications Hub, FJERDE slice: betrodd server-side sesjons-/memory-space-autoritet
i voice-transporten.** Derivert, ikke fritt valgt: D-122 sin arkitekt-review registrerte **Q-32**
med to lukkedeler - (1) eier-/juridisk verifisering av OpenAI som databehandler, som INGEN kode kan
lukke, og (2) manglende betrodd server-side space-/sesjonsautoritet, som er uavhengig
implementasjonsarbeid. Punkt (2) er derfor den dependency-korrekte neste sliceen. Punkt (1) er ikke
rørt. Full begrunnelse: D-123 i DECISIONS_AND_ASSUMPTIONS.md.

## Hva som faktisk var galt på `main@f8e849b`

- `apps/voice-gateway/src/server.ts:138`: `VOICE_MEMORY_SPACE_AUTHORITY = "CLIENT_ASSERTED"` var en
  **hardkodet konstant** - den eneste verdien som noensinne nådde `VoiceSession`.
- `apps/voice-gateway/src/server.ts:217`: `person_id`/`tenant_id`/`device_id`/`memory_space` ble tatt
  UENDRET fra den uautentiserte `start`-meldingen.
- `SERVER_VERIFIED` fantes kun som enum-verdi i `speech.ts` - **ingen kode kunne produsere den**.

Konsekvens: D-122 sin rutingsport kunne kun NEKTE ekstern behandling, aldri GARANTERE at en
`personal`-merket samtale ikke egentlig var en `health`-samtale. D-23 var ikke strukturelt lukket
for tale.

## System-of-record-audit: 0 nye tabeller, 0 nye migrasjoner

Utført FØR implementering, som byggeordren krever. Bindingen «denne beviste personen, på denne
beviste enheten, i denne sesjonen, har lov til NØYAKTIG denne memory space-en» er allerede fullt
representerbar: `person_tenants` (medlemskap) · `devices (device_id, tenant_id, person_id,
public_key_pem)` - enheten er allerede bundet til BÅDE person og tenant, og `public_key_pem IS NULL`
ER tilbakekallingstilstanden modellen eksponerer · `memory_spaces (tenant_id, space) UNIQUE` ·
`sessions (…, status, last_device_id)`. `resolveIdentity()` håndhever allerede konjunksjonen under
RLS.

En per-person/per-enhet space-hviteliste ble vurdert og **bevisst forkastet**: den finnes ikke i den
kanoniske modellen (minne-RLS er tenant+space, ikke person+space), så å innføre den inne i en
transport-slice ville vært å oppfinne en ny autorisasjonsmodell - nøyaktig det Q-32 og byggeordren
forbyr. Blir den ønsket, er den en egen kanonisk beslutning på identitets-/minnenivå for ALLE
kanaler.

## Hva som faktisk ble bygget

**NULL nye tabeller, NULL nye migrasjoner, NULL nye leverandører, NULL nye credentials/scopes,
NULL nye identitets-/sesjons-/enhetssystemer.**

1. **`packages/contracts/src/voice-authority.ts`** - tillitsgrensen som en TYPE, ikke en konvensjon.
   `VoiceAuthorizationEvidence` (`.strict()`) er ALT klienten sender og heter bevisst «evidence».
   `VoiceSessionGrant` har `memory_space_authority` som **literal `"SERVER_VERIFIED"`** - en grant
   med svakere nivå kan ikke EKSISTERE. `voiceAuthorityFromGrant()` er DEN ENESTE funksjonen som kan
   gi en transport `SERVER_VERIFIED`; alt annet (manglende/utløpt/ugyldig) faller innstrammende til
   `CLIENT_ASSERTED`.
2. **`modules/core/src/services/voice-session-authority.ts`** - `VoiceSessionAuthority.authorize()`,
   som **inneholder ingen egen autorisasjonslogikk**. Den komponerer de tre eksisterende primitivene
   i den rekkefølgen Q-32 selv anviste: `DeviceService.verifyChallenge()` →
   `SessionService.resumeOrCreate()` → `resolveIdentity()`.
3. **Rekkefølgen er sikkerhetskritisk** og avviker BEVISST fra `/chat` sin
   (`resumeOrCreate()`-før-`resolveIdentity()`): enhetsbeviset kjøres FØRST og bindes til påstått
   person (`verifyChallenge(..., personId)`). Uten det kunne en angriper med sin EGEN gyldig
   registrerte enhet bevist enheten mens den påsto en ANNEN persons `person_id` - og
   `resumeOrCreate()` ville rukket å MUTERE offerets sesjonsrad (`last_device_id`/`last_active_at`)
   FØR avslaget kom. `verifyChallenge()` fikk derfor en VALGFRI `personId`; eksisterende kallere
   (`/devices/challenge/verify`) er bit-for-bit uendret.
4. **`POST /voice/session/authorize`** (`apps/api`) uten egen logikk. `main.ts` deler nå ÉN instans
   av hver identitetsprimitiv - `DeviceService` holder utstedte challenges in-memory, så to
   instanser ville vært en STILLE funksjonsfeil, ikke bare uryddig.
5. **Voice-gatewayen** (egen prosess, regel 5) henter grant-en SELV over sin egen utgående
   Core-forbindelse og leser ALDRI et grant-felt fra websocketen. Ved gyldig grant overskrives HVERT
   identitetsfelt fra grant-en. Avvist bevis starter INGEN sesjon - heller ikke en nedgradert (det
   ville skjult et faktisk mislykket autentiseringsforsøk). Utilgjengelig autoritet nekter framfor å
   degradere stille. Grant-levetid (15 min, konstant - ikke konfig) håndheves ved HVER bruk og river
   sesjonen ned ved utløp. Meldinger serialiseres nå gjennom én kjede fordi `start` er blitt
   asynkron. `/status` rapporterer rutingutfall for BEGGE tillitsnivåene, så eieren kan skille
   «ingen har bevist seg» fra «behandleren er ikke kvalifisert».

## D-122 er UENDRET og overordnet

`SERVER_VERIFIED` er **nødvendig, men ikke tilstrekkelig**. Ekstern talebehandling er fortsatt
AVVIST for ALLE memory spaces: OpenAI STT/TTS blokkeres av matrise-regel 3
(`processor_terms_status=NOT_VERIFIED`), og `health` blokkeres av D-23 mot enhver ekstern behandler.
**Ingen statusfelt er flippet og ingen juridiske fakta er oppfunnet.** Forskjellen fra før er at
avslaget nå hviler på en space-verdi som faktisk er autoritativ.

## Kvalitetsporter

- `pnpm -r typecheck`: **21/21 pakker rent.**
- `pnpm lint` (`eslint .`): **rent.**
- `apps/voice-gateway/test/ua7-voice-session-authority.test.ts`: **19/19 grønt** - ekte
  `createVoiceGateway()` bak ekte WebSocket, fiendtlig klient. A1-A3 ubevist start / smuglet
  tillitsnivå / smuglet grant · B1-B3 alle avslagsgrunner + utilgjengelig autoritet, fail-closed
  uten stille degradering · C1-C3 identiteten kommer fra grant-en og ikke fra påstanden, kun
  erklærte bevisfelt videresendes, utløpt grant river sesjonen · D1-D3 D-122 uendret (OpenAI og
  `health` fortsatt avvist under `SERVER_VERIFIED`, mens en verifisert ekstern behandler faktisk
  slipper gjennom - porten er ikke bare «nekt alltid») · E1-E4 kontraktnivå.
- Øvrige voice-tester: **77/77 grønt lokalt (5 av 6 filer)**, ingen regresjon.
- `modules/core/test/d123-voice-session-authority.test.ts` (13 tester mot ekte embedded
  Postgres/RLS: kryss-person, kryss-tenant, kryss-space, kryss-enhet, tilbakekalt enhet, replay,
  utløpt nonce, feil nøkkel, malformed evidence, uendret sesjons-gjenopptak): **KUNNE IKKE KJØRES
  LOKALT.** Årsak er PRE-EKSISTERENDE og uavhengig av denne sliceen - `040_stripe.sql` inneholder ett
  mojibake-tegn (`Ē`, U+0112) i en KOMMENTAR som feiler på en WIN1252-initialisert
  embedded-Postgres-klynge; migrasjonen feiler FØR noen test kjører, og det samme gjelder
  `voice-e2e.test.ts` og alle andre DB-suiter på denne hosten. **Verifisert på nytt denne økten** mot
  en eksisterende, urørt testfil (`modules/core/test/fase8-device.test.ts`). Arkitekten har tidligere
  eksplisitt instruert at rettingen IKKE skal smugles inn i en UA-7-slice; den kjøres derfor i CI på
  Linux, og resultatet rapporteres i `CLAUDE_REPORT`.
- gitleaks: egen CI-jobb over hele historikken - **IKKE kjørt lokalt** (binæren finnes ikke på denne
  hosten).
- **CI på eksakt endelig HEAD:** denne filen navngir BEVISST ingen run-id (enhver commit som skriver
  run-id-en hit endrer selv HEAD og gjør påstanden umiddelbart usann). Run-id + jobbstatus
  rapporteres i `CLAUDE_REPORT` på GitHub-issue **#68**.

## Flagg-status

`UA7_TRUSTED_MEMORY_SPACE_AUTHORITY=true` (**endret fra `false`**), `Q32_POINT2=RESOLVED_IN_CODE`,
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `UA7_ACCEPTANCE_4=PARTIAL` (**UENDRET** - kriteriet lukkes
av Q-32 punkt 1, en eier-/juridisk handling; kode kan ikke lukke det),
`UA7_SPEECH_EXTERNAL_PROCESSING=DENIED_PENDING_Q32_POINT1`, `UA7_SPEECH_ROUTING_ENFORCED=true`,
`UA7_NEW_TABLES_ADDED=0`, `UA7_NEW_PROVIDERS_ADDED=0`, `HOST_ACCEPTANCE_REQUIRED=false`.
UA-7-akseptansekriterier: **1 PASS** (D-121), **2 PASS**, **3 PASS**, **4 PARTIAL**. Uendret:
`UA7_COMPLETE=false` (kanalene selv er fortsatt D-108-sperret),
`UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`, `D108_COMPLETE=false`, `UA6_COMPLETE=false`.
**Q-32 er FORTSATT ÅPEN** - punkt (2) er lukket av denne sliceen, men punkt (1) og (3) er det ikke,
og Q-32 påstås derfor ikke lukket.

## PR-status

Draft-PR på branch `claude/ua7-voice-session-authority`. **IKKE merget, IKKE self-approved**
(`ARCHITECT_MERGE_APPROVED=false` i byggeordren). Fersk CI på eksakt endelig HEAD kjøres etter push
og rapporteres med run-id og jobbstatus i `CLAUDE_REPORT` på issue #68. Venter på uavhengig
ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske for denne sliceen. `HARD_EXTERNAL_BLOCKER=false`.

**Q-32 punkt (1)** krever en eier-/juridisk handling fra Tobias: faktisk kontroll av OpenAI som
databehandler for tale (region, databehandleravtale, treningsvilkår, retensjon) og utfylling av
radene i `PROCESSOR_REGION_MATRIX.md`. Dette er nå den ENESTE gjenstående avhengigheten for
`UA7_ACCEPTANCE_4`, og den kan ikke lukkes av kode. **Q-32 punkt (3)** krever at Tobias installerer
whisper.cpp/piper-binærer på hosten før `health`-tale blir reelt tilgjengelig (i dag AVVISES den -
korrekt utfall av D-23, men en reell kapabilitets-mangel).

## Neste oppgave

Avventer arkitekt-review. INGEN merge, INGEN neste slice, INGEN D-108, INGEN UA-8 startet av denne
runden. Naturlige kandidater etter review: (a) Telegram inngående som samtalekanal (eneste
gjenstående `NOT_STARTED_PROVIDER_INDEPENDENT` - se forbeholdet om manglende deterministisk
koblingsnøkkel i IMPLEMENTATION_PLAN sin D-122-matrise), (b) egen liten oppgave for
`040_stripe.sql`-mojibaken, som nå blokkerer lokal kjøring av ENHVER DB-test på Windows-hosten,
(c) nye kanaler når D-108 faktisk forfaller. Q-32 punkt 1 og 3 er eier-/host-handlinger Tobias må
gjøre selv.
