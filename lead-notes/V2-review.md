TS: 2026-11-26T13:20:32.716Z
VERDICT: MERGE ETTER FIKSER. 1 HIGH, 2 MEDIUM og noen LOW. Krasjvern, validering, idempotens og personvern holder under mine prober. K2 (flom og tilgjengelighet) er ikke ferdig slik byggeren påstår.

## (1) K1–K9 med bevis
Prober ligger i `/tmp/lead/V2-review-probes/` (p1–p14, `mut/`).
- **K1 ferdig.** `p1` mot ekte `main.ts`: 33/33 angrep, prosessen levde og `/health` svarte 200.
  - Angrepene var ugyldig UTF-8 (1007), reservert opcode (1002), 70 KB, fragmentert og 4 GiB-header (1009), brå TCP-reset, `clientError`-varianter og 54 KB dypt JSON. Ingen uncaught i loggen.
  - `p2` (Piper): manglende binær gir exit 1 uten sti. Dårlig shebang gir `tts_error`, samtidig sesjon upåvirket, `/health` 503 etter 3 feil. Hengende Piper gir stall på 15 s, slots 0 og ingen rester. `p14`: `EADDRINUSE` gir exit 1.
- **K2 DELVIS.** 500 samtidige tilkoblinger: 4 aktive, RSS +7 MB, `/health` 2–5 ms, ingen fd-lekkasje. Whisper-slots frigjøres ved suksess, feil og frakobling (`p9`). Se F1–F3 for hullene.
- **K3 ferdig.** `p13`: 30/31, den ene var min egen probefeil (`AAA=` er 2 byte). Ingen Core-kall for noen ugyldig melding. Feil `start` river ikke ned eksisterende sesjon. `start` er lukket per tilkobling, så en annen tilkobling kan ikke avbryte eierens sesjon.
- **K4 ferdig.** Se (3) for personvern. `p14`: `core_timeout` etter ~400 ms og forespørselen avbrytes faktisk hos Core. Barge-in gir `AbortError`, ikke `core_timeout`. Ubevist klient får `voice_session_required` før noe HTTP-kall.
- **K5 ferdig, restart PARTIAL (ærlig dokumentert).** Se (4).
- **K6a DEFERRED, ærlig.** **K6b ferdig:** env > modellfil > 22 050 verifisert i ekte `main.ts`. Ugyldig modellrate, tom env og søppel-env faller riktig tilbake.
- **K7 ferdig (kodelesing, mutanter).** Ingen ny `innerHTML` med fjerndata. `techLog` bruker `textContent`, og den eksisterende `escapeHtml` er uendret. CSP er uendret (nonce, `apps/api` urørt).
- **K8 ferdig.** `p8`: 14 inndatatyper × 3 push-størrelser på 200 KB, alle ≤ 51 ms og maks 4000 tegn. Ingen løse surrogater. Norske eksempler OK, men se F8.
- **K9 delvis.** Se (7).

## (2) Funn
- **F1 HIGH: kontrollramme-flom (ping).**
  - `server.ts:438-445`: ingen `ws.on("ping")`, og `ws` svarer automatisk med pong uten grense.
  - `p5`: én ubevist klient som ikke leser sender 4,6 M pings (604 MB) på 10 s. Serverens RSS går fra 105 MB til 2,1 GB, prosessen lever og tilkoblingen lukkes ikke.
  - Med lesende klient (`p10`): `/health` p50 går fra 2 til 121 ms, og en legitim TTS-strøm faller fra 151 til 58 rammer. «Andre økter uberørt» stemmer ikke.
  - Compose har ingen minnegrense. Feilen finnes også på base (ifølge kodelesing, ikke kjørt mot base), men K2 og runbook §2 påstår «aldri et krasj».
  - Fiks, bevist som midlertidig mutant (gjenopprettet): `ws.on("ping", ...)` med `TokenBucket(2,10)` og `ws.bufferedAmount > limits.maxBufferedBytes` gir `ws.terminate()`. Resultat: RSS flat 107 MB, tilkoblingen lukkes etter ~32k pings, `/health` 2 ms, TTS 160 rammer. Legg til test i `wpv2-k2`.
- **F2 MEDIUM: «peer» kollapser og eier kan utarmes.**
  - `limits.ts:117-128` og `server.ts:448-459`. Compose publiserer `127.0.0.1:3020` (`docker-compose.yml:~770`), så containeren ser bridge-IP. Da er peeren ikke loopback og `X-Forwarded-For` ignoreres.
  - `p3` via ikke-loopback (192.0.2.2): 5. og 6. tilkobling avvises uansett XFF. En «eier» med annen XFF får `voice_busy` mens 4 ubeviste hviler.
  - Ubeviste sesjoner er fullverdige: de lever ≤ 30 min, holdes oppe av enhver melding, og kan reconnecte straks. Byggeren dokumenterer forbeholdet, men det er ikke mitigert.
  - Fiks: egen lavere grense for ubeviste per peer (f.eks. 2), en `start`-frist på 10 s (`start_timeout`) og/eller utkasting av eldste ubeviste når det er fullt.
- **F3 MEDIUM: ubegrenset lydbuffer per tur.**
  - `maxAudioFrameBytes` 16 KiB × 100 rammer/s gir 1,6 MB/s, mot 32 KB/s ved legitim bruk.
  - `p4`: +2,2 MB/s per tilkobling. Med 4 tilkoblinger går RSS fra 106 til 202 MB på 12 s. Taket er kun VAD `maxTurnMs` 30 s, altså ~50 MB per tur, og `Buffer.concat`/WAV tredobler det forbigående. `turnChain`/`ttsQueue` er uten tak.
  - Fiks: byte-rate-bøtte (f.eks. 64 KiB/s, burst 512 KiB) eller `maxTurnBytes` (~2 MiB) i `VoiceSession.pushAudio`.
- **F4 LOW:** semaforene (whisper 2/piper 4) er globale. `p2`: 6 klienter gir 4 slots og 2 `voice_busy`. En ubevist klient kan sulte eierens STT. Fiks: reserver ett slot for bevist, eller rettferdig kø per peer.
- **F5 LOW:** etter `core_error` (f.eks. ECONNREFUSED) regnes turen som utført, og `replay_final` nektes. Trygt mot dobbel-ACT, men kommandoen er tapt. Kun `voice_session_required` frigir claim.
- **F6 LOW, testhull:** 9 mutanter overlever, se (5).
- **F7 INFO:** `available()` gjør synkron `statSync`/`accessSync` ved hvert kall (`/health` og hver TTS-chunk via `usableReserve`), som kan fryse event-loopen ved hengende nettmontering. Foreslår 5 s cache.
- **F8 LOW:** «den 1. mai» kuttes etter «1.» (`p8`), en prosodifeil utenfor K8-listen.
- **F9 INFO:**
  - Pre-upgrade HTTP/TCP er ubegrenset.
  - Avviste WebSocket-sockets henger ≥ 14 s (326 fd målt, ws-timer 30 s).
  - `cancel()` frigir Piper-slot før prosessen er død, og det finnes et mikro-vindu i `runOnce` mellom `acquire` og `releaseSlot`.
  - `Pcm16Resampler(0, x)` ville loopet, men raten er validert til 8k–96k, så det er ikke nåbart.

## (3) Personvern og failover
- `p7`: 7 memory spaces × {ubevist, bevist} × {primær ok, primær feiler} ga 0 brudd. Ekstern STT/TTS får aldri tekst eller lyd når `evaluateSpeechRouting` nekter.
- Reserven brukes aldri som omvei for nektet primær. `health` og SECRET_RESTRICTED gir all tale nektet (fail-closed, uendret fra base).
- `FailoverTts`/`FailoverStt` avviser ekstern reserve ved konstruksjon, og mutant M48/M49 ble drept. `selectSpeechAdapters` er uendret.
- Loggene har kun koder. Nye `process.env`-lesinger: kun `PATH`, og `JARVIS_PIPER_SAMPLE_RATE` som allerede lå i compose.
- Én svakhet: testen `errorCode`-hygiene mangler (M56).

## (4) Idempotens
- Ekte `HttpCoreClient` mot HTTP-stub (`p6b` 6/6):
  - Samme id på samme og på ny tilkobling gir 1 `/chat`.
  - 4 samtidige tilkoblinger gir nøyaktig 1 kall; resten får `utterance_in_flight`.
  - Kryss-tenant og kryss-enhet blokkerer ikke hverandre.
  - En ubevist forhåndsclaim blokkerer ikke den beviste.
  - `/chat`-kroppen er kun `grant_token` og `message`.
- TTL og kapasitet: etter completed-TTL (1 time) og LRU-utkasting (10 000) kan samme id utføres på nytt. Det er dokumentert vindu og `evicted_for_capacity` vises i `/status`. Restart-konsekvensen er ærlig beskrevet i runbook §5.

## (5) Mutanter
- 83 egne mutanter (`mut/mutants.py`): 74 drept, 9 overlevde. Byggerens «65/65» er altså ikke reprodusert på mitt sett.
- Overlevende, vurdert:
  - M24 (konstant tenant i sesjonens journalnøkkel): reelt hull, dreper `p6b`.
  - M66 (whisper `release()` fjernet): reelt hull, `p9` viser slots stuck på 2.
  - M56 (`errorCode` slipper tekst gjennom): reelt hull i logghygiene.
  - M73 (X_OK-sjekk fjernet), M19 (`isCompleted` uten TTL), M32 (`wss` error-handler), M33 (`clientError`-logging), M46 (sesjon for død socket): alle drept av `p12`.
  - M38 (`>=` mot `>` på køgrensen 256): ekvivalent.

## (6) Regresjon
Alt kjørt som `postgres`, maks 2 arbeidere:
- `apps/voice-gateway/test` uten e2e: 32 filer / 431 tester OK.
- `voice-e2e`: 6/6.
- `apps/api` statiske tester pluss `d212`, `d253`, `d396*`, `d398-*`, `wpj-closure-matrix` og `check-containment`: 15 filer / 145 tester OK.
- `remediation-2-compose-isolation`: 40/40.
- `tsc` på voice-gateway: OK. `eslint apps/voice-gateway`: exit 0. `check-containment`: OK.
- Gitleaks `origin/main..HEAD`: 1 funn, `97b8b758`, linje 118, fingeravtrykk som oppgitt. Verdien dekoder til «the sample nonce», RFC 6455-eksempelet, altså falsk positiv. Ingen andre funn, og diffen har ingen hemmelighetslignende strenger.
- Worktreen er ren og det er ingen restprosesser.

## (7) Docs mot kode
- Runbook §2 «aldri et krasj» motsies av F1.
- Tallene i §2/§3/§4 stemmer med koden.
- Runbook §6 og Q-B: Piper-utgaven kan besvares fra `voice-gateway.Dockerfile:121-123`. Imaget bruker `rhasspy/piper 2023.11.14-2` med `.onnx.json`, så understrek-flaggene er riktige for imaget. UVERIFISERT gjelder da kun en annen installasjon.
- `VOICE_ARCHITECTURE.md` §4/§8/§10 stemmer med koden. Ledger 098/080/079 er konsistent med byggerens beskrivelse (ledgeren er ikke i diffen).

## (8) Ikke verifisert
- Faktisk Docker-topologi med Tailscale Serve: hvilken peer-adresse og om XFF finnes (F2 er modellert via ikke-loopback-IP).
- F1 er ikke kjørt mot base-koden, bare kodelest.
- Ekte Piper/Whisper/mikrofon/NAS/OpenAI. Failover er kun testet med stubber.
- Standardtidene (idle 120 s, ping 30 s, max 30 min) er ikke kjørt i sanntid. De er dekket av byggerens tester med små grenser (M37 drept).
- Kapasitet på NAS.
