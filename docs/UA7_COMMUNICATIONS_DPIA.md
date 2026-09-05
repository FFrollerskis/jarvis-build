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
> databehandleravtale, treningsvilkår, retensjon) er fortsatt `IKKE VERIFISERT` (**Q-32**), og
> voice-transporten mangler en betrodd server-side memory-space-autoritet (også Q-32). Kriteriet
> settes til `PASS` FØRST når de fakta faktisk foreligger — ikke av kode, og ikke av dette notatet.

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

### 6.1 Hva porten IKKE garanterer (tillitsgrensen, eksplisitt)

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

## 7. Kjent, dokumentert restrisiko (ikke skjult)

1. **`health`-tale er i praksis utilgjengelig med dagens konfigurasjon.** Den eneste lokale
   STT-kandidaten (`LocalWhisperStt`) kaster fortsatt `local_whisper_not_implemented_in_pilot`.
   Konsekvensen av porten er derfor ærlig: en `health`-samtale AVVISES i stedet for å bli sendt til
   sky. Det er det korrekte utfallet av D-23, men det er en reell kapabilitets-mangel, ikke en
   løsning — den lukkes først når en lokal STT/TTS faktisk installeres.
2. **`memory_space` oppgis av klienten** i `start`-meldingen (`server.ts`) og valideres ikke mot en
   server-side sesjonsautoritet. Dette er en PRE-EKSISTERENDE egenskap ved voice-transporten (D-122
   innfører den ikke). Etter arkitekt-reviewen av PR #71 er konsekvensen ikke lenger bare beskrevet,
   men håndtert fail-closed: en klient-oppgitt space kvalifiserer ikke for ekstern behandling i det
   hele tatt. Full redegjørelse og avhengighet: §6.1. Registrert som del av Q-32.
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
