# PROJECT STATUS

**Oppdatert:** 2026-09-05 (branch `claude/ua7-speech-retention-legal-basis`, base
`main=9106936aa41c664c33707eca5f806ffc5fd9d027`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**D-122 - UA-7 Communications Hub, TREDJE slice: tale-/transkripsjonsbehandling med dokumentert
retensjon og rettsgrunnlag.** Derivert, ikke fritt valgt: en ny gap-audit av faktisk `main` mot
masterplanens fire UA-7-akseptansekriterier viste at kriterium 4 («Transcription/call processing has
documented retention and legal basis **where required**») var det ENESTE gjenstående - og at D-121
sin klassifisering av det som `DEFERRED_WITHIN_UA7_BY_DEPENDENCY` **var feil**. Full audit-matrise:
IMPLEMENTATION_PLAN.md, seksjon «UA-7 ... Tredje slice (D-122)». Full begrunnelse: D-122 i
DECISIONS_AND_ASSUMPTIONS.md.

**Andre runde på samme slice:** uavhengig ChatGPT-arkitekt-review av PR #71 (task
`D122-ARCHITECT-REVIEW-FIX-20260905-1604`) fant to governance-/sikkerhetsfunn. Begge er tatt til
følge på samme branch, uten ny D-ID og uten ny slice - se «Rettelser etter arkitekt-review» under.

## Hva re-auditen faktisk fant

Transkripsjonsbehandling finnes ALLEREDE på `main` og er host-verifisert - `stt.ts:94` POSTer rå wav
til `api.openai.com`, `main.ts:15-16` velger OpenAI som baseline så snart `OPENAI_API_KEY` finnes, og
`RUNTIME_GATES.md` (BO-12) dokumenterer «ekte OpenAI TTS/STT (norsk) PASS». Kriteriets «where
required» er derfor oppfylt NÅ. Fire konkrete motsigelser mellom dokumentasjon og kode:

1. `DPIA_VOICE.md` påsto «**ingen rå lyd forlater maskinen**» - usant siden BO-12.
2. Samme notat sa det MÅTTE revideres FØR en ekstern STT/TTS-leverandør ble tatt i bruk - aldri gjort.
3. `PROCESSOR_REGION_MATRIX.md` sine STT-/TTS-rader sto `TBD`, i strid med filens egen regel 1
   («En rad med "TBD" kan ikke tas i produksjonsbruk. Punktum.»).
4. **Alvorligst:** D-23 og matrise-regel 2 («`health`-space kan aldri sendes til en radleverandør»)
   var IKKE håndhevet noe sted. `memory_space` forekom ÉN gang i hele `apps/voice-gateway/src`
   (`session.ts:19`, et rent typefelt) og styrte ingenting - rå lyd fra `health`-space ville gått til
   OpenAI som all annen lyd.

Kriteriet krever *dokumentert* retensjon/rettsgrunnlag, men å skrive «health-lyd behandles lokalt»
ville vært USANT. Sliceen gjør derfor begge deler: retter dokumentasjonen til det som er sant, OG
gjør invarianten strukturelt håndhevet (CLAUDE.md regel 2).

## Hva som faktisk ble bygget

**NULL nye tabeller, NULL nye migrasjoner, NULL nye leverandører, NULL nye credentials/scopes.**

1. **`packages/contracts/src/speech.ts`** - `evaluateSpeechRouting()`, den kanoniske,
   leverandør-uavhengige rutingsporten. Gjenbruker det EKSISTERENDE `DataSensitivity`-vokabularet
   (D-79/D-81) og samme regelform som `isSensitivityEligible()` i `model-gateway/src/router.ts` -
   **aldri en parallell sikkerhetsvei**. Seks regler i bevisst rekkefølge: lokal behandler alltid
   tillatt · ekstern uten navngitt matriserad avvises FØR space vurderes (regel 1 gjort strukturell)
   · ekstern uten VERIFISERTE vilkår avvises, også før space (regel 3 gjort strukturell) ·
   ukjent/manglende space avvises fail-closed (D-81-lærdommen) · `SECRET_RESTRICTED` avvises mot
   ekstern behandler (D-23/regel 2) · kun klient-oppgitt space kan ikke kvalifisere for ekstern
   behandling. `health` er den ENESTE space-en som er `SECRET_RESTRICTED`.
2. **`processor` er PÅKREVD** på `SttAdapter`/`TtsAdapter`: en ny tale-leverandør uten erklæring
   **kompilerer ikke** (typecheck feilet på fire eksisterende fixturer og krevde stillingtagen -
   det var beviset på at porten binder). `processor_row_declared` er `false` som default og
   `processor_terms_status` faller til `NOT_VERIFIED`, så en fremtidig
   SIP-/møtetranskripsjons-leverandør blokkeres automatisk på begge regler.
3. **`VoiceSession` håndhever porten** i `pushAudio()` FØR filtre/VAD/adapter (ikke ÉN lydramme når
   en ukvalifisert behandler) og i `enqueueTts()`/`speakNext()` (svarteksten i en sensitiv samtale er
   like avslørende som spørsmålet). Ingen stille fallback - eksplisitt
   `speech_routing_denied_stt|tts:<utfall>`, rapportert ÉN gang per sesjon, aldri per lydramme.
   `health.recordFailure()` kalles bevisst IKKE ved policy-avslag (ville vært usant og kunne utløst
   feilaktig failover). `/status` eksponerer `speech_routing` per memory space.
4. **Dokumentasjonen - selve kriteriet:** ny `docs/UA7_COMMUNICATIONS_DPIA.md` (samme form som
   UA-2-/UA-3-DPIA-ene); `PROCESSOR_REGION_MATRIX.md` STT-/TTS-rader NAVNGIR nå OpenAI med
   region/DPA/trening/retensjon eksplisitt `IKKE VERIFISERT`; `DPIA_VOICE.md` har fått en eksplisitt
   RETTELSE-blokk framfor en stille omskriving.
5. **Etter arkitekt-review:** `processor_terms_status` (matrise-regel 3) og `MemorySpaceAuthority`
   (tillitsgrensen) som eksplisitte, fail-closed felt; `server.ts` navngir tillitsnivået der den
   uautentiserte klientverdien faktisk kommer inn (`VOICE_MEMORY_SPACE_AUTHORITY`), og `/status`
   rapporterer det sammen med utfallene.

## Rettelser etter arkitekt-review (funn 1 og 2)

**Funn 1 - navngitt rad var ikke det samme som kvalifisert behandler.** Koden lot
`processor_row_declared: true` alene kvalifisere en ekstern behandler, mens matrisens egen regel 3
krever verifisert region, akseptert databehandleravtale, dokumenterte trenings-/retensjonsvilkår og
kontrolldato - og OpenAI-radene står `IKKE VERIFISERT`. Samtidig sto `UA7_ACCEPTANCE_4=PASS`. Det
kunne ikke være sant samtidig. Regel 3 er nå kanonisk status i erklæringen
(`processor_terms_status`: `VERIFIED` / `NOT_VERIFIED` / `NOT_APPLICABLE_LOCAL`, fail-closed default
`NOT_VERIFIED`, også når feltet mangler; `NOT_APPLICABLE_LOCAL` på en ekstern behandler kvalifiserer
ikke). Sjekken kjøres FØR space vurderes.

**Funn 2 - D-23-håndhevingen stolte på klient-oppgitt `memory_space`.** Re-audit av eksisterende
identitets-sti: `resolveIdentity()` (`modules/core/src/services/identity-service.ts`) verifiserer at
person/tenant/enhet/space EKSISTERER, men ingenting beviser at kalleren ER den påståtte personen;
`DeviceService.verifyChallenge()` er ekte proof-of-possession, men brukes kun til
klasse-D-godkjenninger; voice-transporten har ingen autentisering. **Det finnes altså ingen betrodd
server-side space-autoritet i dag** - og den er BEVISST ikke oppfunnet inne i D-122 (egen kanonisk
slice, Q-32). I stedet er tillitsnivået et påkrevd argument (`MemorySpaceAuthority`), og en
`CLIENT_ASSERTED` space kan kun NEKTE, aldri kvalifisere for ekstern behandling. Porten er derfor
eksplisitt PARTIAL: **D-23 påstås IKKE strukturelt lukket for tale.**

## Ærlighet framfor stillhet

**Ekstern talebehandling er AVVIST i dag - for alle memory spaces, ikke bare `health`.** OpenAI
STT/TTS blokkeres av regel 3 (uverifiserte vilkår), og selv en fullt verifisert ekstern behandler
ville blitt blokkert av manglende space-autoritet. BO-12 sin host-verifiserte talekjede er dermed
**policy-blokkert**, ikke fjernet: den gjenopprettes ved å BESVARE Q-32 (eier-/juridisk verifisering
+ betrodd space-autoritet), aldri ved å endre et statusfelt alene. Dette er det korrekte utfallet av
at radene står `IKKE VERIFISERT`, og det rapporteres her i stedet for å skjules. `/status` viser
utfallet per space, så tilstanden er observerbar uten en sesjon.

`LocalWhisperStt.startStream()` kaster fortsatt `local_whisper_not_implemented_in_pilot`. En
`health`-samtale **AVVISES** derfor i stedet for å behandles lokalt - korrekt utfall av D-23, men en
reell kapabilitets-mangel, dokumentert (DPIA §7.1 / Q-32) i stedet for skjult.

## Kvalitetsporter

- `pnpm -r typecheck`: 21/21 pakker rent.
- `pnpm lint` (`eslint .`): rent.
- `apps/voice-gateway/test/ua7-speech-routing.test.ts`: **32/32 grønt** (A1-A8 ren regel · **E1-E4
  matrise-regel 3, arkitekt-funn 1** · **F1-F5 adversarielle tester for klient-oppgitt space,
  arkitekt-funn 2** · B1-B4 adaptererklæring mot faktisk oppførsel · C1-C8 `VoiceSession` med
  rammetellende spion-adapter · D1-D3 TTS-siden). +15 tester mot forrige HEAD.
- `apps/voice-gateway/test/d30-foundation.test.ts`: 18/18 grønt (ingen regresjon).
- Øvrige voice-tester: grønt lokalt (5 av 6 filer). `voice-e2e.test.ts` kunne IKKE kjøres på
  denne Windows-hosten - **pre-eksisterende, ikke innført av denne sliceen**: `040_stripe.sql`
  inneholder ett mojibake-tegn (`Ē`, U+0112) i en KOMMENTAR som feiler på en WIN1252-initialisert
  embedded-Postgres-klynge. Migrasjonen feiler FØR noen av denne sliceens kode kjører, og suiten
  passerer i CI på Linux. Bør rettes som en egen, liten oppgave - arkitekten har tidligere eksplisitt
  instruert at den IKKE skal smugles inn i en UA-7-slice.
- gitleaks: egen CI-jobb over hele historikken - **IKKE kjørt lokalt** (binæren finnes ikke på denne
  hosten).
- **CI på eksakt endelig HEAD:** denne filen navngir BEVISST ingen run-id for den endelige HEAD-en
  (enhver commit som skriver run-id-en hit endrer selv HEAD og gjør påstanden umiddelbart usann).
  Run-id + jobbstatus rapporteres i `CLAUDE_REPORT` på GitHub-issue **#68**.

## Flagg-status

`UA7_ACCEPTANCE_4=PARTIAL` (**nedgradert fra `PASS` etter arkitekt-review** - dokumentasjonen og den
strukturelle håndhevingen finnes og er sann, men de påkrevde retensjons-/rettsgrunnlagsfaktaene er
IKKE verifisert; kriteriet lukkes av Q-32, ikke av kode), `UA7_SPEECH_ROUTING_ENFORCED=true`,
`UA7_SPEECH_EXTERNAL_PROCESSING=DENIED_PENDING_Q32`, `UA7_TRUSTED_MEMORY_SPACE_AUTHORITY=false`,
`UA7_NEW_TABLES_ADDED=0`, `UA7_NEW_PROVIDERS_ADDED=0`, `HOST_ACCEPTANCE_REQUIRED=false`.
UA-7-akseptansekriterier: **1 PASS** (D-121), **2 PASS**, **3 PASS**, **4 PARTIAL**
(møtetranskripsjon/SIP/tredjeparts-opptak forblir `DEFERRED_WITHIN_UA7_BY_DEPENDENCY` med navngitt
port i DPIA §5). Uendret: `UA7_COMPLETE=false` (kanalene selv er fortsatt D-108-sperret),
`UA7_MEETING_TRANSCRIPTION=DEFERRED_WITHIN_PHASE`, `D108_COMPLETE=false`, `UA6_COMPLETE=false`.
**Q-32 er FORTSATT ÅPEN og påstås ikke lukket av kode.**

## PR-status

Draft-PR **#71** på branch `claude/ua7-speech-retention-legal-basis`. **IKKE merget, IKKE
self-approved.** Andre runde: de to arkitekt-funnene er rettet på samme branch (task
`D122-ARCHITECT-REVIEW-FIX-20260905-1604`, `ARCHITEKT_MERGE_APPROVED=false`). Fersk CI på ny eksakt
endelig HEAD kjøres etter push og rapporteres med run-id og jobbstatus i `CLAUDE_REPORT` på issue
#68. Venter på ny uavhengig ChatGPT-arkitekt-review (D-120).

## Blokkeringer

Ingen tekniske. `HARD_EXTERNAL_BLOCKER=false`. **Q-32** krever en eier-/juridisk handling fra Tobias
(verifisering av OpenAI som databehandler for tale) og en fremtidig, egen slice for betrodd
server-side memory-space-autoritet. Den blokkerer ikke denne PR-en, men den er nå det som faktisk
holder ekstern talebehandling AVVIST og `UA7_ACCEPTANCE_4` på `PARTIAL` - og den kan ikke lukkes av
kode.

## Neste oppgave

Avventer ny arkitekt-review. INGEN merge, INGEN neste UA-7-slice, INGEN D-108, INGEN UA-8, INGEN ny
D-ID startet av denne runden. Naturlige kandidater etter review: (a) **server-side memory-space-/
sesjonsautoritet i voice-transporten** (Q-32 punkt 2 - den eneste som faktisk løfter D-23 fra
fail-closed-nekt til ekte garanti; gjenbruker `DeviceService`/`SessionService`/`resolveIdentity()`,
aldri et parallelt identitetssystem), (b) Telegram inngående som samtalekanal (eneste gjenstående
`NOT_STARTED_PROVIDER_INDEPENDENT` - se forbeholdet om manglende deterministisk koblingsnøkkel i
IMPLEMENTATION_PLAN sin D-122-matrise), (c) egen liten oppgave for `040_stripe.sql`-mojibake,
(d) nye kanaler når D-108 faktisk forfaller. Q-32 punkt 1 er en ren eier-/juridisk handling Tobias
må gjøre selv.
