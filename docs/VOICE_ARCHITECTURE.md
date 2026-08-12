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
- Ikke bygget for mange rom i første versjon: én satellitt vertikalt først, deretter skalering.
