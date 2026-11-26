TS: 2026-11-26T14:51:28.871Z
**Sluttrapport fiks-runde 1 (WP-V2)**

Alle ni fikser er gjort. Én del av F9 er DEFERRED: tilkoblinger før WebSocket-oppgraderingen er fortsatt ubegrenset. Branchen `claude/wp-v2-voice-robustness` ligger i synk med origin på ny tipp **`61d40652`**. Alle endringer ligger i `apps/voice-gateway/**` og de to docs-filene (runbook og `VOICE_ARCHITECTURE.md`). Jeg har ikke rørt delte docs, `.gitleaksignore`, `apps/api`/core eller compose. Det er ingen nye pakker, flagg eller migrasjoner.

**Per fiks**
- **FIX-1 ferdig.** `autoPong:false`, og ping besvares manuelt bak `TokenBucket(2/s, 10)`. En ubedt pong teller i samme bøtte, og en pong som svarer på serverens egen ping er gratis. Brudd gir `terminate()` med én loggline. Kode: `server.ts`, `limits.ts`.
  - Test: `wpv2-k2-capacity` «FIX-1» (6 tester, 3 røde først).
  - Probe `p5` mot ekte `main.ts`: RSS flat 107 MB, tilkoblingen lukket. Probe `p10`: `/health` p50 1 ms, TTS 160 rammer.
  - Jeg utelot `bufferedAmount`-vakten i ping-handleren med vilje: pong ut er begrenset til ca. 254 B/s av bøtta, så den ville vært død kode. `send()` har fortsatt vernet.
- **FIX-6 ferdig.** M19, M24, M32, M33, M46, M56, M66 og M73 er drept av permanente tester. Det inkluderer en ekte `HttpCoreClient`-stubtest portet fra `p6b`. M38 er ekvivalent og overlever som forventet.
- **FIX-3 ferdig.**
  - Byte-bøtte ved ankomst (64 KiB/s, burst 512 KiB) gir 1008 `audio_rate_exceeded`.
  - `maxTurnBytes` 2 MiB avslutter turen med det som er mottatt (`turn_audio_limit`) og nullstiller VAD.
  - `maxPendingTurns` 8 gir `voice_busy`, og `maxQueuedTtsChunks` 128 gir `tts_queue_full`.
  - Test: `wpv2-audio-bounds` (10 tester, 4 røde først). Probe `p4`: lukket etter 40 rammer, RSS flat 106 MB (4 tilkoblinger: 113 mot 202 MB før).
- **FIX-2 ferdig.** Topologien er **NOT VERIFIED**.
  - `maxUnprovenPerPeer` 2: en tredje ubevist `start` får `voice_busy`.
  - `startTimeoutMs` 10 s gir `start_timeout`.
  - Er det fullt, kastes den eldste ikke-beviste ut (`voice_evicted`, 1013 `evicted`). Bevisste kastes aldri ut.
  - Test: K2 «ConnectionTracker» (5) og «FIX-2» (6). To eldre K2-tester starter nå bevist.
- **FIX-4 ferdig.** `ProcessSlots` har én reservert plass for bevisste (`reservedProvenSlots` 1). Manglende kontekst regnes som ubevist, og `RemoteWhisperStt` gir konteksten til fallbacken. Pris: ubeviste får bare 1 av 2 whisper-plasser. Test: `wpv2-proven-slots` (9 tester, 6 røde først).
- **FIX-5 ferdig.** Bare en feil som beviser at forespørselen aldri nådde Core frigir claimen, og beviset er Node-feilens `syscall` (`connect`/`getaddrinfo`). Målt mot Node 22: lukket port gir ECONNREFUSED med syscall `connect`. En socket Core dreper etter mottatt forespørsel, HTTP 5xx, `core_timeout` og avbrudd beholder claimen (ukjent utfall, aldri retry). Kode: `core-errors.ts`, `server.ts`, `session.ts`. Test: `wpv2-core-notsent` (8 tester, 3 røde først).
- **FIX-7 ferdig.** `available()` caches i 5 s med injiserbar klokke (`AvailabilityCache`). Test: `wpv2-availability-cache` (5 tester, røde først).
- **FIX-8 ferdig.** «den 1. mai» og lignende gir nå én chunk. Test: `wpv2-k8-chunker` «FIX-8» (6 tester, 3 røde først). Probe `p8` gir 57/57.
- **FIX-9 ferdig for tre av fire punkter.**
  - Avviste sockets terminereres etter 2 s (`refusedCloseGraceMs`).
  - `cancel()` rett etter at plassen er innvilget starter ingen Piper-prosess.
  - Piper-plassen frigis når prosessen er død, med SIGKILL etter 2 s.
  - **DEFERRED:** TCP og HTTP før oppgraderingen er ubegrenset. Det er dokumentert i runbooken, med Q-forslag under.
  - Test: K2 «FIX-9» (6 tester, 4 røde først).
- **Docs ferdig.** Runbook §1, 2, 3, 5, 7, 8, 9 og nytt §10, pluss `VOICE_ARCHITECTURE.md` §4 og §8. «Aldri et krasj» er rettet til det som er målt, med eksplisitt liste over det som ikke er begrenset.

**Mutanter.** Reviewerens 9: 8 drept på nytt, M38 ekvivalent. Mot FIX-1 til FIX-5 har jeg kjørt 70 egne mutanter, alle drept. For FIX-7 til FIX-9 kjørte jeg 32: F7 9/9, F8 13/14 (F8n er ekvivalent) og F9 6/9. Av F9-overlevende er F9f (sikkerhetstimer) og F9j (timeropprydding ved `close`) forsvarskode uten reproduserbar utløser. F9g var redundant og er fjernet. Fire mutanter overlevde først og ga sterkere tester.

**Prober p1–p14 mot sluttkoden.**
- Grønne: p1 33/33, p4, p5, p6b 6/6, p7, p8 57/57, p9, p10, p11, p12 alle PASS, p14 16/16. p13 gir 30/31, og den ene er den kjente probefeilen (`AAA=`).
- Røde som er tilsiktet endret atferd: p2 C1 og p3 1a/1c/2a (utkasting og ubevist-tak i stedet for avvisning).
- Røde som er probe-artefakter: p6 4, 6b og 7b. Proben sin egen Core-mock kaster aldri `voice_session_required`, og 7b venter bare 250 ms. Med 3 s ventetid gir 7b 9 kall som forventet.

**Statiske kontroller og testtall** (som `postgres`, maks 2 arbeidere)
- `apps/voice-gateway/test` uten e2e: **36 filer / 500 tester** (før runden 32 / 431). `voice-e2e` 6/6.
- `apps/api` statiske tester: 7 filer / 81. Guards i `modules/core`: 9 filer / 81. Øvrige d396/d398-guards: 7 filer / 28. Doc-guards pluss api-statikk er kjørt på nytt etter docs-commit: 11 filer / 119.
- `pnpm -r typecheck`, `pnpm lint` og `pnpm check:containment`: alle exit 0.
- Gitleaks: ett funn, den kjente falske positiven i `97b8b758`, ingen nye.

**Nye antakelser til D-488**
1. Legitim ping er høyst én per 20–30 s.
2. Legitim lyd er 32 000 B/s, og taket per tur er VAD 30 s = 960 kB.
3. Bak Docker-bridge kollapser peer-adressen (modellert, ikke målt).
4. Én reservert prosessplass for bevisste er riktig kapasitetspris.
5. Node-feilens `syscall` `connect`/`getaddrinfo` beviser at forespørselen ikke ble sendt (målt for ECONNREFUSED og ENOTFOUND).
6. 5 s cache på `available()`, og norske datoer kun med fulle månedsnavn.

**Q-forslag**
- **Tailscale-topologi:** hvilken peer-adresse ser gatewayen bak Tailscale Serve og Docker, og finnes `X-Forwarded-For`? Skal gatewayen stole på XFF fra bridge-gatewayen? Det krever en ny konstant og er bevisst ikke gjort uten måling.
- **Pre-upgrade:** vil du ha en tilkoblingsrate- og halv-åpen-grense før WebSocket-oppgraderingen? Vil du ha en `mem_limit` i compose? `voice-gateway` har `restart: unless-stopped` men ingen minnegrense, og det ligger utenfor dette WP-et.

**NOT VERIFIED:** den faktiske Docker/Tailscale-topologien, ekte Piper/Whisper/mikrofon/NAS, og standardtidene i sanntid. `UND_ERR_CONNECT_TIMEOUT` er ikke klassifisert (regnes som ukjent). EHOSTUNREACH, ENETUNREACH og connect-ETIMEDOUT er bare testet med syntetiske feil.

**Avvik jeg må melde**
- `e9159dc6` nevner i meldingen en `server.ts`-opprydding som ikke kom med, fordi mutasjonskjøreren gjenopprettet filen. Den kom i `ff4bfffc`.
- `ff4bfffc` ble pushet mens én tidsfølsom K2-test (ping hvert 20. ms) feilet i én kjøring. Den lot seg ikke reprodusere i 20 gjentatte kjøringer, også under CPU-last. Testen er herdet til 100 ms i `4d63b70d`.
- Repoet har ingen git-hooks, så ingenting ble omgått.

Mutasjonskjører, notater og probe-kopier ligger i `/tmp/pg-home/v2-fix1-notes/` (`NOTES.md`, `mut/`, `probes/`).
