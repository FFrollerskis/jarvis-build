# WP-V2: Voice Gateway-robusthet (runbook)

**Status:** koden er bygget og testet lokalt (se «Bevis»), men alt som krever ekte mikrofon, ekte Piper/Whisper, NAS eller ekte skytilgang er
**NOT VERIFIED** (egne steg i §8). Beslutnings-id: D-488 (forslag; lead fører den i beslutningsloggen). Funn: JARVIS-063 (voice-delen), 079, 080, 098 og
Piper-`spawn` (audit 08 A1-A3, C4, D1). Omfang: `apps/voice-gateway/**` og `apps/web/voice.html`. Ingen migrasjon, ingen Core-endring, **ingen nye
miljøflagg** (alle grenser er konstanter i `apps/voice-gateway/src/limits.ts`; tester overstyrer via `VoiceGatewayOptions.limits`).

Statusord: `WIRED` = koblet i `main.ts` og aktiv som standard · `PARTIAL` · `DEFERRED` · `NOT VERIFIED` (aldri «verifisert» uten kjørt artefakt).

## 1. Hva som er endret (kort)

| Krav | Status | Hvor |
|---|---|---|
| K1 krasjvern (ws-feil, clientError, Piper `error`, `available()`) | `WIRED` | `server.ts`, `tts.ts`, `stt.ts`, `local-binary.ts` |
| K2 kapasitet og rate limit | `WIRED` | `limits.ts`, `server.ts` |
| K3 meldingsvalidering, ny `start` stopper forrige sesjon | `WIRED` | `server.ts` |
| K4 frister overalt, ekte `cancel()`, failover sky→lokal | frister `WIRED`; failover `WIRED` KUN når valgt adapter er ekstern og lokal reserve er tilgjengelig (ellers uendret) | `deadline.ts`, `failover.ts`, `main.ts` |
| K5 prosess-delt, atomisk, begrenset utterance-journal | `WIRED`; varighet over omstart `PARTIAL` (§5) | `journal.ts`, `session.ts`, `main.ts` |
| K6a varig Piper-prosess | `DEFERRED` (§6) | - |
| K6b samplerate fra stemmens `.onnx.json` | `WIRED` | `tts.ts` |
| K7 `voice.html` (ringbuffer-logg, teller, throttling, teardown) | `WIRED` | `apps/web/voice.html` |
| K8 chunker (hard maks, klokkeslett, forkortelser, lineær tid) | `WIRED` | `chunker.ts` |

## 2. Grenser (K2) og begrunnelse

Alle tall er konstanter i `DEFAULT_VOICE_LIMITS`. En grense som brytes gir en definert feilkode/lukking, aldri et krasj, og påvirker aldri andre tilkoblinger.
`/status` viser gjeldende grenser (`limits`), antall tilkoblinger (`connections.active`) og journalstørrelse (`journal.entries`).

| Grense | Verdi | Brudd gir | Begrunnelse |
|---|---|---|---|
| `maxPayloadBytes` (ws) | 64 KiB | ws lukker med **1009**; ingen melding når koden | `ws`-standarden er 100 MiB. Nettleserens 64 ms-ramme (1 024 sample = 2 048 byte) er ca. 2,8 KB som base64 i JSON; 20 ms-satellitt ca. 0,9 KB; `replay_final` (maks 4 000 tegn) ca. 4-16 KB. 64 KiB gir > 20x margin. |
| `maxAudioFrameBytes` (dekodet) | 16 KiB | `{"type":"error","error":"malformed_message"}`, tilkoblingen lever | 16 KiB = 512 ms @16 kHz PCM16 = 8x nettleserramma. Må også være partall byte (PCM16). |
| `maxConnections` / `maxConnectionsPerPeer` | 16 / 4 | ny tilkobling får `{"type":"error","error":"voice_busy"}` og close **1013** | Én eier: noen faner, mobil, få satellitter. 4 per peer = fire faner fra samme maskin. Peer = TCP-adresse; `X-Forwarded-For` (siste element) kun når selve peeren er loopback (speiler `clientKey` i `apps/api/src/http-guard.ts`, ikke importert). |
| `audioFramesPerSecond` / `audioBurst` | 100 / 200 | `{"type":"error","error":"rate_limited"}` og close **1008** | Nettleser ca. 16 rammer/s, 20 ms-satellitt 50/s => 2x margin; burst 200 = to sekunder opphopning når en fane har stått stille. |
| `controlPerSecond` / `controlBurst` | 5 / 20 | `rate_limited`, close 1008 | `start`, `voice_sample`, `replay_final`, `voice_settings`, ugyldig JSON: billige å sende, men dyre å utføre (Core-autorisasjon, TTS-kost). Klienten debouncer `voice_settings` på 250 ms (maks 4/s). |
| `maxQueuedMessages` | 256 | `overloaded`, close 1008 | Meldinger behandles i én serialisert kjede; mens `start` venter på Core (maks 10 s) hoper de seg opp: 256 > 10 s x 16 rammer/s. |
| `idleTimeoutMs` | 120 s | close **1000** `idle_timeout` | `voice.html` sender rammer hele tiden (også dempet, som stillhet). 120 s uten NOE er en død/frosset fane, og frigjør plassen. Pong teller ikke som aktivitet (ellers kunne en stille tilkobling holde plassen evig). |
| `maxUnprovenSessionMs` | 30 min | close 1000 `max_duration` | Ubevist sti (ingen grant) har ingen utløpstid (audit C4). Bevist sti har grant-levetiden (15 min, sjekkes ved bruk) og omfattes ikke. |
| `pingIntervalMs` | 30 s | tilkoblingen termineres (**1006**) hvis forrige ping ikke fikk pong | Typiske proxy/NAT-tidsavbrudd er 60 s; fanger halvåpne tilkoblinger. |
| `maxBufferedBytes` (`ws.bufferedAmount`) | 1 MiB | TTS avbrytes, close **1013** `slow_consumer` | 1 MiB ≈ 24 s lyd (base64-inflatert 32 KB/s). En klient som henger så langt etter kan ikke føre en samtale. |
| `maxConcurrentWhisper` / `maxConcurrentPiper` | 2 / 4 | `voice_busy` (STT/TTS) etter køfrist `processQueueTimeoutMs` = 8 s | Whisper er CPU-tung (NAS); piper er lett, men en sesjon bruker to samtidig (gjeldende + forhåndshentet chunk, D-390). Egne semaforer så whisper ikke sulter ut piper. |
| `replay_final` | id maks 128 tegn (`[A-Za-z0-9._:-]`), tekst maks 4 000 | `malformed_message` | En ytring på 30 s er ca. 600 tegn. |

**Per-peer-grensen og NAT:** «peer» er TCP-adressen gatewayen ser. Når Docker-NAT eller en loopback-proxy uten `X-Forwarded-For` gjør at ALLE klienter ser ut som samme adresse (f.eks. docker-proxy/bridge-gateway), gjelder grensen på 4 dem samlet - da er 4 samtidige tilkoblinger taket, og den 5. får `voice_busy`. Sjekk i §8 punkt 4 hvilken adresse klientene faktisk får hos deg; grensene er konstanter i `limits.ts` (ingen miljøflagg, med vilje) og kan heves i koden hvis det viser seg for stramt.

**Ikke endret:** `/health` (503 når STT/TTS er `NOT_CONFIGURED`/`UNAVAILABLE`), `/status`-formatet (kun utvidet), `authorizeVoiceSession` (10 s frist fantes).

## 3. Frister (K4)

Ingen leverandørkall og ingen ledd i den serielle kjeden skal kunne henge uten øvre grense. Kodene under er det som havner i logg/`health` (aldri leverandørtekst).

| Kall | Frist | Kode ved brudd |
|---|---|---|
| OpenAI STT / Deepgram batch | 20 s totalt (`AbortSignal`) | `openai_stt_timeout` / `deepgram_stt_timeout` |
| OpenAI TTS / ElevenLabs TTS (per chunk) | 30 s totalt, **også mens kroppen strømmer** | `openai_tts_timeout` / `elevenlabs_tts_timeout` |
| `cancel()` (barge-in) på OpenAI/ElevenLabs | aborterer selve `fetch` (`AbortController`), ikke bare et flagg | (ingen feil) |
| Lokal whisper-prosess | 60 s, hele prosessgruppen drepes | `local_whisper_timeout` |
| Piper per chunk | 60 s, hele prosessgruppen drepes (SIGKILL; SIGTERM + opptrapping ved vanlig cancel) | `local_piper_timeout` |
| `HttpCoreClient.chat`/`chatStream` | 120 s TOTALT per tur; aborterer forespørselen. Barge-in er fortsatt et rent `AbortError` | `core_timeout` (klienten ser `core_timeout`) |
| Sesjon: `stt.end()` | 60 s | `stt_end_timeout` -> `stt_error` |
| Sesjon: hver TTS-chunk i `ttsWorker`-kjeden | 15 s uten ny ramme, 60 s totalt; chunken avbrytes aktivt og **hoppes over** (`tts_error`), neste chunk tas | `tts_stall_timeout` / `tts_chunk_timeout` |

Piper-/whisper-prosesser startes `detached` (egen prosessgruppe) slik at fristen kan drepe hele treet - en wrapper med barneprosesser som arver stdout holdt ellers `close`-hendelsen åpen.

## 4. Failover sky -> lokal (K4, v2.1 §14)

Komponeres i `main.ts` ETTER `selectSpeechAdapters` (uendret): når den valgte adapteren er **ekstern** og den lokale (whisper/piper) er `available()`.
Uten lokal reserve, eller når lokal allerede er valgt, skjer det ingenting nytt.

1. **Kun sky -> lokal.** En reserve som ikke er lokal avvises ved konstruksjon (`failover_reserve_must_be_local`). Lokal -> sky skjer aldri automatisk.
2. **TTS: kun før første ramme.** Feiler primæren etter at en ramme er levert, gjentas ikke setningen med en annen stemme (ingen dobbel tale); chunken gir `tts_error` og neste chunk prøver primæren igjen.
3. **Hengende primær:** uten første ramme innen 6 s (`primaryFirstFrameTimeoutMs`) avbrytes primæren og reserven tar over. STT: 10 s på `end()`.
4. **Rutingporten:** reserven brukes bare hvis `evaluateSpeechRouting` slipper den gjennom for sesjonens memory space og tillitsnivå (sesjonen gir konteksten som siste argument til adapteren). Lokal er alltid tillatt (D-122 regel 1), men porten kjøres likevel. Uten sesjonskontekst tillates kun en lokal reserve. Hvis PRIMÆRENS behandler avslås av rutingporten er det ikke en feil - sesjonen avviser all tale (`speech_routing_denied_*`) og reserven brukes aldri som omvei.
5. **Cooldown:** etter en primærfeil hoppes primæren over i 30 s (ellers ventet hver chunk på primærens frist). Etter cooldown prøves den igjen.
6. **Samplerate:** reservens rate (piper 22 050 Hz) resamples (lineært) til primærens (OpenAI 24 000 Hz) - klienten får én rate per sesjon (`started.tts_sample_rate`).
7. **Logging/helse:** `{"msg":"tts_failover"|"stt_failover","from":…,"to":…,"reason":<kode>}` (kun koder). `health` skiller `tts_primary`/`tts_reserve`/`stt_primary`/`stt_reserve`; sesjonens `tts`/`stt` (som styrer `/health`) lever så lenge ÉN av dem virker. `/status` viser `tts.failover` (`failovers`, `last_reason`, `primary_in_cooldown`, komponentstatistikk).
8. **Barge-in under failover:** `cancel()` stopper primæren, hindrer at reserven starter, og stopper en pågående reserve.

Eksisterende `RemoteWhisperStt` (D-403) har sin egen lokale fallback og er uendret.

## 5. Utterance-journal (K5) og grensen

* **ÉN journal per prosess** (opprettes i `main.ts`; standard i `createVoiceGateway` er også delt, ikke per sesjon som før). Nøkkel = (tillitsnivå, tenant, enhet, utterance_id) - en ubevist klient (`CLIENT_ASSERTED`) kan aldri forhåndsclaime en bevist enhets id-er.
* **Atomisk `claim` FØR Core-kallet:** to samtidige `replay_final` for samme id (også fra to tilkoblinger) = ÉTT Core-kall; den andre får `utterance_in_flight:<id>` eller `utterance_already_completed:<id>`.
* **Utfall:** etter claim regnes turen som utført i alle utfall (også Core-feil og barge-in: Core kan ha kjørt verktøy) - en replay avvises. Unntak: `voice_session_required` (ingen forespørsel sendt, ubevist sti) frigir claimen.
* **Begrenset:** LRU 10 000 nøkler; fullført huskes 1 time, påbegynt claim 10 min. Kapasitet kaster eldste FULLFØRTE først (en pågående claim vernes). `journal.evicted_for_capacity` (antall kastet pga. kapasitet) og `journal.entries` vises i `/status`.
* **Unike id-er:** sesjonens id-prefiks er `randomUUID()` (var `Date.now()` i ms - to faner fra samme enhet i samme millisekund fikk samme prefiks).

**`PARTIAL` (må leses):** journalen ligger i prosessminnet. Den overlever IKKE en omstart og deles IKKE mellom to gateway-prosesser; en `replay_final` etter omstart eller mot en annen gateway kan derfor utføres på nytt. Varig deling krever en Core-rute og en migrasjon (egen WP; forslag til Q-tekst i rapporten). Delvis dekning i mellomtiden: ToolGateway-ledgerens idempotensnøkkel (`toolCallIdempotencyKey`, `modules/model-gateway/src/model-gateway.ts`, 10 minutters tidsvindu) hindrer at samme verktøykall utføres to ganger innenfor vinduet - men ikke etter 10 minutter, og ikke for verktøy uten nøkkel. `SttStream` har ingen `cancel()`; Deepgram-streaming er ikke koblet i `main.ts` - `DEFERRED`.

## 6. Piper (K6)

**Funn fra offisiell dokumentasjon (lest 2026-11-26 via WebFetch, oppsummert av et lite modellsteg - eier bør bekrefte; ikke kjørt mot en ekte installasjon):**
`rhasspy/piper` er arkivert («Development has moved» -> `OHF-Voice/piper1-gpl`). Der: `docs/CLI.md` sier at **CLI-en laster modellen på nytt for hver kjøring** og anbefaler HTTP-serveren for gjentatt bruk; flaggene er skrevet med **bindestrek** (`--output-raw`, `--sentence-silence`, `-m`, `-f`). Adapteren bruker **understrek** (`--output_raw`, `--model`, `--length_scale`, `--sentence_silence`) - stavemåten fra den arkiverte C++-binæren. Hvilken som stemmer avhenger av hvilken Piper-utgave som er installert: **UVERIFISERT** (D-41). Adapterens retry-uten-ekstra-flagg (D-405) dekker bare stemmeflaggene, ikke `--output_raw`/`--model`.
`src/piper/config.py` leser `config["audio"]["sample_rate"]`; `src/piper/voice.py` finner konfigfilen som `f"{model_path}.json"` (dvs. `<modell>.onnx.json`).

* **K6b (gjort):** samplerate = `JARVIS_PIPER_SAMPLE_RATE` (hvis gyldig) > `audio.sample_rate` i `<modell>.onnx.json` > 22 050. Kun et heltall 8 000-96 000 Hz godtas. Kilden (`env`/`model_config`/`default`) vises i `/status` (`tts.sample_rate_source`) og i oppstartslinjen `jarvis-voice-gateway piper_config`; et avvik mellom env og modellfil logges (`piper_sample_rate_mismatch`).
* **K6a `DEFERRED` - varig Piper-prosess:** å mate flere setninger gjennom én prosess krever at grensen mellom ytringene i rå utdata kan påvises. Dokumentasjonen beskriver ingen markør i `--output-raw`, og dagens stdin/stdout-kontrakt gir ingen måte å vite hvor setning N slutter (nødvendig for barge-in, per-chunk-frist og tilstandsmaskinen). Jeg har ikke gjettet. Forhåndshentingen (D-390) dekker allerede alt unntatt første chunk i hvert svar. Alternativ som dokumentasjonen selv anbefaler: Pipers HTTP-server (`python3 -m piper.http_server -m <stemme>`, `POST /synthesize` med JSON `{text, …}` -> WAV; om modellen holdes lastet og om svaret strømmes er «NOT STATED») - en egen driftskomponent og en annen adapterform (WAV per forespørsel), altså en eierbeslutning, ikke bygget her.
  **Eier kjører (NOT VERIFIED):** (1) `piper --help` på den installerte binæren: noter stavemåten av `--output_raw`/`--output-raw` og stemmeflaggene; (2) `printf 'Hei.\nOk.\n' | piper -m <modell> --output_raw | wc -c` mot summen av to enkeltkjøringer: er den lik, finnes ingen markør; (3) tid for én kald kjøring (`time`) på NAS - bestemmer om første-chunk-kostnaden er et reelt problem.
* **Spawn-feil (A1, gjort):** `proc.once("error")` -> `local_piper_spawn_failed:<kode>` (kastes fra `frames`, fanges i `speakNext` -> `tts_error` + `health.recordFailure`); stdout-feil -> `local_piper_stdout_failed:<kode>`; `available()` sjekker binær (kjørbar fil, også via PATH) og lesbar modell, så feil konfig gir `NOT_CONFIGURED`/503 i `/health` og en kort `unavailable_reason` i `/status` (`binary_not_executable`, `model_not_readable`, `not_configured`) - aldri en sti.

## 7. voice.html og tekst (K7, K8)

* Teknisk logg = ringbuffer (200 linjer x 400 tegn), nyeste øverst, DOM-oppdatering høyst ca. 4/s. `tts_frame` vises som én sammenslått linje «tts_frame ×N (≈ byte)» - aldri base64.
* `stopConversation` lukker `AudioContext`; oddetall-lengde og ugyldig base64 `tts_frame` forkastes kontrollert (teller i loggen); etter `tts_cancelled` spilles ingenting før serveren melder en ny `speaking`-tilstand.
* `SentenceChunker`: hard maks 4 000 tegn (OpenAI TTS 4 096), kutt på kodepunktgrense; «klokka 14:30», «18.30», «f.eks.», «kl. 14», «ca. 5», «bl.a.», adresser og e-post kuttes ikke midt i (da gikk `normalizeForNorwegianSpeech` glipp av dem); et tegn som kan bli et tall/en forkortelse på slutten av bufferen holdes til neste token (maks ett token, `flush()` sender alltid alt); en vanlig setningsslutt sendes umiddelbart. Skanningen er inkrementell: 200 KB uten grenser er lineær tid (var kvadratisk).

## 8. Eierens `NOT VERIFIED`-steg

Alt under er IKKE kjørt av bygger (ingen ekte mikrofon, NAS, Piper/Whisper eller skytilgang i sandkassen).

1. **Ekte mikrofon via `voice.html`:** åpne `/voice`, start samtale, snakk og avbryt Jarvis midt i et svar. Sjekk: «Teknisk logg» har maks 200 linjer og én «tts_frame ×N»-linje; stopp og start samtale 10 ganger uten advarsel om for mange AudioContext; etter barge-in høres ingen rest av gammelt svar. Sjekk også at en dempet fane (stillhet sendes fortsatt) ikke lukkes av `idle_timeout`.
2. **Ekte Piper/Whisper på NAS:** sett `JARVIS_PIPER_*`/`JARVIS_WHISPER_*`, start, og les `docker compose logs voice-gateway | grep piper_config` samt `curl http://<nas>:3020/status` (`tts.sample_rate_source`, `unavailable_reason`). Gjør §6-punktene. Prøv en feil sti med vilje: `/health` skal bli 503, prosessen skal ikke krasje.
3. **Failover ved å kutte skytilgang:** konfigurer OpenAI-nøkkel OG lokale binærer. Sett midlertidig en ugyldig nøkkel (gir 401) eller blokker `api.openai.com` brannmurmessig, og snakk. Forventet: svar høres med lokal stemme (riktig tonehøyde - resamplet), `docker compose logs voice-gateway | grep -E 'tts_failover|stt_failover'` viser `reason`-koder (ingen tekst), `/status` `tts.failover.failovers` > 0, og barge-in virker under lokal avspilling. Fjern feilen: etter 30 s prøves skyen igjen. Sjekk at `health`-memory-space aldri sender tekst til sky (D-23).
4. **Kapasitetstest:** fra en annen maskin: åpne 5 WebSocket-tilkoblinger fra samme adresse (`websocat`/Node) - den 5. skal avvises med close 1013 `voice_busy`; send 300 `audio`-meldinger på 1 s - tilkoblingen skal lukkes med 1008 `rate_limited` uten at en annen fane merker det; la en tilkobling stå uten trafikk i 125 s - close 1000 `idle_timeout`.
5. **Journalgrensen (PARTIAL):** utfør et verktøykall via tale, restart gateway-containeren og send samme `replay_final` på nytt - forvent at journalen er tom (kan utføres igjen); bekreft hvor mye ToolGateway-ledgeren dekker.

## 9. Bevis (kjørt av bygger)

`apps/voice-gateway/test/wpv2-*.test.ts` (ekte `main.ts`-prosess: `wpv2-main-process`; K1: `wpv2-k1-crash-protection`, K2: `wpv2-k2-capacity`, K3: `wpv2-k3-validation`, K4: `wpv2-k4-deadlines` og `wpv2-k4-failover`, K5: `wpv2-k5-journal`, K6b: `wpv2-k6-piper-samplerate`, K7: `wpv2-k7-voice-page` (kjører sidens funksjoner i `node:vm`), K8: `wpv2-k8-chunker`) pluss eksisterende `apps/voice-gateway/test/**`, `voice-e2e` (ekte Core + Postgres) og `apps/api/test/{voice-page-wiring,d252-*,remediation-2-static-pages}.test.ts`. Rød-først mot `main` (71a31d8b) er dokumentert i sluttrapporten.
