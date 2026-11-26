TS: 2026-11-26T12:15:23.985Z
**Rapport WP-V2 (voice-robusthet)**

`CORE_DEPENDENCY_DECISION_REQUIRED=false` · `HARD_EXTERNAL_BLOCKER=false`

**Avvik, lead må handle:** gitleaks over `origin/main..HEAD` gir 1 falsk positiv. Regelen `generic-api-key` slår på RFC 6455-eksempelnoncen i commit `97b8b758`, linje 118 i `wpv2-k1-crash-protection.test.ts`. Linjen er byttet ut med en runtime-generert nøkkel i HEAD. Funnet ligger i historikken og kan ikke fjernes uten omskriving, som er forbudt. Fingerprint: `97b8b75803c19aa1bc37932ede5fbbfa5ba40f01:apps/voice-gateway/test/wpv2-k1-crash-protection.test.ts:generic-api-key:118`. Legg den i `.gitleaksignore` (jeg har ikke rørt filen) eller tillat squash. En `--no-git`-skanning av treet gir 20 funn, alle utenfor mine filer og eldre.

## 1. Gren og commits
- Gren `claude/wp-v2-voice-robustness`, HEAD `ed176a1b`, pushet (i synk). `main` er uendret på `71a31d8b`.
- 12 commits: `0cf95764` (K1/K2/K3/K5), `fc569a43` (K4), `e888eee5` (K8), `d1035c54` (K7), `593006dd` (K6b), `9e9dd309` (docs), deretter 6 test-/docs-forbedringer.
- 30 filer, +5325/−226:
  - `src`: 12 filer, seks nye (`limits`, `journal`, `failover`, `deadline`, `local-binary`, `speech-context`).
  - `test`: 15 filer (10 `wpv2-*.test.ts`, harness, 3 fixtures, 1 justert d30-test).
  - `voice.html`, `VOICE_ARCHITECTURE.md` og runbooken `docs/runbooks/WPV2_VOICE_ROBUSTNESS.md`.
- Migrasjon: ingen. Nye flagg: ingen. Core, `apps/api` og delte docs er urørt.

## 2. Krav K1–K9
- **K1 ferdig.** `ws.on("error")`, `wss.on("error")` og `clientError` ligger i `server.ts:425-442`. Piper har `proc.once("error")` og kaster `local_piper_spawn_failed:<kode>`. `available()` sjekker binær og modell for både piper og whisper, og `/health` gir 503. Tester: `wpv2-k1`, `wpv2-main-process` (ekte `main.ts`).
- **K2 ferdig.** Alle grenser i `limits.ts`, begrunnet i runbook §2: maxPayload 64 KiB, 16/4 tilkoblinger, token bucket 100/s med burst 200, ramme 16 KiB, idle 120 s, 30 min ubevist, ping 30 s, backpressure 1 MiB med close 1013, semaforer, kø-tak. Test per grense i `wpv2-k2`.
- **K3 ferdig.** `audio`, `replay_final` og `start` valideres (`malformed_message`). Ny `start` kaller `disconnect()` på forrige sesjon. Test: `wpv2-k3`.
- **K4 ferdig.** Frister på alle leverandørkall, ekte `cancel()` via AbortController, `core_timeout` etter 120 s, per-chunk-frist i `ttsWorker`, `stt.end()`-frist. `FailoverTts` og `FailoverStt` (`failover.ts`) følger reglene i ordren. `selectSpeechAdapters` er uendret. Tester: `wpv2-k4-deadlines`, `wpv2-k4-failover`.
- **K5 ferdig, restart-sikkerhet `PARTIAL`.** Én prosess-delt journal opprettet i `main.ts`, atomisk `claim` før Core-kall, nøkkel (tillitsnivå, tenant, enhet, id), LRU + TTL, `randomUUID`-prefiks. Regresjonslås for 079 (VAD per sesjon, frakobling midt i `chatStream`, barge-in). `SttStream.cancel` er `DEFERRED` (Deepgram-streaming er ikke koblet i `main.ts`). Test: `wpv2-k5`.
- **K6a `DEFERRED`.** Offisiell Piper-dokumentasjon beskriver ingen utterance-grense i `--output-raw`, så varig prosess kan ikke bevises. Eierens steg står i runbook §6.
- **K6b ferdig.** Samplerate = env, så `audio.sample_rate` i `<modell>.onnx.json`, så 22 050. Kilde i `/status` og oppstartslogg, avvik logges. Test: `wpv2-k6`.
- **K7 ferdig.** Ringbuffer på 200 linjer, `tts_frame` som teller, DOM-skriving ca. 4/s, `AudioContext` lukkes, oddetall-ramme forkastes, gate etter `tts_cancelled`. Funksjonene kjøres i `node:vm` (`wpv2-k7`).
- **K8 ferdig.** Hard maks 4 000 tegn, kodepunkt-sikker, «14:30», «f.eks.», «kl.», «bl.a.», adresser og e-post kuttes ikke, lineær skanning. Test: `wpv2-k8` (norske eksempler).
- **K9 ferdig.** Runbook skrevet, `VOICE_ARCHITECTURE.md` §4/§8/§10 rettet. Guards grønne.

## 3. Rød-først-bevis (kjørt mot base `71a31d8b` i isolert, nå slettet mappe)
- **Piper ENOENT:** testen timet ut etter 15 s (uncaughtException i workeren). Via sesjon: `expected [] to include 'tts_error'`. `available()` og `/health` 503 feilet.
- **WS-ramme:** `uncaught:WS_ERR_INVALID_UTF8` og `uncaught:WS_ERR_INVALID_OPCODE`. En melding på 70 KB ble akseptert uten 1009.
- **Journal:** `replay_final` med samme id ga 2 Core-kall (forventet 1), både sekvensielt og samtidig.
- **Ny `start`:** forrige TTS ble aldri kansellert (cancel = 0, forventet ≥ 1). `audio` uten `data` ga `[]` i stedet for `["malformed_message"]`.
- **`voice.html`:** 1000 `tts_frame` ga 1000 DOM-skrivinger, en logg på 20 311 tegn / 66 linjer med base64-støy.
- **Chunker:** «14:30» ble kuttet. 10 000 tegn uten mellomrom ga én chunk på 10 000 (forventet ≤ 4 000). Surrogatpar-testen ga en chunk på 4 000 mot grense 101. 200 KB uten grenser ble ikke ferdig på 40 s (kvadratisk).
- Brå TCP-reset og `clientError` var allerede trygge på base (regresjonsvakter).

## 4. Tester og statiske kontroller
- `apps/voice-gateway/test` uten `voice-e2e`: 32 filer / 431 tester grønne (base: 22 / 248).
- `voice-e2e` som `postgres`: 6/6.
- `apps/api` statiske tester (`voice-page-wiring`, `d252`, `d260`, `d347`, `d361`, `remediation-2-static-pages`): grønne.
- Guards (`d212`, `d253`, `d396`, `d398`, `wpj-closure-matrix`, `ops/security` check-containment): grønne (12 filer / 139 tester).
- `remediation-2-compose-isolation` som `postgres`: 40/40.
- `pnpm -r typecheck`, `pnpm lint` og `pnpm check:containment`: exit 0.
- Ekte `main.ts` manuelt: ugyldig UTF-8 ga 1007, reservert opcode 1002, 70 KB 1009, flom 1008. Prosessen levde, `/health` 200. En andre instans på samme port ga `EADDRINUSE` og exit 1.
- **Mutantsett:** 65 mutanter over grenser, journal-claim, failover-regler, ringbuffer og chunker. 63 ble drept første runde. To overlevde: M48 (`cancel()` under failover) og M50 (rutingporten for reserven). Jeg styrket testene (timing-assert og `vi.mock` av `evaluateSpeechRouting`) og begge ble drept. Sluttresultat 65/65. Filer: `/tmp/pg-home/v2-notes/{mutants.py,run-mutants.py,mutants-results.jsonl}`.

## 5. Security surfaces for uavhengig gjennomgang
- `server.ts`: 425-442 (maxPayload, error/clientError), 449 (tilkoblingsgrenser), 474-493 (`closeConnection` og `send` med backpressure), 293 og 319 (validering), 567-591 (`start` erstatter sesjon), 803-833 (timere og rate limit).
- `failover.ts`: 56 (kun lokal reserve), 64-69 (`usableReserve` og rutingport), 215-250 (`run`, kun før første ramme).
- `journal.ts`: 65 (atomisk `claim`), 120 (kapasitet), 146 (nøkkel). `session.ts`: 558-567 og 636 (claim og `notSent`).
- `tts.ts` og `stt.ts` (`detached`, gruppe-kill, `releaseSlot`) og `limits.ts` (`peerKey`, `ProcessSlots`).

## 6. Motsigelser
- Ledger 098 «ubegrenset logg» er foreldet (20 000 tegn), nå ringbuffer. Ledger 080 «24 vs 22,05 kHz» er delvis lukket av D-390, nå også modellkonfig og resampling ved failover. Piper-`spawn` og ws-`error` sto ikke i ledgeren.
- `VOICE_ARCHITECTURE.md` §4 lovde checkpoint og failover uten dobbelutførelse. Dette er rettet. `voice-e2e` beviser kun samme prosess, ikke restart-sikkerhet.
- `authorizeVoiceSession` hadde allerede 10 s frist.
- Nye funn:
  - Testene refererte `fake-voice.onnx` og `fake-model.bin`, som ikke fantes. De bestod fordi `available()` bare sjekket env. Fixtures er lagt til.
  - d30-testen sjekket objektidentitet på abort-signalet. Justert fordi signalet nå er avledet.
  - §8 «køer ikke-kritiske turer» finnes ikke i koden.
  - Piper-flagg i koden er skrevet med understrek. Dokumentasjonen til piper1-gpl bruker bindestrek.
  - To enheter kolliderer ikke på id-prefiks med nøkkelen (tenant, enhet, id). Det gjelder to sesjoner fra samme enhet, f.eks. to faner. `randomUUID` er innført uansett.

## 7. D-488-forslag (antakelser)
1. Alle grenser er konstanter i `limits.ts`, ingen flagg. Per-peer-grensen (4) kan gjelde alle klienter samlet bak Docker-NAT eller loopback-proxy uten `X-Forwarded-For`.
2. Etter `claim` regnes turen som utført i alle utfall, unntatt `voice_session_required` som frigir claimen. Journalnøkkelen inkluderer tillitsnivå, så en ubevist klient ikke kan forgifte en bevist enhets id-er.
3. Failover komponeres i `main.ts` etter utvelgelse, bare når valgt adapter er ekstern og lokal reserve er tilgjengelig. TTS bare før første ramme, cooldown 30 s, reservens samplerate resamples til primærens.
4. Frister: 20 s på sky-STT, 30 s per TTS-chunk, 60 s på whisper og piper, 120 s total Core-tur, 15/60 s TTS-stall/chunk i sesjonen. Core-turer over 120 s gir nå `core_timeout`.
5. Piper: `<modell>.onnx.json` leses i kildekoden til `OHF-Voice/piper1-gpl` (`config["audio"]["sample_rate"]`, `f"{model_path}.json"`), via WebFetch. Dette er ikke kjørt mot en ekte stemme.
6. Whisper og piper startes `detached`, slik at fristen kan drepe hele prosessgruppen.

## 8. Statusforslag og Q-forslag
- **063 (voice-delen):** `CODE_FIXED`. Kapasitetstest på NAS er `NOT VERIFIED`.
- **079:** `CODE_FIXED` (delvis). Rest: K6a `DEFERRED`, journal over omstart `PARTIAL`, `SttStream.cancel` `DEFERRED`.
- **080:** `CODE_FIXED`. Live failover er `NOT VERIFIED`. Operatørens opprydding av gamle dumper er uendret.
- **098:** `PARTIAL`. `voice.html`-hygiene og tekst-kanttilfeller er `CODE_FIXED`. Tillitsmodell-hullene er uberørt, og benchmark er `BLOCKED_EXTERNAL`.
- **Nye rader:** audit A1, A2, A3, C4 og D1 `CODE_FIXED`.
- **Q-A:** Skal utterance-journalen gjøres varig via Core-rute og migrasjon (egen WP)? Alternativ: utvide ToolGateway-ledgerens nøkkel med enhet + utterance_id uten tidsvindu.
- **Q-B:** Hvilken Piper-utgave er installert (arkivert C++-binær med understrek-flagg eller piper1-gpl med bindestrek)? Skal HTTP-serveren brukes som varig prosess? Den kan gi modell-gjenbruk, men er en egen driftskomponent med WAV per forespørsel.

## 9. `NOT VERIFIED` og `BLOCKED_EXTERNAL` (eierens steg i runbook §8)
- Ekte mikrofon via `voice.html` (logg, `AudioContext`, barge-in, dempet fane).
- Ekte Piper og Whisper på NAS: flaggstavemåte, `sample_rate_source`, ikke-prosess-krasj ved feil sti.
- Failover ved å kutte skytilgang (ugyldig nøkkel eller blokkert egress).
- Kapasitetstest fra en annen maskin.
- Journalens restart-grense.
- Piper-dokumentasjonen er lest via et oppsummerende fetch-steg og bør bekreftes av eieren.

## 10. Kjente begrensninger
- Pre-upgrade TCP/HTTP-tilkoblinger er bare begrenset av Node-standardene.
- Piper-kald oppstart gjelder første chunk i hvert svar.
- `ttsQueue` har ingen egen kø-grense, bare rate limit og frister.

Fremdriftsnotater ligger i `/tmp/pg-home/v2-notes/NOTES.md`. Treet er rent, og temporære `.red`/`.mut`-mapper er slettet.
