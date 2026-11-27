# Jarvis – talearkitektur (Voice Gateway)

> **Dokumentstatus (ADR-001, D-398/JARVIS-100):** utkast som aldri er formelt godkjent og delvis overstyrt de facto av senere D-beslutninger ([ADR-001](remediation/ADR-001-dokumenthierarki.md) §2.2). Bruk dokumentet som *strengeste-regel*-kilde - ikke som bevis for at noe er bygget, godkjent eller verifisert. Status per funn: [FINDINGS_LEDGER](remediation/FINDINGS_LEDGER.md).

**Status:** Utkast v1.0. Ved motstrid gjelder [CANONICAL_SPEC.md](CANONICAL_SPEC.md).

## 1. Rolle og avgrensning

Voice Gateway er en **egen sanntidsprosess** som eier hele lydkjeden: transport, taledeteksjon,
lydforbedring, streaming STT, streaming TTS og barge-in. Den er **ikke** en del av Home Assistant.

- Home Assistant Assist er kjørbar **reservevei** (nødfallback for grunnkommandoer) – aldri autoritativ
  samtalemotor, aldri egen identitet.
- Voice Gateway inneholder ingen samtalelogikk: den konverterer lyd ↔ tekst/hendelser og snakker med
  Core over en typet kontrakt. All dialog, minne og policy bor i Core.
- Full-duplex er grunnkrav fra første pilot – arkitekturen beholdes selv om maskinvare, transport eller
  leverandør byttes.

## 2. Målkrav (fra masterplanen)

| Krav | Mål |
|---|---|
| Barge-in | Avspilling stopper ≤250 ms etter ren tale |
| Første talerespons | <1,5 s median; måles også P95 |
| Enkel kommando | Rutes deterministisk uten stor LLM |
| Failover | Samme sesjon gjenopptas etter lokal/sky-failover uten doble verktøyhandlinger |
| Norsk kvalitet | Provider-benchmark på ≥100 lydprøver før valg låses |

## 3. Lydkjeden

```
Mikrofon → [satellitt: wake-word · AEC · støyreduksjon] → WebRTC (Opus)
  → Voice Gateway: VAD → streaming STT → tekst + metadata → Core
Core → tekststream → Voice Gateway: streaming TTS → WebRTC → høyttaler
                              ▲
       barge-in: VAD oppdager tale → stopp TTS ≤250 ms → ny STT-tur
```

- **Transport:** WebRTC (Opus) for rom-satellitter og mobil; WebSocket-fallback for enkle klienter.
  Kandidat: selvhostet LiveKit som SFU/sesjonslag – besluttes i fase 5 (se OPEN_QUESTIONS Q-03).
- **VAD:** lokal, lettvekts (f.eks. Silero-klasse) i gateway og helst også på satellitt.
- **AEC/støyreduksjon:** på satellitten der mulig (maskinvare/WebRTC-stack), ellers i gateway.
- **STT:** streaming med partielle resultater, bak `SpeechAdapter`. Kandidater (norsk): skybaserte
  streaming-APIer og lokal Whisper-klasse; avgjøres av benchmarken, ikke av antakelser.
- **TTS:** streaming (første lydbyte raskt), bak samme adapterlag. Norsk kvalitet og latens benchmarkes.
- **Wake-word:** på satellitt, lokalt. Norsk wake-word er et målepunkt i fase 5.

## 4. Sesjonsmodell

- En talesesjon er samme `session_id` som tekstsesjonen – kanalbytte (rom → mobil → web) beholder samtalen.
- Romsesjon binder `site_id`/`room_id` til sesjonen for stedsriktige kommandoer («skru på lyset her»).
- **Gjenopptak (oppdatert WP-V2/D-488 - tidligere tekst lovte mer enn koden gjør):** utterance-journalen
  (nøkkel: tillitsnivå, tenant, enhet, `utterance_id`) er **prosess-delt**, **atomisk** (`claim` før Core-kallet, så to samtidige
  `replay_final` gir ett Core-kall) og **begrenset** (LRU + TTL). Den ligger i prosessminnet: **den overlever ikke en omstart og
  deles ikke mellom gateway-prosesser** (`PARTIAL` - varig deling krever en Core-rute og migrasjon, egen WP). Spillekø og siste tur
  checkpointes **ikke**. Dobbeltutførelse hindres derfor fullt ut kun innen samme gateway-prosess; ut over det kun delvis av
  ToolGateway-ledgerens idempotensnøkkel (10 minutters tidsvindu). Etter en Core-feil beholdes claimen (ukjent utfall - aldri retry), unntatt når feilen BEVISER at forespørselen aldri nådde Core (ubevist sti, nektet tilkobling/DNS: da kan samme id sendes på nytt). Se [runbooks/WPV2_VOICE_ROBUSTNESS.md](runbooks/WPV2_VOICE_ROBUSTNESS.md) §5.
- Avbrutt TTS logges som «ikke levert» slik at Jarvis vet hva Tobias faktisk hørte.

## 5. Rask bane i tale

Fast Router kjører på den transkriberte teksten (og på satellittens lokale intents):

1. Kjent kommando («slå av lyset», «status», «stopp») → deterministisk verktøy via Policy Gateway →
   kort bekreftelse via TTS. Ingen stor LLM involvert.
2. Alt annet → Core sin intelligente bane med streaming-svar.
3. Ruting, policykontroll og eventuell bekreftelseslyd kan kjøre parallelt med kontekstinnhenting.

## 6. Personvern i talekjeden

- Ingen kontinuerlig lagring av rå romlyd; kun buffere med kort, dokumentert levetid.
- Wake-word og VAD kjører lokalt; lyd forlater ikke rommet før aktivering.
- Fysisk mute og synlig lytteindikator på alle satellitter; gjestemodus uten privat minne.
- Tale-DPIA (formål, grunnlag, region, retensjon, modelltrening, kryptering, om rå lyd forlater huset)
  fullføres **før** en skyleverandør av STT/TTS tas i produksjonsbruk.
- Stemmeprofil brukes aldri alene som godkjenning for kritiske handlinger.

## 7. Benchmark-port (fase 5, før valg låses)

Norsk provider-benchmark på minst 100 lydprøver (dialekter, støy, avstand, barnestemmer/gjester):

- STT: ordfeilrate, egennavn, tall/datoer, P50/P95-latens, pris, datavilkår/region.
- TTS: naturlighet (subjektiv skala), uttale av norske navn, første-byte-latens, pris, datavilkår.
- Realtime-alternativer (tale-til-tale-APIer) sammenlignes som egen kategori, men bindes til samme
  adapterkrav og DPIA.

Etter fire uker: **stop/go-beslutning** for valgt satellitt-maskinvare og leverandør. Full-duplex-arkitekturen
består uansett utfall.

## 8. Feilmodi og fallback

| Feil | Oppførsel |
|---|---|
| Skyleverandør STT/TTS nede eller henger | Hvert leverandørkall har en frist. **Failover sky → lokal** via adapter (kun TTS før første ramme, kun når lokal er tilgjengelig og rutingporten slipper den gjennom; aldri lokal → sky automatisk) - degradert men fungerende. Uten lokal reserve: `stt_error`/`tts_error` for den turen/chunken, neste prøver på nytt. Se runbook §3-§4 |
| Voice Gateway nede | Satellitt faller tilbake til Home Assistant Assist for grunnkommandoer |
| Nett nede på stedet | Lokale hurtigkommandoer og sikkerhetsautomasjoner virker fortsatt (HA, deterministisk) |
| Core nede eller henger | Gateway svarer med `core_error` (nede) eller `core_timeout` (total turfrist 120 s) og avbryter forespørselen; en nektet tilkobling beviser at ingenting nådde Core, så samme `replay_final`-id kan sendes på nytt (en redirect fra Core følges aldri og regnes som ukjent utfall: claimen beholdes); kritiske hjem-funksjoner uberørt. **Køing av turer er ikke bygget** (`NOT_BUILT`) - den tidligere teksten «køer ikke-kritiske turer» stemte ikke med koden |
| Ugyldig ramme, for stor melding, flom (ping/pong, lyd, meldinger), for mange tilkoblinger, langsom eller halvåpen klient | Definert lukking per tilkobling (1007/1002/1009/1008/1013/1000/1006, se runbook §2). **Målt** (ekte prosess): serverens minne forblir flatt under ping- og lydflom, og andre økter er målt uberørt for ping-flom og for tekstflom fra en klient som ikke svarer på close (`/health` ca. 1-2 ms, TTS-strømmen uendret); pong-, binær- og lydflom termineres/lukkes etter samme rammebudsjett, men effekten på andre økter er ikke målt. **Ikke begrenset:** TCP/HTTP FØR WebSocket-oppgraderingen og containerens totale minne (ingen compose-grense) - se runbook §2. Er det fullt, kastes den eldste ikke-beviste tilkoblingen ut (en tilkobling med pågående Core-autorisering og en bevist enhet kastes aldri ut); en bevist enhet kommer inn når bare ubeviste fyller opp (målt 30/30 mot en flom på 100 nye tilkoblinger/s), men churn før `start` og en treg Core kan fortsatt holde eieren ute så lenge angrepet pågår (runbook §2, «Gjenstår») |
| Lokal Piper/Whisper-binær mangler eller kan ikke kjøres | `available()` er `false` -> `/health` 503 (`NOT_CONFIGURED`); en spawn-feil midt i en samtale gir `tts_error`/`stt_error`, ikke krasj |

## 9. Hva Voice Gateway IKKE er

- Ikke en samtalemotor og ikke en minneeier.
- Ikke en Home Assistant-plugin.
- Ikke avhengig av én leverandør: STT, TTS, transport og wake-word er alle utbyttbare bak adaptere.

## 10. Daglig-bruk-overflate (D-212, task #120)

`apps/web/voice.html` er en enkel nettleser-klient - **WebSocket-fallback for enkle klienter** (§3/§4 over
er uendret som målarkitektur for romsatellitter/mobil), servert statisk av Core via `GET /voice` men
snakker DIREKTE med voice-gatewayens EGEN WebSocket-port (§1: egen prosess, aldri en Core-rute). Den
gjenbruker samme Ed25519-enhetsnøkkel/enrollment som `apps/web/dashboard.html` (samme fysiske
enhet/nettleser), fanger mikrofon (PCM16 16 kHz, nedsamplet i klienten) og spiller TTS-rammer (PCM16, samplerate fra `started.tts_sample_rate` - D-390; piper 22 050,
OpenAI 24 000) via en planlagt Web Audio-kø med korrekt barge-in-avbrudd. `infra/local/docker-compose.yml` fikk en
egen `voice-gateway`-tjeneste (samme runtime-image som api/worker, egen `command`).

**Ærlig status (OPPDATERT D-226, 2026-09-22):** klienten og WS-håndtrykket er kode-komplette og
strukturelt testet. Tobias har nå selv gjort den juridiske/eier-verifiseringen av OpenAI som
databehandler (region/databehandleravtale/treningsvilkår/retensjon) - `processor_terms_status` er
`"VERIFIED"` for OpenAI STT/TTS. REELL taledialog via OpenAI er dermed nå TILLATT for alle memory spaces
UNNTATT `health` (D-23, egen, uendret grense - krever alltid en lokal behandler), og kun ved en faktisk
`SERVER_VERIFIED` memory-space-autoritet (D-123 - en klient-oppgitt space gir aldri ekstern tilgang).
`voice.html` viser et gjenværende avslag ærlig i et eget panel i stedet for å late som en generisk feil.

**Lokal STT/TTS (task #125, D-217):** `LocalWhisperStt`/`LocalPiperTts` (`apps/voice-gateway/src/
stt.ts`/`tts.ts`) er ikke lenger stubs - subprosess-/strømme-/kanselleringskoden er EKTE og testet mot
en faket binær (`test/local-{whisper,piper}-*.test.ts`), og begge er wiret inn som NESTE
fallback-tier i `main.ts` (etter OpenAI, FØR den deterministiske test-adapteren). RÅ lyd forlater
prosessen KUN via pipe til den lokale binæren, ALDRI via disk (§22-invarianten, statisk håndhevet av
`test/d30-foundation.test.ts`). `available()` forblir likevel `false` - og `health`-tale forblir derfor
faktisk utilgjengelig i praksis - inntil Tobias selv installerer whisper.cpp/piper-binærene/modellene og
setter `JARVIS_WHISPER_BIN`/`JARVIS_WHISPER_MODEL`/`JARVIS_PIPER_BIN`/`JARVIS_PIPER_MODEL` (Q-32 punkt
3, uendret eier-avhengighet). De eksakte CLI-flaggene (`-f -` for whisper.cpp-stdin, `--output_raw` for
piper) er whisper.cpp/pipers LANGVARIG DOKUMENTERTE, mest utbredte konvensjoner, men ALDRI kjørt mot en
ekte installert binær i denne økten - UVERIFISERT, eksplisitt disclosed (D-41), ikke stille antatt.
- Ikke bygget for mange rom i første versjon: én satellitt vertikalt først, deretter skalering.
