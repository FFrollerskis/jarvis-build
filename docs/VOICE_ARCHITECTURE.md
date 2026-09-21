# Jarvis – talearkitektur (Voice Gateway)

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
- **Gjenopptak:** gateway-tilstand (aktiv sesjon, spillekø, siste tur) checkpointes slik at en restart eller
  lokal/sky-failover gjenopptar samtalen. Verktøyhandlinger er idempotente med engangs-ID-er slik at
  failover aldri dobbelutfører en handling.
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
| Skyleverandør STT/TTS nede | Bytt til reserveleverandør/lokal modell via adapter; degradert men fungerende |
| Voice Gateway nede | Satellitt faller tilbake til Home Assistant Assist for grunnkommandoer |
| Nett nede på stedet | Lokale hurtigkommandoer og sikkerhetsautomasjoner virker fortsatt (HA, deterministisk) |
| Core nede | Gateway svarer med feilmelding og køer ikke-kritiske turer; kritiske hjem-funksjoner uberørt |

## 9. Hva Voice Gateway IKKE er

- Ikke en samtalemotor og ikke en minneeier.
- Ikke en Home Assistant-plugin.
- Ikke avhengig av én leverandør: STT, TTS, transport og wake-word er alle utbyttbare bak adaptere.

## 10. Daglig-bruk-overflate (D-212, task #120)

`apps/web/voice.html` er en enkel nettleser-klient - **WebSocket-fallback for enkle klienter** (§3/§4 over
er uendret som målarkitektur for romsatellitter/mobil), servert statisk av Core via `GET /voice` men
snakker DIREKTE med voice-gatewayens EGEN WebSocket-port (§1: egen prosess, aldri en Core-rute). Den
gjenbruker samme Ed25519-enhetsnøkkel/enrollment som `apps/web/dashboard.html` (samme fysiske
enhet/nettleser), fanger mikrofon (PCM16 16 kHz, nedsamplet i klienten) og spiller TTS-rammer (PCM16 24
kHz) via en planlagt Web Audio-kø med korrekt barge-in-avbrudd. `infra/local/docker-compose.yml` fikk en
egen `voice-gateway`-tjeneste (samme runtime-image som api/worker, egen `command`).

**Ærlig status:** klienten og WS-håndtrykket er kode-komplette og strukturelt testet. REELL taledialog
via OpenAI STT/TTS forblir policy-blokkert av `evaluateSpeechRouting()` (§6, Q-32 punkt 1 i
`docs/OPEN_QUESTIONS.md`) helt til Tobias selv har gjort den juridiske/eier-verifiseringen av OpenAI som
databehandler - `processor_terms_status` er hardkodet `"NOT_VERIFIED"` og skal ALDRI settes av
Jarvis/Claude selv. `voice.html` viser dette avslaget ærlig i et eget panel i stedet for å late som en
generisk feil.

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
