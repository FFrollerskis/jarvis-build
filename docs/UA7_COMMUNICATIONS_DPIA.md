# UA-7 — DPIA / data-governance-notat (tale-, transkripsjons- og samtalebehandling)

**Status:** UA-7 «Communications Hub» er FORTSATT PARTIAL (`UA7_COMPLETE=false`). Dette notatet
dekker masterplanens fjerde UA-7-akseptansekriterium ordrett: «Transcription/call processing has
documented retention and legal basis **where required**»
(`docs/input/02_Jarvis_Masterplan_Sovereign_Autonomy_v4.0.md`, §"UA-7 - Communications Hub"), og
Appendiks D sin compliance-gate for UA-7 («Call recording/transcripts, outbound AI calls →
Disclosure/legal basis/retention; marketing/reservation/platform rules», **gate FØR production**).

Skrevet i D-122 (2026-09-05). Samme form og disiplin som `UA2_KNOWLEDGE_DPIA.md` og
`UA3_BUSINESS_DPIA.md`: kort og teknisk, ikke juridisk teater — og det utfyller, erstatter ikke,
`docs/security/DPIA_VOICE.md` (fase 5-piloten) og `docs/security/DPIA_DRAFT.md`.

> **KRITERIUM-STATUS: `UA7_ACCEPTANCE_4=PARTIAL` — IKKE `PASS`.**
> Første versjon av D-122 satte `PASS` samtidig som dette notatet sa at ekstern-behandlerens
> retensjon og rettsgrunnlag IKKE er verifisert. De to påstandene kan ikke være sanne samtidig, og
> den uavhengige arkitekt-reviewen av PR #71 fant motsigelsen. Kriteriet krever *dokumentert*
> retensjon og rettsgrunnlag «where required»; dokumentasjonen finnes nå og er sann, og
> håndhevingen er strukturell og fail-closed — men de faktiske behandler-fakta (region,
> databehandleravtale, treningsvilkår, retensjon) er fortsatt `IKKE VERIFISERT` (**Q-32 punkt 1**).
> Kriteriet settes til `PASS` FØRST når de fakta faktisk foreligger — ikke av kode, og ikke av dette
> notatet.
>
> **OPPDATERT 2026-09-05 (D-123):** den ANDRE mangelen dette avsnittet navnga — «voice-transporten
> mangler en betrodd server-side memory-space-autoritet» (Q-32 punkt 2) — er nå BYGGET, se §6.1
> «Status etter D-123». `UA7_ACCEPTANCE_4` er likevel UENDRET `PARTIAL`: kriteriet lukkes av
> punkt 1, som er en eier-/juridisk handling ingen kode kan utføre.

> **Jarvis avgjør ALDRI selv et rettslig grunnlag.** Samme prinsipp som `modules/consent` (D-91):
> koden håndhever en REGISTRERT erklæring. Ingenting i dette notatet er en påstand fra Jarvis om at
> et gitt grunnlag faktisk er gyldig — det er et menneskelig/juridisk spørsmål utenfor kodens
> autoritet.

## 0. Hvorfor dette notatet ble skrevet NÅ (og hva som faktisk var galt)

Gap-auditen i D-122 fant en **reell motstrid mellom dokumentasjon og kode på `main`**:

| Påstand i dokumentasjonen | Faktisk tilstand på `main` (`9106936`) |
|---|---|
| `DPIA_VOICE.md`: «**ingen rå lyd forlater maskinen**, ingen skyleverandør mottar tale» | `apps/voice-gateway/src/main.ts:15-16` valgte `OpenAiStt`/`OpenAiTts` som baseline så snart `OPENAI_API_KEY` var satt. `stt.ts` POSTer rå wav til `https://api.openai.com/v1/audio/transcriptions` |
| `DPIA_VOICE.md`: «MÅ revideres FØR en ekstern STT/TTS/realtime-leverandør tas i bruk» | Leverandøren var alt i bruk og host-verifisert (`RUNTIME_GATES.md`: «ekte OpenAI TTS/STT (norsk) PASS», «nøkkel alt live i runtime») |
| `PROCESSOR_REGION_MATRIX.md` regel 1: «En rad med "TBD" kan ikke tas i produksjonsbruk. Punktum.» | STT- og TTS-radene sto fortsatt `TBD / benchmark required` |
| `PROCESSOR_REGION_MATRIX.md` regel 2 + D-23: «`health`-space kan aldri sendes til en radleverandør uten egen eksplisitt beslutning» | **INGEN kode håndhevet dette.** `memory_space` forekom ÉN gang i hele `apps/voice-gateway/src` (`session.ts:19`, et typefelt) og styrte ingenting. Rå lyd fra `health`-space ville gått til OpenAI nøyaktig som all annen lyd |

Det siste punktet er det alvorlige: kriteriet krever *dokumentert* retensjon og rettsgrunnlag, men å
skrive «health-lyd behandles lokalt» ville vært en USANN setning. D-122 gjør derfor begge deler —
retter dokumentasjonen til det som faktisk er sant, OG gjør den ene invarianten som må holde
strukturelt håndhevet i deterministisk kode (CLAUDE.md regel 2), slik at dokumentasjonen ikke igjen
kan drive fra virkeligheten uten at en test feiler.

## 1. Hvilke data behandles (faktisk, ikke planlagt)

| Datakategori | Hvor den oppstår | Hva som skjer med den |
|---|---|---|
| **Rå lyd (PCM/wav) fra eierens mikrofon** | `apps/voice-gateway` — klienten sender lyd EKSPLISITT etter en `start`-melding (§23: `start` ER mikrofonaktiveringen, aldri skjult opptak) | Flyktige buffere i prosessminnet under én tur. Ved ekstern STT: pakket som wav og POSTet til leverandøren. **Lagres aldri på disk** (`/status` rapporterer `audio_persistence: "none"`) |
| **Transkript (tekst)** | `SttStream.end()` | Behandles som ordinær samtaledata i det EKSISTERENDE minnesystemet (tenant/space-RLS, karantene, audit). Ingen egen «voice memory», ingen egen transkripsjonstabell |
| **Svartekst → syntetisert tale** | `TtsAdapter.synthesize()` | Ved ekstern TTS sendes svarteksten til leverandøren. Lydrammene strømmes til klienten og forkastes |
| **Latens-/kostmetrikk** | `TurnMetrics` (`session.ts`) | `stt_audio_ms`/`tts_chars`/tidsstempler — mengder og tidspunkter, **ikke innhold** |

**Ikke behandlet i dag (eksplisitt, ikke stilltiende utelatt):** samtaleopptak av en TREDJEPART,
telefoni/SIP-samtaler, møtetranskripsjon og utgående AI-samtaler. Se §5.

## 2. Retensjon

| Data | Retensjon | Håndhevet av |
|---|---|---|
| Rå lyd | **Ingen persistering.** Buffere lever i prosessminnet under én tur og forsvinner med turen | `apps/voice-gateway` skriver ingen lydfiler (ingen filskriving i lydkjedens moduler, BO-12 §22); `/status` eksponerer `audio_persistence: "none"` |
| Transkript og svar | Følger EKSISTERENDE samtale-/minne-retensjon — ingen egen tale-retensjon innføres. `memory_items.retention_rule` (`008_memory.sql:32`) og `messages` er de kanoniske stedene | Minnesystemet + Q-20/D-40 erasure-foundation (`docs/DATA_ERASURE.md`) |
| Retensjon HOS den eksterne behandleren | **IKKE VERIFISERT** — se §4 og Q-32. Dette er en eier-/juridisk verifisering, ikke noe Jarvis kan fastslå | — |
| Metrikk | Som øvrige `cost_events`/metrikker; inneholder ikke innhold | Eksisterende |

En Q-20-sletting treffer transkriptet der det faktisk ligger (samtale-/minneradene). Den kan
per definisjon ikke slette noe hos en ekstern behandler — det er en av grunnene til at §4-raden må
verifiseres av eieren.

## 3. Rettsgrunnlag

| Behandling | Registrert grunnlag | Merknad |
|---|---|---|
| Eierens egen tale mot sitt eget system | Eierens egen behandling av egne data i eget system | Ingen tredjepart involvert. Ingen `consent_decisions`-rad kreves — `modules/consent` sin modell er kontakt-/tredjeparts-orientert (`contact_id` er påkrevd) |
| Overføring av eierens lyd/tekst til en ekstern databehandler | Eier-konfigurert bruk av en databehandler | Forutsetter en gyldig databehandleravtale — **IKKE VERIFISERT**, se §4/Q-32. Overføringen er derfor **blokkert i dag**, ikke bare udokumentert |
| `health`-space | **Ikke tillatt mot ekstern behandler.** D-23 + matrise-regel 2 | Strukturelt håndhevet, se §6 — med det uttrykkelige forbeholdet i §6.1 (space-verdien er ikke autoritativ ennå) |
| Opptak/transkripsjon av en TREDJEPART (møter, telefoni, utgående AI-samtaler) | **INGEN registrert** — kapabiliteten finnes ikke | Får ikke bygges før §5-porten er kjørt |

## 4. Databehandlere

Radene i `docs/security/PROCESSOR_REGION_MATRIX.md` er den autoritative listen. D-122 endrer STT-
og TTS-radene fra `TBD` til å NAVNGI den behandleren som faktisk er i bruk (OpenAI), fordi en
`TBD`-rad ved siden av et live leverandørkall er en usann rad — ikke fordi vilkårene er avklart.

**Eksplisitt ikke avklart (`IKKE VERIFISERT`):** region, databehandleravtale, om data brukes til
trening, og leverandørens egen retensjon. Dette er registrert som **Q-32** og krever en
eier-/juridisk handling — Jarvis har ikke og skal ikke gjette disse verdiene.

`processor_row_declared: true` på `OpenAiStt`/`OpenAiTts` betyr KUN at behandleren er navngitt i
matrisen. Det er **ikke** en påstand om at vilkårene er verifisert. Skillet er bevisst og er
dokumentert både her og i `packages/contracts/src/speech.ts`.

**Rettelse etter arkitekt-review av PR #71:** skillet var dokumentert, men ikke håndhevet — koden
lot en navngitt rad alene kvalifisere for ekstern behandling. Matrisens regel 3 er derfor nå en
egen, kanonisk status i erklæringen: `processor_terms_status`. Kun `VERIFIED` kvalifiserer;
`NOT_VERIFIED` er fail-closed default. OpenAI STT/TTS står `NOT_VERIFIED` og er dermed **avvist for
alle memory spaces**, ikke bare `health`.

> **Ærlig konsekvens, ikke skjult:** BO-12 sin host-verifiserte talekjede er med dette
> **policy-blokkert**. `evaluateSpeechRouting()` gir `DENIED_PROCESSOR_TERMS_NOT_VERIFIED`, ingen
> lyd eller svartekst forlater huset, og en sesjon med OpenAI-adapterne feiler synlig i stedet for
> å behandle. Det er den korrekte følgen av at radene står `IKKE VERIFISERT` — kapabiliteten
> gjenopprettes ved å BESVARE Q-32, aldri ved å endre statusfeltet alene.

## 5. Bevisst utsatt innenfor UA-7 (`DEFERRED_WITHIN_UA7_BY_DEPENDENCY`)

Følgende er **ikke bygget** og skal ikke bygges før den navngitte porten er kjørt:

| Kapabilitet | Port som må kjøres først |
|---|---|
| Møtetranskripsjon | Leverandør-/D-64-port + D-108-credentials. Dette notatet utvides FØR bygging (samme mønster som `UA2_KNOWLEDGE_DPIA.md`, som allerede peker hit) |
| SIP/telefoni og samtaleopptak av tredjepart | Som over, PLUSS opplysningsplikt/disclosure og et registrert rettsgrunnlag PER motpart. `modules/consent` er den kanoniske mekanismen for det (`ConsentPurpose` må da utvides — det lukkede formål-settet har et dokumentert utvidelsesmønster, se `modules/consent/src/types.ts`) |
| Utgående AI-samtaler | Som over, PLUSS masterplanens «marketing/reservation/platform rules» |

Å legge til en slik leverandør uten en matriserad blir nå **automatisk blokkert** av porten i §6
(`processor_row_declared` er `false` som default), og en leverandør med en rad, men uten verifiserte
vilkår, blokkeres like automatisk (`processor_terms_status` faller til `NOT_VERIFIED`) —
kapabiliteten kan ikke tas stille i bruk.

## 6. Hva som er STRUKTURELT håndhevet (ikke bare skrevet)

`packages/contracts/src/speech.ts` — `evaluateSpeechRouting()`, den kanoniske, leverandør-uavhengige
rutingsporten. Den gjenbruker det EKSISTERENDE `DataSensitivity`-vokabularet fra D-79/D-81 og har
samme regelform som `isSensitivityEligible()` i `modules/model-gateway/src/router.ts` — **aldri en
parallell sikkerhetsvei**.

1. **`health` → aldri ekstern behandler** (D-23, matrise-regel 2). `health` er den ENESTE space-en
   som klassifiseres `SECRET_RESTRICTED`. Se det viktige forbeholdet i §6.1 — garantien er bare så
   sterk som space-verdien er autoritativ.
2. **Ukjent/manglende memory space tolkes ALDRI som lav-sensitiv** — fail-closed. Dette er D-81 sin
   lærdom ordrett gjenbrukt.
3. **Ekstern behandler uten navngitt matriserad avvises** (matrise-regel 1 gjort strukturell).
4. **Ekstern behandler uten VERIFISERTE vilkår avvises** (matrise-regel 3 gjort strukturell):
   `processor_terms_status` må være `VERIFIED`. Navngitt ≠ kvalifisert. Sjekken kjøres FØR space
   vurderes, så en lav-sensitiv space kan aldri «redde» en uverifisert behandler.
5. **Ingen stille fallback.** Et avslag gir en eksplisitt feil (`speech_routing_denied_stt:<utfall>`
   / `speech_routing_denied_tts:<utfall>`) — porten bytter ALDRI til en annen behandler bak ryggen
   på eieren. Et stille fallback ville skjult at porten slo inn.
6. **Ikke ÉN lydramme** når en ukvalifisert STT-behandler: kontrollen ligger først i `pushAudio()`,
   FØR filtre, VAD og adapter. TTS er dekket tilsvarende, fordi svarteksten i en sensitiv samtale er
   like avslørende som spørsmålet.
7. **Adaptere KAN ikke legges til uten å ta stilling:** `processor` er et påkrevd felt på
   `SttAdapter`/`TtsAdapter`, og `processor_terms_status` er påkrevd i erklæringen. En ny leverandør
   uten erklæring kompilerer ikke, og en som glemmer statusen faller til `NOT_VERIFIED`.

Bevist i `apps/voice-gateway/test/ua7-speech-routing.test.ts` (32 tester, A1-A8/E1-E4/F1-F5/B1-B4/
C1-C8/D1-D3), og observerbart uten en sesjon via `/status` → `speech_routing`.

### 6.1 Tillitsgrensen — LUKKET av D-123 (2026-09-05)

> **OPPDATERT D-123.** Avsnittene under beskriver tilstanden slik den var i D-122, og beholdes
> uendret som historikk framfor å bli stille omskrevet. **Avhengigheten de peker på (Q-32 punkt 2)
> er nå bygget**, og nøyaktig i den formen som ble anvist: se «Status etter D-123» nedenfor.

Porten utleder sensitivitet fra `identity.memory_space`. I voice-transporten kommer den verdien fra
klientens `start`-melding, og gatewayen autentiserer ikke klienten i det hele tatt. Core sin
`resolveIdentity()` (`modules/core/src/services/identity-service.ts`) verifiserer at person, tenant,
enhet og space EKSISTERER, men ingen mekanisme beviser at kalleren ER den påståtte personen, og det
finnes ingen binding person/enhet → tillatte spaces. `DeviceService.verifyChallenge()` finnes og er
ekte proof-of-possession, men brukes i dag KUN til klasse-D-godkjenninger i Policy Gateway.

En feilkonfigurert eller fiendtlig klient kunne derfor merke en helsesamtale `personal` og få
ikke-health-ruting. **D-122 påstår derfor IKKE at D-23 er strukturelt lukket for tale.** Porten er
eksplisitt PARTIAL, og det håndteres fail-closed: en space-verdi som kun er `CLIENT_ASSERTED` kan
ikke KVALIFISERE for ekstern behandling (`DENIED_MEMORY_SPACE_NOT_SERVER_VERIFIED`) — den kan bare
NEKTE. En klient som selv oppgir `health` blir tatt på ordet i innstrammende retning.

**Avhengighet (Q-32, egen fremtidig kanonisk slice — bevisst IKKE bygget i D-122):** en betrodd
server-side memory-space-/sesjonsautoritet i voice-transporten. Den naturlige, ikke-parallelle
formen er gjenbruk av det som allerede finnes — `DeviceService`-utfordring ved tilkobling,
server-eid sesjon via `SessionService`, og en person/enhet → tillatte spaces-binding lest inne i
`resolveIdentity()` — ikke et nytt identitetssystem. Først når den finnes kan en kaller sende
`SERVER_VERIFIED`, og først da er `health → aldri ekstern` en garanti og ikke en forutsetning.

#### Status etter D-123 (2026-09-05) — autoriteten finnes nå

`VoiceSessionAuthority` (`modules/core/src/services/voice-session-authority.ts`) er bygget som ren
komposisjon av de tre eksisterende kanoniske primitivene, i den rekkefølgen §6.1 anviste:

1. `DeviceService.verifyChallenge()` — ekte proof-of-possession, nå bundet til den påståtte personen
   og tenanten. Den bindingen kjøres FØR noen sesjonstilstand skrives, slik at et kryss-person-forsøk
   ikke kan mutere offerets `sessions`-rad før avslaget kommer.
2. `SessionService.resumeOrCreate()` — server-EID sesjon. Klienten oppgir aldri en `session_id`.
   Eksisterende gjenopptaks-semantikk på tvers av kanaler er uendret.
3. `resolveIdentity()` — den kanoniske person↔tenant↔enhet↔space-konjunksjonen under RLS, som ER
   definisjonen av «en faktisk tillatt memory space».

**0 nye tabeller, 0 nye migrasjoner.** System-of-record-auditen (D-123) viste at `person_tenants`,
`devices`, `memory_spaces` og `sessions` allerede representerer bindingen fullt ut. En per-person
space-hviteliste ble bevisst forkastet: den finnes ikke i den kanoniske modellen (minne-RLS er
tenant+space, ikke person+space), og å innføre den i en transport-slice ville vært en ny
autorisasjonsmodell for tale alene.

Tillitsnivået er ikke lenger en konstant. `voiceAuthorityFromGrant()` er den ENESTE veien til
`SERVER_VERIFIED`, og gatewayen henter grant-en selv fra Core (`POST /voice/session/authorize`) —
den leser aldri et grant-felt fra websocketen. En manglende, utløpt eller ugyldig grant faller
innstrammende til `CLIENT_ASSERTED`. Et AVVIST enhetsbevis starter ingen sesjon i det hele tatt.

**`health → aldri ekstern` er dermed en garanti, ikke en forutsetning.** Men merk hva som IKKE
endret seg: ekstern talebehandling er fortsatt avvist for ALLE spaces, nå utelukkende fordi
leverandørens vilkår er uverifiserte (§4, Q-32 punkt 1). `SERVER_VERIFIED` er **nødvendig, men ikke
tilstrekkelig**.

## 7. Kjent, dokumentert restrisiko (ikke skjult)

1. **`health`-tale er i praksis utilgjengelig med dagens konfigurasjon.** Den eneste lokale
   STT-kandidaten (`LocalWhisperStt`) kaster fortsatt `local_whisper_not_implemented_in_pilot`.
   Konsekvensen av porten er derfor ærlig: en `health`-samtale AVVISES i stedet for å bli sendt til
   sky. Det er det korrekte utfallet av D-23, men det er en reell kapabilitets-mangel, ikke en
   løsning — den lukkes først når en lokal STT/TTS faktisk installeres.
2. ~~**`memory_space` oppgis av klienten** og valideres ikke mot en server-side sesjonsautoritet.~~
   **LUKKET av D-123 (2026-09-05).** En klient som beviser enheten sin får nå en server-utstedt
   grant, og HVERT identitetsfelt i sesjonen kommer fra den grant-en — ikke fra `start`-meldingen.
   En klient som IKKE beviser noe kjører fortsatt `CLIENT_ASSERTED`, som per konstruksjon bare kan
   nekte ekstern behandling. Restrisikoen som gjenstår er en helt annen og mindre: en ubevist klient
   kan fortsatt merke sin EGEN samtale feil og dermed få sin egen lokale ruting feil. Den kan ikke
   nå en ekstern behandler, ikke nå en annen persons space, og ikke heve sin egen autoritet. Full
   redegjørelse: §6.1 «Status etter D-123».
2b. **Gateway→Core-kanalen er selv uautentisert** (D-123, eksplisitt oppgitt framfor skjult).
   Grant-ens troverdighet hviler på at Voice Gateway faktisk snakker med den ekte Core-en på
   `JARVIS_CORE_URL`. Det er en PRE-EKSISTERENDE egenskap - `/chat` har alltid hatt samme
   forutsetning - og den er ikke innført av D-123, som strengt strammer inn: før D-123 kunne
   *klienten* velge space, nå kan bare *Core* det. I dagens oppsett binder begge prosessene
   localhost på samme maskin (`DEPLOYMENT_STRATEGY.md`). En gjensidig autentisert intern kanal
   mellom Jarvis-prosessene er en egen, bredere oppgave enn taleautoritet, og er bevisst ikke
   oppfunnet inne i denne sliceen.
3. **Leverandørens egne vilkår er ikke verifisert** (§4), og ekstern talebehandling er derfor
   avvist i dag. Porten sier ingenting om hva OpenAI gjør med dataene — den nekter bare å sende dem.
4. **`UA7_ACCEPTANCE_4` er `PARTIAL`, ikke `PASS`** — se kriterium-statusen øverst. Kriteriet lukkes
   av eier-/juridiske fakta (Q-32), ikke av kode.
5. **Realtime/tale-til-tale** er fortsatt `TBD` i matrisen og ikke i bruk.

## 8. Oppdateringsplikt

Dette notatet oppdateres FØR — ikke etter — hver nye tale-/transkripsjons-/samtalebehandling tas i
bruk: ny STT/TTS/realtime-leverandør, møtetranskripsjon, SIP/telefoni, samtaleopptak av tredjepart,
eller utgående AI-samtaler. Samme regel som matrisens egen: en rad som ikke er fylt ut, er ikke i
produksjonsbruk.

---

## 10. UA-7 resterende deler (WP-G1, D-463) - UTKAST, krever juridisk gjennomgang

> **Status: UTKAST (`DRAFT_REQUIRES_LEGAL_REVIEW`).** Alt under er DORMANT (AV som standard, bak `JARVIS_COMMS_*`-flagg) og `NOT VERIFIED`: ingen live-test er kjørt, ingen leverandørvilkår er verifisert, og ingen rettslig vurdering er gjort.
> Dette er en teknisk redegjørelse for hva koden gjør og hva den bevisst IKKE gjør - ikke en juridisk konklusjon. **Jarvis avgjør aldri selv et rettslig grunnlag** (samme prinsipp som §0 og `modules/consent`, D-91): koden håndhever
> registrerte erklæringer og fail-closed regler. Alle punkter merket «JURIDISK» må vurderes av en jurist før produksjonsbruk. `UA7_ACCEPTANCE_4` er UENDRET `PARTIAL`; `UA7_COMPLETE=false`.
> Ansvarlige filer: `modules/comms/` (policy, adaptere, webhooks, kontakter, møter, sveip), migrasjon 118/119, `docs/runbooks/WPG1_COMMS.md`.
> Fiks-runden etter to uavhengige gjennomganger er innarbeidet; endringer som berører personvern er merket med funn-id (A-/B-) og status per funn står i runbook §10. **WP-G1c (D-481, 2026-11-25)** har lagt til: saltet innholds-hash (HMAC med pepper), deterministisk STOP/START-rekkefølge, databasevern for avmeldinger og journal, eierens angre av en feilregistrert avmelding, batch-tak med lange id-er, lagrede kontaktkonflikt-forslag og STOP-vakt for de eldre notify-verktøyene; ny tabell `comms_inbound_receipts` og (K4) `comms_contact_conflicts`. **Fiks-runde 1 (etter to uavhengige gjennomganger)** har rettet: byte-grense per leverandør og fremdrift over batch-taket, STOP-vinner-marginen på 5 s, streng Discord-vakt, pepper-krav og tenant-skilte HMAC-nøkler, hashing av WhatsApp-hendelsesnøkler, og de nøyaktige formuleringene om DELETE-vernet og kvitteringstabellen (§10.6/§10.7). Fortsatt DORMANT og `NOT VERIFIED`; juridisk gjennomgang gjenstår.

### 10.1 Nye kanaler og behandlere (alle IKKE VERIFISERT)

| Kanal / kilde | Leverandør (transport/adapter, D-64) | Hva som sendes/leses | Behandlerstatus |
|---|---|---|---|
| Slack, Discord | Slack / Discord | utgående tekst (eier-initiert), lesing av tråd/melding, signerte innkommende hendelser | databehandlervilkår/region IKKE VERIFISERT |
| WhatsApp (Business Cloud API), Messenger, Instagram | Meta | utgående tekst/mal (24-timersvindu), innkommende signerte hendelser | IKKE VERIFISERT; app-gjennomgang kreves (BLOCKED_EXTERNAL) |
| SMS og utgående samtale | Twilio (Telnyx kun SMS) | utgående SMS/manus, STOP-hendelser, leveringsstatus | IKKE VERIFISERT |
| Teams | Microsoft Graph (kun delegert sending) | utgående tekst | IKKE VERIFISERT; eierens re-samtykke kreves (BLOCKED_EXTERNAL) |
| Kontakter | Google People API | kontaktnavn/e-post/telefon/organisasjon (lesing og eierens egne endringer) | IKKE VERIFISERT; nytt OAuth-scope kreves (BLOCKED_EXTERNAL) |
| Møtetranskripsjon | eksisterende tekstkilder (UA-2/Meet/Teams); lyd via lokal talebehandler (ikke bundet) | transkript (kun i minnet under behandling) | ekstern talebehandler er AVVIST av rutingsporten (D-122) |

### 10.2 Utgående kommunikasjon (felles policy)

- **Formål og grunnlag.** Formålene er `transactional` / `agreed` / `marketing`. `agreed` krever BEVIS på et forhold (verifisert innkommende tråd eller løst identitet) - aldri bare at avsenderen påstår det. `marketing` **feiler lukket** i dag:
  samtykkeregister er ikke bygget (JARVIS-084 er bevisst ikke bygget, Q-47f) og oppslag mot Reservasjonsregisteret er ikke verifisert. JURIDISK: markedsføringsloven § 15 og Reservasjonsregisteret må vurderes før noen aktivering - teksten i loven er ikke verifisert mot offisiell kilde i denne økten.
- **Første kontakt med en «kald» mottaker krever eierens erklærte formålsgrunnlag (A-M2).** Formålet (`transactional`/`agreed`) velges av kalleren og kunne ellers merkes «ryddig» på en salgsmelding; nøkkelordsfilteret er ikke et grunnlag. En mottaker er «kald» med mindre relasjonsbevis finnes: en innkommende melding siste 7 dager, eller en eier-konfigurert/eksakt lenke i identitetsregisteret (`exact_email`, `exact_phone_e164`, `exact_handle`, `owner_configured`) med confidence ≥ 0,9. En kontakt i eierens egen kontaktbok (`contact_sync`), en manuell lenke og en lenke med lav confidence regnes IKKE som bevis. Da kreves `purpose_basis` for ALLE formål, også for en AI-samtale: en lukket liste (`recipient_requested_contact`, `existing_customer_relationship`, `order_or_agreement_followup`, `consent_obtained_outside_jarvis`, `personal_non_commercial`) og eventuelt et kort notat (≤ 200 tegn, én linje, hemmeligheter avvises). Mangler det, feiler sendingen LUKKET (`purpose_basis_required`). Grunnlaget og notatet journalføres i mottakerbeviset, og den lukkede verdien står i eierens umiddelbare varsel. Dette er eierens uttrykkelige erklæring av det loven krever kan påvises (markedsføringsloven § 15), IKKE en kunstig godkjenningssperre for eieren, og Jarvis avgjør aldri selv at grunnlaget holder (D-122): påstanden er eierens. Reklameord i innholdet avslås uansett oppgitt grunnlag (også ved redigering av en sendt melding, A-M6). JURIDISK: listen og beviskravet er et teknisk utgangspunkt, ikke en juridisk klassifisering.
- **AI-opplysning.** Koden legger «Sendt av Jarvis (AI-assistent).» til hver tekstmelding og hver mediebeskrivelse (og FØRST i en samtale); en parameter kan ikke slå den av. En WhatsApp-lydmelding kan ikke bære tekst (A-M1): opplysningen sendes da som en egen tekstmelding FØRST og lyden rett etter; lyd uten tekst avvises, og feiler lyden etter at teksten er levert, er utfallet `outcome_unknown` (noe er levert), ikke «feilet». En godkjent WhatsApp-mal må være attestert av eieren å inneholde opplysningen. JURIDISK: EU AI Act art. 50(1) gjelder (etter det som er søkt frem) fra 2. august 2026, men anvendelighet i EØS/Norge er ikke verifisert; opplysningsteksten er eierens (konfigurerbar), ikke en juridisk formulering.
- **Mottakerens avmelding (STOP) er tenant-bred (A-M3/A-M7).** Egen tabell (`comms_recipient_opt_outs`), pseudonymisert (SHA-256 med tenant + navnerom i saltet; et telefonnummer er ÉN mottaker enten vi når det på SMS, WhatsApp eller med en AI-samtale) + maskert visning. Avmeldingen gjelder alle våre avsenderkontoer, alle rom og alle kanaler som deler identifikator - ikke bare kontoen/kanalen den ble sendt til - og en STOP til en konto eieren ikke har autorisert registreres likevel. Avmeldingen lagres som én rad per kanal og kilde (stopp-ord, leverandørfeil, eierregistrert): en senere STOP overskrives eller slås aldri sammen med en annen. Kun mottakerens EGEN START opphever en avmelding som mottakeren selv ga (stopp-ord/leverandørfeil), og kun på SAMME kanal - en avmelding består så lenge en rad står aktiv på en annen kanal (mottakeren må sende START på hver kanal hen meldte seg av), og en eierregistrert avmelding løftes aldri av START. Eieren kan registrere, og kan angre en FEILregistrert avmelding med en egen klasse D-handling (`lift_owner_opt_out`, kun `owner_recorded`: step-up, obligatorisk begrunnelse, person og sesjon på raden; aldri en avmelding mottakeren selv står bak; step-up-kanalen er klient-påstått inntil WP-S1/JARVIS-111). Rekkefølgen mellom STOP og START avgjøres av plattformens egen mottaks-/registreringssekvens (en START løfter kun en avmelding som ble registrert FØR den ble mottatt OG mer enn 5 sekunder før (databasens klokke): «STOP vinner» også ved millisekund-overlapp og samtidig oppstart, og en START rett etter en STOP løfter ingenting, så mottakeren må sende START på nytt); leverandørens tidsstempel brukes ikke, og restrisikoen at en leverandør leverer i feil rekkefølge eller forsinket (Twilio signerer ikke tid) er IKKE dekket av garantien, AKSEPTERT og beskrevet i runbook §10 «WP-G1c». Avmeldinger slettes IKKE av retensjonssveipet (et rettighetsvern); de slettes kun ved full tenant-/romsletting (en databasetrigger håndhever det, og at ingen kan løfte dem utenom reglene). Eksisterende samtykkekontroller er uendret. JURIDISK: om en tenant-bred avmelding er det rette omfanget, og om START skal gjelde bare samme kanal, er en juridisk vurdering - koden velger den forsiktige tolkningen.
- **Idempotensavtrykk i ledgeren (WP-G1b, JARVIS-112 a).** For ikke-journalførte eier-handlinger (avmelding, kontakter, møter, kontoer) er en tenant-bundet SHA-256 (128 bit) av nyttelasten et ledd i `tool_executions.idempotency_key` (og i eier-varselets «Referanse» for sletting). Det er en pseudonymisert, men ikke saltet avledning: for lavt-entropi-data (telefonnummer, e-post) kan et kjent kandidatnavn bekreftes med ordliste av den som kan lese databasen. Nøkkelen ligger i `tool_executions`, som er UTENFOR erasure-planen og beskjæres etter retensjonen (minst 30 dager, standard 180; `unverified`/`reserved` slettes aldri). For `contacts_create/update` er det en ny avledet kopi av data som ellers ikke lagres. Tiltak: tenant-binding (samme data i to tenants gir ulikt avtrykk), ingen råtekst, ingen nøkkel i audit-rader eller klientsvar; åpent: pepper (Q-78) og å ta `tool_executions` inn i erasure-planen (JARVIS-102-resten).
- **Stille timer, ratebegrensning, plattformvindu.** Standard stille timer 22-08 (Europe/Oslo), maks 3 meldinger/mottaker/døgn (1 «kald»), 30/konto/time; WhatsApp/Messenger/Instagram: fritekst kun innenfor 24 t etter mottakerens siste melding (WhatsApp: godkjente maler utenfor). Tallene er konservative VALG, ikke lovfestede normer (UVERIFISERT, JURIDISK). Takene telles og reserveres atomisk i journalen under lås (A-H2); per-mottaker-taket gjelder tenant-bredt på tvers av rom (samme mottaker er ÉN mottaker uansett rom), kontotaket per konto; tidssonen er alltid Europe/Oslo (en samtale ringes aldri en søndag eller en norsk helligdag, WP-G1c g2; helligdagsfredens klokkeslett fra kvelden før er ikke bygget, og ingen land-/nummertype-liste for premium-numre: åpent).
- **Pseudonymisering er ikke anonymisering:** et telefonnummer kan brute-force-hashes. Journalen (`comms_outbound_log`) lagrer hash+lengde av innholdet (aldri teksten), mottaker-pseudonym, regelutfall, mottakerbevis (inkl. oppgitt formålsgrunnlag og notat) og leverandørens meldings-id; 400 dager (konfigurerbar 30-1825). Innholds-hashen er siden WP-G1c en HMAC-SHA256 med en server-side pepper fra vaulten (uten pepperen sendes ingenting), så en kort melding kan ikke lenger gjettes med en ordliste av den som bare leser databasen. Rader fra før er fortsatt usaltede (`content_hash_version` 1) og omskrives ikke. **Mottaker-pseudonymene er fortsatt usaltede og reversible for norske nummer** (ca. 10^7-10^8 kandidater; `recipient_hint` gir første og siste tre tegn): et telefonnummer kan bekreftes med ordliste av den som kan lese databasen. Kjente kontakters nummer ligger allerede i klartekst i samme database, så ingen ny eksponering der; for ukjente STOP-avsendere er hash og hint eneste spor. Et salt trenger ikke å foreldreløse eksisterende rader (dobbeltlesing med versjonskolonne og HMAC med formål `recipient`, skissert i runbook), men er DEFERRED til en egen beslutning.

### 10.3 Utgående AI-samtale (P3h)

Kun Twilio, kun inline TwiML (`<Say voice language>`, XML-escapet; XML-ugyldige tegn avvises; standardstemmen `Polly.Liv` for norsk er UVERIFISERT), AI-opplysning FØRST i manuset, **opptak er ikke støttet** (en forespørsel om opptak avslås med kode `call_recording_not_supported`; ingen rettslig grunnlag-mekanisme finnes). Eget tidsvindu (standard 09-20 lokal tid), maks ett anrop per nummer per døgn,
tenant-bred avmelding respekteres (også en STOP gitt på SMS/WhatsApp til samme nummer), en kald mottaker krever `purpose_basis` som for meldinger, markedsføring avslås. Telnyx-samtale er DEFERRED (opplysningen kan ikke garanteres som første talte innhold uten `call.answered`-flyten). Ingen ekte samtale er gjennomført; verifisering kun mot falsk transport. JURIDISK: tidsvindu, anropsgrense, samtykke/reservasjon for samtaler og
opplysningsplikt ved bruk av syntetisk stemme må vurderes; standardene er forsiktige valg, ikke normer.

### 10.4 Møtetranskripsjon (P2g)

- **Rettslig grunnlag:** eieren må EKSPLISITT attestere per møte (`attest_legal_basis: true`; CHECK i databasen). Attesten er et revisjonsspor, ikke en juridisk konklusjon. JURIDISK: grunnlag for å behandle andre deltakeres tale/tekst (informasjon til deltakerne, samtykke eller berettiget interesse) må vurderes av en jurist.
- **Minimering:** selve transkripsjonsteksten lagres ALDRI (kun innholds-hash, antall segmenter, tittel, deltakernavn og korte forpliktelses-utdrag ≤ 300 tegn). E-postadresser redigeres bort av parseren. Forpliktelser er FORSLAG funnet av navngitte, deterministiske mønstre (ingen modell, ingen profilering); de blir en åpen oppfølging først når eieren godtar dem.
- **Etter eierens godkjenning (B-M4, DELVIS):** et godtatt forslag kopierer ≤ 300 tegn utdrag til en åpen oppfølging i Business (`business_followups`), som brief/chat leser som INTERNT data - ubetrodd transkripttekst kan dermed nå en modell som kontekst, men først etter eierens eget valg. Utdraget er innrammet som sitert, ubetrodd tekst (fast prefiks, sitattegn byttes ut så teksten ikke kan lukke rammen). `business_followups` har ikke et eget proveniensfelt (DEFERRED). «Ingen modell» over gjelder utvinningen av forslag, ikke hva som senere leses av chat.
- **Deltakere:** kobles til en identitet kun ved eksakt kanal-id-treff eller eierens bekreftelse; et rent navnetreff er et forslag (ukjent forblir ukjent).
- **Lyd:** bare tjenestemetode (ingen filsti-flate); rutingsporten `evaluateSpeechRouting` (D-122) avviser ekstern behandler uten verifiserte vilkår og helse-space mot ekstern; produksjonsadapter er IKKE bundet (DEFERRED). **Ingen møte-bot** (en slik er en ekstern kjerneavhengighet: `CORE_DEPENDENCY_DECISION_REQUIRED`).
- **Oppbevaring:** 180 dager (`JARVIS_COMMS_MEETING_RETENTION_DAYS`, 30-1825); sveip hver 6. time; Q-20-sletting via erasure-planen (ikke koblet i produksjon, JARVIS-060). Eieren kan slette et møte (klasse D, `meeting_delete`): preflight og readback bærer KUN `{exists, meeting_id}`, så tittel og deltakernavn havner aldri i ledger/audit (B-M3; `audit_events` har ellers ingen retensjonssveip). Godtatte oppfølginger i Business beholdes.

### 10.5 Kontakter og identitetslenking (P2e)

Google Contacts er eierens EGEN kontaktbok; innholdet behandles som ubetrodd data (renset, minimert til navn/e-post/telefon/organisasjon, aldri adresser/notater/bilder). `contacts_sync` lenker deterministisk (eksakt E.164/e-post, `contact_sync`, confidence 0.9) og **binder aldri en kontakts identifikatorer til en identitet en ANNEN kontakt allerede eier** (B-H1): peker identifikatorene på ulike identiteter, eller på en identitet en annen kontakt har lenket seg til (typisk delt sentralbord-/fasttelefon eller delt e-post) - også når to synker kjører samtidig: oppløsning, kontroll og skriving er atomiske bak en lås, og en feil midtveis ruller alt tilbake -, HOPPES kontakten over og rapporteres som konflikt i synk-resultatet (ressursnavn, aldri telefon/e-post); konflikter lagres som FORSLAG (WP-G1c K4, `comms_contact_conflicts`: kun Googles ressursnavn, art, konfliktsett, teller og eierens avgjørelse med person og tidspunkt; aldri telefon, e-post eller navn) som eieren godtar eller avviser. Godta lenker kontakten til den delte identiteten (kun når en annen KONTAKT eier den; aldri en sammenslåing av ulike identiteter) med `contact_sync`/confidence 0,9, så mottakeren fortsatt regnes som kald (kald-regelen er uendret og venter på eierens bekreftelse, Q-72 pkt 11); avvis huskes. Ressursnavn er pseudonyme identifikatorer for personer i eierens Google-konto. Lenking er REVERSIBEL: `contacts_unlink` tilbakekaller lenkene en kontakt har satt (status `revoked`, ingen rad slettes, intet endres hos Google), og `restore` angrer det (hopper over en lenke hvis identifikator nå har en annen aktiv lenke). Merge/split av identiteter er egne, reversible eier-handlinger i Conversation Graph og skjer aldri som bivirkning av en synk. Oppdatering hos Google endrer kun oppgitte felt (lese-endre-skriv på den ferske kontakten, etag-sjekk, B-M1). Kontaktens visningsnavn lagres på identiteten (`display_name`, renset) uten eget proveniensfelt (DEFERRED). Sletting hos Google er en klasse D-handling (preflight + readback). JURIDISK: kontaktpersonene er tredjeparter; behandlingen er eierens personlige/forretningsmessige bruk - vurder grunnlag og informasjonsplikt.

### 10.6 Innkommende hendelser og oppfølging

Kun signaturverifiserte webhooks (Slack, Meta, Twilio, Telnyx) lagres, som UBETRODD data (≤ 2000 tegn, kontrolltegn renset, hemmeligheter redigert), 30 dager (1-365); avmeldings-/gjenopptakshendelser beholdes 1825 dager uten tekst (en gjenspilt gammel START skal ikke oppheve en nyere STOP). En STOP til en konto eieren ikke har autorisert registreres likevel som tenant-bred avmelding (kun pseudonym og hint); øvrige hendelser fra ikke-autoriserte kontoer lagres ikke. En signert forespørsel behandler høyst 1000 NYE hendelser (kjente duplikater og ignorerte teller ikke; tallet er UVERIFISERT mot Metas primærkilde), STOP/START først; gjenstår det nye hendelser, svarer tjenesten 503 så leverandøren sender på nytt og hver retry tar neste porsjon (aldri en stille forkastning), og lange leverandør-id-er hashes i stedet for å forkastes. Rå-kroppen har en byte-grense per leverandør FØR signaturen (Meta 4 MiB, øvrige 256 KB; et avslag logges med leverandør og årsakskode, aldri innhold), så en gyldig, stor Meta-batch ikke avvises og mister en STOP. For en START lagres første mottak (hendelsesnøkkel, en sekvens og databasens tidspunkt; ingen rå mottaker-id og ingen tekst) i `comms_inbound_receipts` FØR behandlingen, så en retry beholder sin opprinnelige rekkefølge. Hendelsesnøkkelen for WhatsApp er ALLTID en SHA-256 av meldings-id-en og aldri den rå id-en (en `wamid` KAN, UVERIFISERT mot en ekte id, kode avsenderens telefonnummer i base64); samme nøkkel står i `comms_inbound_events` og som peker i avmeldingens `evidence_ref`. **STOP vinner innenfor 5 sekunder:** en START løfter kun en STOP som ble registrert mer enn 5 s (databasens klokke) før START-en ble mottatt; innenfor marginen, og når en STOP registreres etter at START-en ble mottatt, forblir mottakeren avmeldt (en START rett etter en STOP løfter altså ingenting, og mottakeren må sende START på nytt). IKKE garantert og AKSEPTERT som restrisiko: en leverandør som leverer i feil eller forsinket rekkefølge (Twilio signerer ikke tid) kan gi en annen rekkefølge enn mottakeren sendte. **Kjent begrensning (ÅPEN):** Twilio signerer ikke et tidsstempel, så en gyldig signert, fanget gammel meldingshendelse kan etter 30 dager (dedupe-raden er slettet) lagres på nytt som ubetrodd hendelse. Ubesvarte meldinger kan bli åpne oppfølginger (`JARVIS_COMMS_REPLY_SWEEP`) som leveres av
V2-pushen til eierens egen Telegram - med fast tittel (kanal + maskert avsender) uten meldingstekst; utvalget er rettferdig og begrenset (kjente avsendere først, tak per kanal og for ukjente, B-M2).

### 10.7 Oppbevaring (oppsummert) og åpne juridiske punkter

| Data | Oppbevaring | Slettes av |
|---|---|---|
| Innkommende hendelser (tekstutdrag) | 30 d (1-365) | sveip, erasure |
| Avmeldings-/gjenopptakshendelser | 1825 d (kun pseudonym, ingen tekst) | sveip, erasure |
| Utgående journal | 400 d (30-1825) | sveip, erasure |
| Første-mottak-kvitteringer for avmeldings-/gjenopptakshendelser (`comms_inbound_receipts`: hendelsesnøkkel - for WhatsApp en SHA-256 av meldings-id-en, aldri den rå id-en -, sekvens, databasens tidspunkt) | 1825 d (ingen rå mottaker-id, ingen tekst; rettet i fiks-runde 1: tidligere stod den rå `wamid`, som UVERIFISERT kan kode et telefonnummer) | sveip (databasen avviser sletting før fristen), erasure |
| Avmeldinger, konto-allowlist | til opphevet/tilbakekalt | mottakerens START (samme kanal; kun stopp-ord og leverandørfeil, og ikke innenfor 5 s etter STOP), eierens angre av en feilregistrering (`owner_recorded`, med begrunnelse), konto-tilbakekall; erasure. Databasetriggeren stopper kodefeil og app-SQL uten erasure-modus, men en app-forbindelse med FRI SQL kan sette erasure-markøren selv og slette (DELVIS: vern mot kodefeil, ikke mot en kompromittert app-tilkobling; Q: SECURITY DEFINER-funksjon eller egen erasure-rolle). En avmelding mottakeren har bedt om utenfor kanalen (`recipient_request`) kan ikke oppheves av noen (verken START eller eier) uten databaseinngrep eller ny migrasjon. Det finnes ingen innsyns- eller slettevei per mottaker (kun rom-/tenantsletting) |
| Kontaktkonflikt-forslag (`comms_contact_conflicts`: Googles ressursnavn, art, konfliktsett, eierens avgjørelse; ingen telefon, e-post eller navn) | til erasure (en godtatt konflikt styrer fremtidige synker, så et retensjonssveip ville stille endret atferd) | erasure (databasetriggeren avviser sletting utenfor erasure-modus; samme begrensning som for avmeldinger: en app-forbindelse med fri SQL kan sette markøren) |
| Møter, deltakere, forslag | 180 d (30-1825) | sveip, eieren (D), erasure |
| Idempotensavtrykk (tenant-bundet hash av nyttelasten) i `tool_executions.idempotency_key` for eier-handlinger (WP-G1b, §10.2) | `tool_executions`-retensjonen (minst 30 dager, standard 180; `unverified`/`reserved` slettes aldri) | beskjæring (`073_operational_retention.sql`); IKKE erasure-planen (JARVIS-102-resten, Q-78) |
| Godtatt møteforpliktelse (oppfølging i Business) | oppfølgingens egen retensjon | Business/erasure - IKKE av møtesveipet |

**Åpne punkter til jurist/eier (ingen er løst av kode):** (1) markedsføringsloven § 15 / Reservasjonsregisteret og samtykkeregister; (2) AI-opplysningsplikt (EU AI Act art. 50, nasjonal gjennomføring); (3) regler for utgående AI-samtaler og opptak; (4) grunnlag og informasjon for møte-/samtale-deltakere; (5) databehandleravtaler, region og vilkår for alle leverandørene i §10.1; (6) om pseudonymiserte mottakere (SHA-256) er tilstrekkelig minimering;
(7) oppbevaringstider; (8) Telegram-/chat-relaterte juridiske punkter (JARVIS-087) er IKKE behandlet her; (9) listen over formålsgrunnlag for kald mottaker (A-M2) og beviskravet (kontaktbok-lenker regnes som kalde); (10) tenant-bred STOP og START-regelen (kun samme kanal); (11) møte-/kontaktdata som når modellkontekst via oppfølgingsrader og visningsnavn (B-M4); (12) mottaker-pseudonymene og G1b-nyttelastavtrykket er fortsatt usaltede, og mottaker-pseudonymene er REVERSIBLE for norske nummer (ca. 10^7-10^8 kandidater; `recipient_hint` gir første og siste tre tegn) - innholds-hashen i journalen er saltet siden WP-G1c (DEFERRED: dobbeltlesing med versjonskolonne og HMAC, se runbook); (13) om eierens angre skal gjelde kun `owner_recorded` (bygget i WP-G1c; `recipient_request` kan ikke angres) og om step-up-kanalen er god nok (klient-påstått, JARVIS-111); (14) restrisikoen at en leverandør leverer STOP og START i feil rekkefølge (AKSEPTERT i WP-G1c, ev. tilleggsvern med signert leverandørtid); (15) om kontaktbok-lenker fortsatt skal regnes som kalde (Q-72 pkt 11; atferden er uendret og festet av en test, venter på eierens bekreftelse); (16) om helligdagsfredens klokkeslett (fra kvelden før) og julaften/nyttårsaften skal gjelde ringevinduet; (17) de eldre notify-verktøyene har STOP-vakt kun i api-prosessen (ikke workeren) og fortsatt ingen tak, journal eller formålsgrunnlag; Slack-kanalnavn (`#navn`) og generiske automasjonsverktøy (n8n/make/zapier-MCP) er udekket; (18) en mottaker som vil melde seg på igjen etter en `recipient_request`-avmelding har ingen vei, og en feilregistrert slik rad kan ikke angres (egen D-handling `resubscribe` med step-up og beviskilde, eller en dokumentert driftsprosedyre); (19) det finnes ingen innsyns- eller slettevei per mottaker (kun rom-/tenantsletting); (20) WhatsApp-meldings-id-er (`wamid`) kan, UVERIFISERT, kode et telefonnummer: innkommende nøkler hashes, men UTGÅENDE `provider_message_id` i journalen (nødvendig for å redigere/slette meldingen) lagres rått i 400 d; (21) vernet mot sletting av avmeldinger er en transaksjonslokal markør en app-forbindelse med fri SQL kan sette (se tabellen over).
