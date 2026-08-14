# Runtime gates – status og evidens (v4.0 reality check, 2026-08-13)

Statusverdier: NOT_IMPLEMENTED · IMPLEMENTED_NOT_VERIFIED · PARTIAL_RUNTIME · PRODUCTION_VERIFIED · BLOCKED_EXTERNAL

| Gate | Status | Evidens / gap |
|---|---|---|
| D-27 Langfuse | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | LangfuseTraceSink implementert (`modules/model-gateway/src/trace.ts`); krever Docker for kjørende instans |
| D-28 pgvector/HNSW | BLOCKED_EXTERNAL | Portabel `real[]`+cosine i drift (P95<300ms bevist i test); pgvector-migrasjon venter på Docker-image |
| D-30 Voice benchmark | BLOCKED_EXTERNAL | Harness + WER testet; krever ≥100 norske prøver + STT/TTS-nøkler |
| D-32 Worker Docker/GitHub | PARTIAL_RUNTIME + BLOCKED_EXTERNAL | Prosess-sandbox/lease/reclaim/kodejobb bevist (96→128-suiten); container + ekte GitHub-API mangler |
| D-35 Vault + live integrations | IMPLEMENTED_NOT_VERIFIED + BLOCKED_EXTERNAL | Alle adaptere/transportskall + SecretProvider klare; krever Infisical (Docker) + OAuth/API-credentials |
| D-36 Apple runtime | BLOCKED_EXTERNAL | Swift-kilde klar; krever Mac/Xcode/Developer-konto (sjekkliste: APPLE_PHASE8_CHECKLIST.md) |
| HA-RUNTIME | BLOCKED_EXTERNAL | HA-verktøy m/D-pipeline testet mot fake; krever HA-instans + token |
| OPS-RUNTIME | PARTIAL_RUNTIME | Watchdog/kill-switch-kriterier/backup+restore målt i test (fase 10); ekstern uptime/off-site backup gjenstår |
| UA0-AUTHORITY | PARTIAL_RUNTIME | **Implementert 2026-08-13:** `resolveAuthorityMode` (SOVEREIGN for owner-tenant, delegat arver aldri), sovereign klasse C/D uten approval, D-pipeline (preflight→state readback→before/after→recovery-snapshot→audit), OwnerControls (pause/freeze/revoke) håndhevet i policy+gateway. Evidens: `modules/tool-gateway/test/ua0-sovereign.test.ts` (pnpm test → 128/128). Live-verifikasjon mot ekte connectors gjenstår |
| UA0-PRIVACY | PARTIAL_RUNTIME | Tenant+space-RLS, karantene, injection-vern bevist i suiten; live-datastrøm gjenstår |
| UA0-RUNRATE | **PARTIAL_RUNTIME m/LIVE PROVIDER-EVIDENS** | 2026-08-13: ekte OpenAI-kall (gpt-4o-mini) gjennom ModelGateway mot ekte Postgres: cost_events={provider:openai, model:gpt-4o-mini, in:30, out:9, 3 øre, task-live-runrate/sess-live-1}, trace-span 2067 ms. Kommando: `node --experimental-transform-types modules/tool-gateway/scripts/live-runrate.ts`. Brief-generering skriver egen cost-rad (kind=brief:generation) → cost_per_daily_brief beregnes reelt. Sky-/connector-kost mangler live kilder |

**Regel:** Ingen gate settes til PRODUCTION_VERIFIED uten faktisk runtime-evidens (kommando + resultat + dato) logget her.

## BO-02-tillegg (2026-08-13)
- **Node 22-avvik løst:** `pnpm --use-node-version=22.14.0 vitest run` → **128/128 PASS** (re-kjørt);
  gårsdagens «6 skipped» er ikke reproduserbart (transient, trolig portkollisjon/timing i voice-e2e).
  Node 22 bekreftet som production target; ingen tester fjernet/deaktivert.
- **Model-provider live:** OpenAI PRODUCTION-kall verifisert (evidens over). Anthropic/Ollama: nøkkel/endepunkt mangler.
- **Nytt:** POST /brief (JSON+rendert+session), Telegram-levering (chunket, idempotent, via Tool Gateway - venter bot-token), persistent seen/stale-suppression (migrasjon 012, testet), brief-cost-rad per generering.
- **Docker fortsatt fraværende** → D-27/D-28/D-32/Infisical-D-35 uendret BLOCKED_EXTERNAL.

## BO-03-tillegg (2026-08-13)
- **Docker/credentials re-probet: fortsatt fraværende** (ingen docker-binaer, ingen .env) -
  D-27/D-28/D-32/D-35 og alle live-connector-maal forblir BLOCKED_EXTERNAL.
- **Produksjonstransporter implementert og typesjekket (live-kall venter kun paa .env):**
  GmailTransport (OAuth refresh->access, metadata, unread/important, konto-merket),
  GoogleCalendarTransport (dagens/kommende events m/attendees/prep), GithubTransport (issues/PR),
  TelegramTransport (sendMessage til owner-chat) + TelegramCommandPoller (/brief, /status,
  kun owner-chat, svar via Tool Gateway/audit).
- **Konto-/tenant-opploesning:** transport-instans er bundet til eksplisitt konto
  (JARVIS_GOOGLE_ACCOUNT, default post@tsworkflow.com per D-34, som konfig - aldri hardkodet i
  domenelogikk); ingen implisitt cross-account fallback.
- **Connector-health:** healthy/auth_failed/rate_limited/unavailable per tool_id oppdateres av
  hvert kall i Tool Gateway; eksponeres i /status.
- **Morgenlevering:** konfigurerbar (JARVIS_BRIEF_HOUR, default 07), en gang per dag, degraderer
  pent (brief-kilder feiler enkeltvis; Telegram-feil stopper ikke prosessen).
- .env-noekler som aktiverer alt: JARVIS_GOOGLE_CLIENT_ID/SECRET, JARVIS_EMAIL_TOKEN +
  JARVIS_GOOGLE_TOKEN (refresh tokens), JARVIS_GITHUB_TOKEN, JARVIS_TELEGRAM_TOKEN +
  JARVIS_TELEGRAM_CHAT_ID.

## BO-04 LIVE-EVIDENS (2026-08-13, kommando: node --experimental-transform-types modules/tool-gateway/scripts/live-verify.ts)
- **Gmail: LIVE+VERIFIED** (post@tsworkflow.com, ekte meldinger normalisert inn i brief; health=healthy)
- **Calendar: LIVE+VERIFIED** (primary, 0 events i dag - reelt; health=healthy)
- **GitHub: LIVE+VERIFIED** (tsworkflow/jarvisbuild, 0 aapne issues - reelt; health=healthy)
- **Telegram: LIVE+VERIFIED** (owner-chat 8602032369; testmelding message_id=5; owner-only isolation i poller)
- **FOERSTE EKTE DAILY BRIEF generert av live kilder og LEVERT til Telegram** (delivered=true,
  top=3, follow-ups=15 fra ekte e-post, 0 source_errors, seen-state persistert 20 items,
  2x brief:generation i cost_events, /status levert). D-35 live-integrasjonsdel: **PRODUCTION_VERIFIED
  for Gmail/Calendar/GitHub/Telegram**; Infisical-delen fortsatt BLOCKED_EXTERNAL (Docker mangler - reprobet).
- Kjente gap: scheduler er prosess-lokal (ikke reboot-durabel); inbound /brief-/status-kommandoer
  krever kjoerende API-prosess (poller starter med main).

## BO-05 LIVE-EVIDENS (2026-08-13, Docker server 29.7.2 / Desktop 4.86)
- **D-28: LIVE+VERIFIED (runtime):** PostgreSQL 16.14 i Docker (compose, persistent volum),
  pgvector **0.8.6**, HNSW-indeks opprettet, `<=>`-similarity korrekt, RLS aktivert,
  **data overlevde container-restart** (count uendret). Alle 13 migrasjoner kjørt mot Docker-PG
  (34 tabeller). GJENSTÅR: konvertere embeddings-kolonnen real[]→vector + retrieval-bytte +
  eval-regresjon (D-28-portens migreringssteg).
- **D-32 (delvis):** kastbar worker-container bevist: node:22-alpine, non-root (node),
  --network none, --memory 256m, --pids-limit 64, INGEN JARVIS-env (0 treff), workspace i
  container, testkommando OK. GJENSTÅR: DockerSandboxRunner-wiring i worker + reclaim-test i
  container + ekte GitHub-PR-flyt.
- **Scheduler: VERIFIED reboot-durabel** (migrasjon 013 + DailyScheduler: DB-lås, Europe/Oslo,
  catch-up, multi-instans → nøyaktig én vinner, testet; main bruker den).
- **D-27 Langfuse / Infisical-D-35: IKKE startet i denne økten** (bevisst prioritering) —
  neste økt: legg langfuse:2 + infisical i compose med LANGFUSE_INIT_*-nøkler, ekte trace + secret-flyt.
- Docker-CLI-merknad: binærer ligger på per-bruker-sti
  C:\Users\Tobia\AppData\Local\Programs\DockerDesktop\resources\bin (ikke i systemets PATH for shells).

## BO-06 LIVE-EVIDENS (2026-08-13)
- **D-28: VERIFIED.** Migrasjon 014 (betinget pgvector, ikke-destruktiv). Mot Docker-PG: ekte Jarvis
  embeddings-kolonne `vec` = pgvector `vector`, HNSW-indeks `embeddings_vec_hnsw`, writer fyller vec
  (3/3 rader), MemoryRetriever bruker `<=>`-cosine via pgvector (runtime-probe; real[]-fallback for
  embedded test-PG). Retrieval-regresjon: semantisk topptreff korrekt (score 0.914), kryss-tenant
  A→B = 0 (RLS holder gjennom pgvector-pathen), tom/irrelevant spørring = 0. Persistens (BO-05) PASS.
  130/130 tester fortsatt grønne (real[]-pathen uendret).
- **UA0-RUNRATE: VERIFIED mot Docker-PG.** Ekte OpenAI-kall (gpt-4o-mini) → cost_events i Docker-PG
  {provider:openai, model:gpt-4o-mini, in:25, out:8, 2 øre, task-bo6}. Ingen secrets i rad/trace.
- **OPS backup/restore: VERIFIED.** pg_dump -Fc av Docker-PG → restore til fersk DB: cost_events=1,
  embeddings=3, vec-type=vector, 33 tabeller bevart. Backup-fil i scratchpad (ikke i repo), slettet.
- **IKKE gjort i BO-06 (ærlig - neste økt):** D-32 DockerSandboxRunner-wiring i worker + reclaim i
  container; D-27 Langfuse-runtime + trace; D-35 Infisical-runtime; API-autostart-container;
  full-stack compose (langfuse/infisical/api) + failure-injection. Alt er ren byggetid, ingen
  eksterne blockere.

## UA-0 FORMELL LUKKING (BO-08, 2026-08-13)

**UA-0 CORE RUNTIME = CLOSED.** Reality-check ved lukking: HEAD `fc1dd27`, full compose-stack healthy
(postgres/langfuse/infisical(+redis)/api/worker), 130/130 tester, lint/typecheck/gitleaks rene.

| Gate | Sluttstatus | Evidens |
|---|---|---|
| D-27 Langfuse | **VERIFIED** | BO-07-seksjonen under |
| D-28 pgvector/HNSW/retrieval | **VERIFIED** | BO-06-seksjonen |
| D-32 Docker-sandbox/durable worker | **VERIFIED** | BO-07-seksjonen |
| D-35 Infisical/SecretProvider/pilot | **VERIFIED** | BO-07-seksjonen |
| OPS-RUNTIME (full stack/restart/failure-injection) | **VERIFIED** | BO-07-seksjonen |
| UA0-RUNRATE | **VERIFIED** | BO-06/BO-07-seksjonene |

**Egne åpne porter (blokkerer IKKE UA-0 core):** D-30 Voice = OPEN (krever ≥100 norske prøver +
STT/TTS-nøkler) · D-36 Apple = OPEN (krever Mac/Xcode/Developer-konto) · HA-RUNTIME = OPEN (krever
HA-instans + token).

**Owner-seed:** fra BO-08 automatisk og idempotent i `apps/api/src/migrate-main.ts` (one-shot
migrate-tjenesten); det manuelle SQL-steget fra BO-07 er fjernet. ID-er konfigurerbare via
JARVIS_TENANT_ID/JARVIS_OWNER_PERSON_ID/JARVIS_OWNER_NAME.

## BO-12 — D-30 VOICE FOUNDATION (2026-08-14)

**Status: D-30 P0 = PARTIAL (IMPLEMENTED + SUITE-VERIFIED; LIVE STT/TTS = BLOCKED_BY_ENVIRONMENT).**
Bygget i sky-container uten nøkler/Docker; live-porten lukkes på hosten med
`node --env-file=.env --experimental-transform-types apps/voice-gateway/scripts/bo12-voice-live.ts`
(host-bevist kommando: `--experimental-strip-types` feilet på Node 24-host med
ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX pga. TS parameter properties; transform-types kreves.
Krever OPENAI_API_KEY + kjørende jarvis-api; mikrofon trengs ikke - norsk testlyd
genereres via TTS→STT-rundtur; dekker §30-§33 inkl. barge-in-abort og cross-provider).

**Voice er transportlag over Jarvis (§50):** samme Conversation/AI Mesh/Tool Gateway/
authority/minne som tekst - tale gir ingen ekstra authority (§43). Bygget som DELTA på
fase 5-fundamentet (VoiceSession/VAD/STT-TTS-adaptere/WS-transport/WER-benchmark):
- **Streaming Core-klient (§12-§13):** HttpCoreClient.chatStream mot eksisterende
  /chat-SSE (P1A) - tokens → SentenceChunker (aldri halvferdige ord; splitter ikke
  "18.30") → sekvensiell TTS-kø. TTS starter på første setning FØR generering er
  ferdig (testbevist). Tool-events → korte norske statuser ("Sjekker kalenderen …",
  §26) - aldri intern JSON/payload i tale (§14/§27).
- **Barge-in (§15-§17):** tale under speaking/thinking → stopp avspilling + tøm
  TTS-kø + forkast chunker-buffer + ABORT modellgenerering upstream (P1A-kjeden) +
  interrupted-state + ny tur. Epoch-vern: gammel lyd kan aldri spilles etter ny tur
  (§16, testbevist med taggede rammer). Utført verktøy rulles aldri tilbake (§17 -
  journal + ToolGateway-idempotens).
- **Tilstandsmaskin (§23):** idle/listening/thinking/speaking/interrupted eksplisitt;
  start-melding = eksplisitt mikrofonaktivering; ingen skjult opptak.
- **Feilbaner:** STT-feil → normalisert `stt_error`, ALDRI modellkjøring på tom/
  ugyldig transkript (§35); TTS-feil → tekstsvaret leveres uansett, `tts_error`
  normalisert uten detaljer, helse DEGRADED (§36/§27). Fixtures (§28): kort/lang,
  pause midt i setning (bryter ikke turen), støy, ingen tale, avbrutt tale.
- **Metrics (§19-§20):** full latenskjede per tur (t_final_transcript,
  t_model_first_token, t_first_tts_request, t_tts_first_frame, hovedmål
  end_of_speech_to_first_audio_ms) + stt_audio_ms/tts_chars som kost-grunnlag
  (STT/LLM/TTS holdes adskilt). summarizeLatency gir P50; P95 kun ved ≥20 samples
  (§39 - aldri fake presisjon). Faktiske måltall settes av host-live/benchmark.
- **Helse (§36-§37):** VoiceHealth (stt/tts LIVE/DEGRADED/UNAVAILABLE fra faktiske
  kall), gateway /status (transport/stt/tts/barge_in/audio_persistence=none);
  api-/status viser voice-helse når JARVIS_VOICE_URL er satt.
- **Cross-provider (§33):** valgfri provider-override i /chat (router §38-semantikk)
  - voice-pipelinen er identisk uansett LLM (testbevist openai vs anthropic).
- **Personvern (§22):** rå lyd persisteres aldri (strukturelt testbevist: ingen
  filskriving i lydkjedens moduler); transcript følger eksisterende
  conversation-semantikk. STT/TTS-baseline: OpenAI (nøkkel alt live i runtime, §5-§7);
  andre providere bak samme adapterlag etter D-10-benchmark.
- **Kvalitet:** 264/264 (248 baseline + 16 nye), lint/typecheck/gitleaks rene.
  Eksisterende fase 5-akseptanser (barge-in ≤250 ms, median <1500 ms med test-
  adaptere, failover-idempotens, sesjonskontinuitet tekst↔tale) fortsatt PASS -
  e2e kjører nå den nye streaming-banen mot ekte api-SSE.

**Gjenstår for D-30 P0 = VERIFIED:** host-live (§30-§33 via scriptet over) + reelle
latens-/kostmålinger (§38-§39) + D-10-benchmark (≥100 norske prøver) for providervalg.

### D-30 LIVE FINDINGS FIX — Conversation tool bridge (2026-08-14)

Første EKTE host-live-kjøring (Windows-host m/Docker+credentials) beviste: runtime healthy,
ekte OpenAI TTS/STT (norsk) PASS, no-tool voice-rundtur PASS ("18 ganger 7" → "126"),
OpenAI- og Anthropic-LLM-voice-path PASS, barge-in/abort upstream PASS, next-turn recovery
PASS — men **kalender-voice FEILET funksjonelt** (`tools=[]`, "har ikke tilgang til
kalenderen"). Root cause + fix (denne runden, suite-verifisert i sky - IKKE nye live-claims):
- **ConversationEngine hadde aldri tool-broen fra BO-11:** fase-3-wiring brukte
  `gateway.stream/complete` uten tools, og system-prompten sa eksplisitt "ikke tilgang til
  verktøy". Fikset: `ConversationDeps.tools {definitions, executorFor(identity)}` →
  `gateway.completeWithTools` for BÅDE streaming- og JSON-banen (samme normaliserte
  tool-løkke som executive; ingen voice-spesifikk sidevei). Prompt oppdatert (ingen
  permissions i prompt - Policy/Authority forblir trusted runtime).
- **Identity-binding:** executor bindes til samtalens RESOLVED identity per kall
  (`executorFor(identity)` → `MeshToolExecutor(toolGateway, identity)`) - aldri global
  ownerIdentity - tenant/delegation/authority følger den som snakker (testbevist m/2 tenants).
- **SSE `tool_call`-event:** `tool_call_complete` → `event: tool_call` m/KUN `tool_name`
  (aldri raw args/tool-result; testbevist). Voice-HttpCoreClient forsto allerede eventet.
- **Voice-device-seed:** host-live ga 403 unknown_device for `jarvis-voice-live` (kun
  jarvis-core var seedet). Seed er nå delt idempotent funksjon (`apps/api/src/seed.ts`,
  brukt av one-shot migrate) og inkluderer voice-device (JARVIS_VOICE_DEVICE_ID ??
  jarvis-voice-live, kind=voice, samme konfigurerte owner tenant/person).
- **Host-kommando korrigert** (strip→transform-types, se over) og **STT-akseptansen gjort
  semantisk robust** (`apps/voice-gateway/src/acceptance.ts`: "atten ganger sju" ≙
  "18 x 7"/"18 × 7"; terskel uendret - norsk kalender-setning er ikke svekket).

**Neste:** pull ny HEAD på hosten, rebuild api-runtime, re-kjør bo12-voice-live.ts
(kalender-flyten skal nå gi `tools=[read_calendar_today]`), og lukk D-30 P0 på evidensen.

### D-30 FINAL HOST ACCEPTANCE HARDENING (2026-08-14, runde 3)

Windows-host bekreftet (runde 2): API healthy, norsk TTS→STT PASS, ConversationEngine
tool bridge PASS (`tools=[read_calendar_today]`, ekte kalendersvar), no-tool/OpenAI/
Anthropic voice-path PASS, upstream-generation-cancellation PASS, ren neste tur PASS.
Denne runden lukker gatene bo12-voice-live.ts IKKE beviste: ekte lyd-barge-in (ikke
bare LLM AbortSignal), stale-audio-epoch med eksplisitte tellere, kontrollert failure-
recovery (STT/TTS/provider/disconnect), 10-tur soak, Q-18-repro, full latenskjede,
observability-korrelasjon. **Ingen av gatene under er kjørt LIVE i sky-containeren -
kun suite-verifisert her + nye host-scripts levert for hosten.**

- **§1/§2 Real audio barge-in + stale-audio-epoch (host-script, IKKE kjørt her):**
  `bo12-voice-live.ts` har ny seksjon "D-30 HARDENING §1/§2" - full `VoiceSession`
  (ekte VAD→STT→Core→TTS, IKKE en isolert `AbortController`), "brukerens" barge-in
  spilles inn som EKTE TTS-lyd gjennom `pushAudio()` (samme rundtur-teknikk som §30).
  Rapporterer `barge_in_audio_stop_ms` (fra `onTtsCancelled`, dvs. `playback.cancel()`-
  signalet - eksplisitt SKILT fra `activeTurnAbort` som er LLM-siden) med
  ≤250ms-gate-sjekk, og et eksplisitt 500ms-settle-vindu der ENHVER TTS-ramme fra
  turn A etter barge-in feiler scriptet hardt (`staleFramesAfterBarge > 0` →
  kastet feil). Deterministisk stale-audio-bevis finnes FRA FØR i suiten
  (`d30-foundation.test.ts` "Barge-in": taggede rammer `S{n}-f{i}`, bevist 0 gamle
  tagger etter ny epoch) - host-scriptet legger til det ekte lyd-laget.
- **§3 Failure recovery - fault injection (suite-verifisert, ikke live-fremprovosert
  per ordre):** A (STT) og B (TTS) var alt dekket; NYE tester lagt til:
  - **C (provider/model-feil FØR output):** `chatStream` kaster FØR første token →
    normalisert `core_error`, state går til `listening` (ingen zombie), rå
    feilmelding (inkl. simulert secret-streng) krysser ALDRI til klient-events,
    neste tur fungerer uendret.
  - **D (klientdisconnect):** **FUNN + FIKS** - `VoiceSession` hadde INGEN
    `disconnect()`-håndtering og `server.ts` lyttet aldri på WS `close`. En
    frakoblet klient midt i en tur lot modellgenereringen fortsette som zombie
    (bortkastet modell-/TTS-kost, ingen mottaker). Fikset: ny
    `VoiceSession.disconnect()` (bumper epoch, tømmer TTS-kø, aborterer
    `activeTurnAbort` upstream - symmetrisk med `bargeIn()`) wiret til
    `ws.on("close", ...)`. Testbevist: abort skjer, `coreReturned` blir aldri
    sann, ny sesjon etterpå fungerer. **Denne wiringen er unit-/suite-testet,
    IKKE host-live end-to-end testet** (krever ekte WS-klient mot en kjørende
    voice-gateway-prosess - dokumentert gjenstående host-steg, ikke påstått
    VERIFIED live).
- **§4 10-tur host-soak (nytt script, IKKE kjørt her):**
  `apps/voice-gateway/scripts/bo12-voice-soak.ts` - ÉN sammenhengende
  `VoiceSession` gjennom 10 turer (no-tool/kalender/normal/tvunget OpenAI/tvunget
  Anthropic/ekte barge-in-kansellering av en pågående tur/kalender-repetisjon for
  Q-18). Feiler hardt på: <10/10 fullførte turer, >1 observert `session_id`
  (sesjonskontinuitet brutt), duplikate verktøystatuser i samme tur, korrupt
  sesjon, eller kansellert siste tur. Full latenskjede logges per tur.
- **§5 Q-18 (tool-dedupe på A-klasse read i samme session) - REPRODUSERT, BLOKKERER
  IKKE dette, men er BLOCKER for repetert kalenderspørring i samme sesjon.** Se
  OPEN_QUESTIONS.md Q-18 for fullt bevis (`q18-read-dedupe.test.ts`, 2 tester mot
  ekte embedded PG) + foreslått minste fix (IKKE implementert - egen BO kreves).
  `bo12-voice-soak.ts` turn 6/10 gir en live-observerbar krysssjekk av samme funn.
- **§6 Latenskjede:** `TurnMetrics` utvidet med `t_tool_activity` (tidspunkt trusted
  tool-status varsles); ny `latencyLine()`-formatterer i begge live-scripts
  rapporterer `stt`/`model_ttft`/`tool`/`tts_ttfa`/`e2e_first_audio`/`total_turn`
  per tur - ingen fabrikkerte tall, kun det som faktisk er målt (`-`/`n/a` når et
  tidsstempel mangler, f.eks. `tool` for turer uten verktøykall). Kjente
  host-tall fra runde 2 (funksjonelt PASS, men trege: kalender 8263ms, no-tool
  3633ms, OpenAI 5761ms, Anthropic 4093ms end_of_speech→first_audio) er IKKE
  reoptimalisert i denne runden (eksplisitt utenfor scope: "korrekt baseline
  først").
- **§7 Observability-korrelasjon:** basert på kombinert bevis (IKKE en ny live
  DB-spørring fra voice-gateway-prosessen, som ikke har poolgang til api sin
  Postgres over prosessgrensen) - BO-10/BO-11 har alt live-verifisert
  session_id/provider/kost i `cost_events` + Langfuse; D-30-live-funn-fix-runden
  (denne branchen, commit før denne) testbeviste at `tool.executed`-audit-rader
  er korrekt tenant/session-tagget for BÅDE owner- og cross-tenant-identiteter.
  Ingen rå lyd i noen av disse sporene (strukturelt testbevist fra før).
- **Kvalitet:** 277/277 (273 + 4 nye: provider-feil-før-output, klientdisconnect,
  2× Q-18-repro), lint/typecheck/gitleaks rene. Ingen regresjon: sovereign owner,
  delegert identitet, D-class, Tool Gateway, P1A-fallback, cross-provider
  tool-resume, kalender-tool-bro - alle eksisterende suiter uendret grønne.

**D-30-anbefaling denne runden: fortsatt PARTIAL.** Suite-nivå er komplett og
grønt; de nye host-scriptene (§1/§2/§4) og WS-disconnect-wiringen (§3D) er IKKE
kjørt mot ekte runtime i denne (sky-)økten - kun levert klare til hosten. D-30
kan først settes VERIFIED når: (a) `bo12-voice-live.ts` §1/§2-seksjonen PASSer
live med `barge_in_audio_stop_ms` rapportert, (b) `bo12-voice-soak.ts` fullfører
10/10 live, og (c) Q-18 enten er akseptert som dokumentert kjent begrensning
(ikke en D-30-blokker i seg selv) eller fikset i egen runde.

## BO-11.1 — P1A DELTA-HARDENING (2026-08-14)

**UA-1 P1A forblir VERIFIED.** Kontrollert delta-port oppå BO-11 (ingen redesign):
- **SQL streaming-metrics (§3-§5):** migrasjon `016_cost_events_stream_metrics` (ttft_ms int,
  stream bool default false, tool_calls int default 0) + write-path i ModelGateway (én kostrad per
  modellkall som før). Verifisert mot ekte embedded-PG: gamle inserts overlever m/defaults; ekte
  streaming-kall → SQL-rad m/provider/model/purpose/ttft_ms/stream/tool_calls/kost; P1B-aggregering
  (avg ttft per provider/purpose) SQL-spørrbar. Kompletterer Langfuse - erstatter ikke (§14).
- **SSE-disconnect → upstream abort (§6-§8):** HTTP-klient kobler fra → res-'close' (req-'close'
  fyrer ved fullført body i moderne Node - feil signal) → AbortSignal → ModelGateway.stream →
  provider-abort → normalisert cancelled → delvis svar persistert m/`[avbrutt av bruker]`-markør.
  E2E-bevist mot kjørende http-server + embedded-PG: kansellering skjer upstream (ikke bare
  socket-stopp), ingen health-straff, ingen zombie, neste request OK, nøyaktig ett done-event.
  Barge-in-fundamentet for D-30 er dermed bevist på HTTP-nivå (§8).
- **Executive-handler-paritet (§9-§10):** delt handler (`apps/api/src/executive.ts`) registrert i
  BÅDE api-workeren (main.ts - hadde fortsatt gammel provider-direkte handler uten tools) og
  worker-containeren. Paritetstest: samme durable jobb → semantisk likt resultat, samme
  idempotensnøkkel, mesh (aldri echo) for prompt-jobber, sandbox kun der den finnes.
- **D-class-mesh-regresjon (§11) + SOVEREIGN-FUNN (pre-merge-akseptansen):** D er risikoklasse,
  ikke permission-gate. Funn: `resolveAuthorityMode`/policy-motoren hadde korrekt sovereign-semantikk
  (UA0-AUTHORITY), men **api/worker-wiringen sendte ikke authority-config** → runtime kjørte legacy
  SCOPED og krevde approval for owners D-kall. Fikset: main.ts, worker-main.ts og bo11-live.ts wirer
  nå `authority: {owner_person_id, owner_tenants}` fra env (defaults person-tobias/tenant-personal).
  Begge semantikker bevist mot ekte PG i full mesh-kjede: **OWNER SOVEREIGN** (ingen delegation):
  D-kall uten approval → authority PASS → preflight → execute → readback → before/after-evidens →
  audit. **DELEGERT/SCOPED** (delegation_id - arver aldri owner authority): uten approval →
  deterministisk DENY m/null transport-kall + audit; med gyldig signert approval → ALLOW
  m/preflight+readback; nonce-replay → DENY. Klassifisering D bevart.
- **SSE-fixtures (§12):** provider-uavhengige fixtures - samme logiske utveksling gir IDENTISK
  normalisert event-sekvens fra OpenAI- og Anthropic-SSE; terminal-invarianter (nøyaktig én
  terminal, aldri events etter, complete etter siste delta). **Funn fikset:** Anthropic-adapteren
  ignorerte `error`-events i stream (ble stille suksess) → nå klassifisert server/rate_limit;
  allerede klassifiserte feil beholder klassifisering gjennom stream-catch.
- **Kvalitet:** 247/247 (225 baseline + 22 nye; disconnect-e2e stabil 3×), lint/typecheck/gitleaks
  rene. Kritisk recovery-regresjon (§13/§45: tool utført → provider-død → resume uten dobbel
  utførelse) PASS i suiten.
- **Gjenstår på host (utenfor denne byggerundens miljø - ingen Docker/nøkler):** delta-live-porten
  `node --env-file=.env --experimental-transform-types apps/api/scripts/bo11-1-delta-live.ts`
  (samme Node 24-host-funn som bo12: strip-types feiler på parameter properties; Docker-PG-SQL §5 + live
  SSE-disconnect §7) + live provider-regresjon §13 (re-kjør bo11-live.ts) + §16 runtime-helse.
  BO-11s live-evidens er uendret gyldig; deltaet endrer ikke provider-kontraktene.

## BO-11 — UA-1 P1A STREAMING + TOOL-CALLING = VERIFIED (2026-08-14)

**Arkitektur:** normalisert StreamEvent-kontrakt + provider-nøytral tool-løkke i ModelGateway.
Adaptere (OpenAI/Anthropic) oversetter native SSE/tool-formater; resten av Jarvis ser aldri
provider-format. Tool-utførelse går KUN via trusted mesh-bridge → ToolGateway → Policy/Authority
(§17); P1A eksponerer kun A/B-read-verktøy (read_recent_email/read_calendar_today/read_github_issues).

**Live-evidens (bo11-live.ts i jarvis-api-containeren, ekte OpenAI+Claude):**
- **Streaming (§5-§7):** openai 19 deltas, ttft 1477 ms, rekonstruksjon=MATCH; anthropic ttft 2758 ms,
  MATCH. TTFT spores i result/trace (§8).
- **Cancellation (§9/§46):** begge providere - abort midt i stream → `cancelled`, ingen health-straff,
  ingen zombie-state, neste request OK. (Barge-in-fundamentet for D-30, §28.)
- **Pre-output stream-fallback (§10):** kontrollert timeout på openai → fallback-event
  openai→anthropic(timeout) → Claude fullførte streamen. (Frasering avvek fra ordrett sentinel -
  funksjonelt PASS.) **Post-output (§11):** konservativ policy - stream markeres `stream_interrupted`,
  aldri stille provider-bytte (enhetstestet).
- **Tool calling live (§14-§16):** BEGGE providere → read_github_issues via samme trusted gateway:
  tool_rounds=2, nøyaktig 1 utførelse, korrekt svar. **Multi-tool (§23):** calendar+github i samme
  oppgave: 2 utførelser, syntese 320 tegn (loop-vern: siste runde uten tools tvinger syntese).
- **Cross-provider recovery (§45/§21):** openai døde ETTER utført verktøy → Claude gjenopptok fra
  persistert tool-resultat (tool_exchanges) og svarte - utførelser=1, ALDRI dobbel side-effekt.
- **Idempotens (§19):** sha256-nøkkel per (tenant,task,tool,args); cache + ToolGateway-idempotens.
- **Ukjent verktøy (§26):** TOOL_NOT_FOUND uten utførelse (live). **Ugyldige args (§25):** schema-feil
  → normalisert feil, ingen utførelse, én reparasjonsrunde (enhetstestet).
- **Conversation (§27):** live SSE-chat streamer ekte deltas gjennom normalisert kontrakt
  (`en`/`to`/`tre` + done). **Worker (§29):** durable jobb m/tools=true → mesh-verktøy via samme
  ToolGateway i worker-containeren (tool_rounds=3, resultat persistert).
- **Critic (§30):** får aldri tools (enhetstestet). **Owner override (§38):** manglende capability →
  tydelig `override_capability_missing`-feil (enhetstestet).
- **Kost/trace (§31-§32):** provider-fordelt kost m/failures i cost_events (sess-bo11: anthropic
  21 kall/58 øre, openai 34 kall/20 øre inkl. simulerte feilforsøk med amount 0); ttft/tool_calls i
  Langfuse-metadata. Brief 200-regresjon.
- **Kvalitet:** 225/225 (Node 22; +20 nye: stream-normalisering/-cancel/-feil, tool-normalisering,
  idempotens, fallback-etter-tool, multi-tool, critic-restriksjon, capability-routing, adapter-SSE-
  conformance begge providere, cross-provider tool_exchange-oversetting), lint/typecheck rene.
- **Merknad:** Gemini/Kimi/Ollama-adaptere uendret på complete-path (streaming/tools kan legges til
  senere uten kontraktsendring, §39).

## BO-10 — UA-1 MULTI-PROVIDER LIVE = VERIFIED (2026-08-13)

**Credential:** ANTHROPIC_API_KEY=SET (eier-levert; .env + speilet til Infisical-vault via
universal-auth; injisert i api+worker via env_file; aldri i repo/logg/trace). OPENAI uendret.

**Live-evidens (bo10-live.ts i jarvis-api-containeren, alle kall mot ekte API-er):**
- **Anthropic LIVE:** claude-sonnet-5, tokens 21/20, 1576 ms, finish_reason + provider request id.
- **Owner override (§3):** SPECIFIC_PROVIDER/OWNER_OVERRIDE PASS for både openai og anthropic.
- **AUTO (§4):** 5 purposes; router valgte openai etter policy (LOW_COST/DEFAULT_BALANCED/
  REASONING_REQUIRED) - ingen kunstig trafikkfordeling.
- **Cross-provider fallback (§5): PASS BEGGE RETNINGER.** OpenAI→Claude: kontrollert timeout x2
  (wrapper, ekte nøkler urørt) → anthropic ekte suksess, fallback_from=[openai], mesh.fallback=VERIFIED.
  Claude→OpenAI: tilsvarende med registry-konfigurert kandidatrekkefølge → openai suksess,
  fallback_from=[anthropic]. Feilforsøk + suksess persistert i cost_events; ingen tool-side-effects.
- **Auth (§6):** ugyldig Anthropic-nøkkel → ekte 401 → auth, ingen retry-spam.
- **429 (§7):** simulert på openai → health=RATE_LIMITED m/backoff → anthropic tok kallet.
- **Timeout (§8):** ekte 1 ms-timeout mot Anthropic → timeout-klassifisering; retry-policy (maks 1) + fallback.
- **Multi-provider critic (§9-10): PASS BEGGE VEIER.** openai-primær → anthropic-critic (1064 tegn);
  anthropic-primær → openai-critic (576 tegn). Egen kostrad/trace per critic; critic≠primary bevist.
- **Benchmark (§11):** 5 oppgaver × 2 providere = 10/10 suksess. openai/gpt-4o-mini avg ~1.1 s;
  anthropic/claude-sonnet-5 avg ~3.1 s (høyere kvalitetsklasse, høyere kost: 27 øre vs 14 øre totalt
  i sesjonen). Structured (prompt-JSON): anthropic compliant, openai ikke i denne kjøringen - men
  openai består schema-håndhevet structured output (BO-09-evidens). Ingen «best modell»-konklusjon.
- **Health (§12):** begge LIVE (openai ~1.3 s, anthropic ~4.0 s snitt); DEGRADED/RATE_LIMITED/
  UNAVAILABLE-transisjoner dekket (429-sim live + suiten).
- **Langfuse (§13):** 10 anthropic-observasjoner, 2 critic-traces (critic:openai/critic:anthropic),
  3 fallback-observasjoner m/fallback_from + reason. Secret-scan RENT.
- **cost_events (§14):** per provider: anthropic 13 kall/2 fallbacks/1 critic/2 feilforsøk/27 øre;
  openai 17 kall/1 fallback/1 critic/3 feilforsøk/14 øre. Feilforsøk = amount 0.
- **Regresjon:** brief 200; chat «fire» routed=model; worker-mesh-jobb «Grønn» (gpt-5) - api-workerens
  executive-handler harmonisert med worker-containeren (samme kø, samme kontrakt); max_tokens 1024
  for gpt-5-reasoning. Full stack healthy; D-class/OwnerControls/kill switch PASS i suiten.
- **Kvalitet:** 205/205 (Node 22), lint/typecheck/gitleaks rene.

**UA-1 MULTI-PROVIDER LIVE = VERIFIED.**

## BO-09 AI MESH LIVE-VALIDERING (2026-08-13)

**Secret discovery (kun presence):** OPENAI_API_KEY=SET (host). ANTHROPIC_API_KEY/GEMINI_API_KEY/
KIMI_API_KEY/MOONSHOT_API_KEY/JARVIS_OLLAMA_URL = **MISSING** i både .env, host-env og Infisical-vault
(sjekket via InfisicalSecretProvider, vault healthy). Ollama ikke installert (port 11434 død).
→ **UA-1 MULTI-PROVIDER LIVE = BLOCKED_BY_CREDENTIALS** (ærlig per §30; arkitektur forblir READY).

**Live-verifisert i container-runtime (bo9-live.ts i jarvis-api):**
- **AUTO-routing (§9):** 5 purposes → openai (eneste live) med korrekte reasons:
  QUICK_CLASSIFICATION→LOW_COST, SUMMARIZE→ONLY_AVAILABLE, CODE/REASON/PLAN→REASONING_REQUIRED;
  latency 1.0-2.5 s, kost 1 øre/kall i cost_events.
- **Owner override (§8):** SPECIFIC_PROVIDER/OWNER_OVERRIDE PASS.
- **Structured output live (§7C):** json_schema → parsed {"verdict":"ja"} PASS.
- **Critic/second opinion (§15-16):** live critic-run (single-provider: openai kritiserer openai -
  multi-provider critic venter på credential), critique 644 tegn, egen kostrad, status critic=VERIFIED.
- **Auth (§12):** ugyldig nøkkel mot ekte endepunkt → 401 → ProviderError(auth), ingen retry-spam.
- **Timeout (§14):** 1 ms-timeout mot ekte endepunkt → ProviderError(timeout).
- **429 (§13):** IKKE fremprovosert live (bevisst); RATE_LIMITED/backoff/fallback dekket i suiten.
- **Kvalitetssignal-korrelasjon (§19):** cost_events grupperer purpose×provider×model med
  calls/avg_ms/sum_ore/failures/critic_calls - grunnlag for senere quality-routing, ingen læring aktivert.
- **Worker-mesh (§22):** executive-jobb m/prompt gjennom durable kø i worker-container →
  ModelGateway purpose-routing → svar "42" (openai:gpt-5) med provider/tokens i result. Worker er
  ikke bundet til én provider.
- **Conversation (§21):** live /chat i container → "Oslo", routed=model, Langfuse-observasjon
  CHAT:DEFAULT_BALANCED. Ingen direkte provider-avhengighet i Conversation Engine.
- **Brief (§20):** 200, 6839 tegn, 0 source_errors, ingen Telegram-spam.
- **Fix underveis:** OpenAI-adapteren sendte legacy `max_tokens` → 400 på gpt-5; byttet til
  `max_completion_tokens` (gjelder alle chat-modeller). Verifisert live med gpt-5 og gpt-4o-mini.
- **Trace-sink:** api+worker bruker nå `traceSinkFromEnv` (Langfuse når konfigurert, ellers JSONL).
- **/status (§25):** evidensbasert: fallback=LOGIC_ONLY (<2 reelle providere), critic=VERIFIED
  etter faktisk run; VERIFIED for fallback settes først ved ekte cross-provider fallback.
- **Sikkerhet (§26):** audit_events/cost_events/Langfuse credential-scans = 0 treff; image uten .env;
  gitleaks rent. **Benchmark (§17): N/A** (krever ≥2 live cloud-providere).
- **Kvalitet:** 205/205 (Node 22; +2 evidensstatus-tester), lint/typecheck rene.

## BO-08 UA-1 P0 — UNIVERSAL AI MESH (2026-08-13)

**Arkitektur:** ModelGateway → AiRouter (deterministisk/scoret, aldri LLM-for-å-velge-LLM) →
ProviderAdapter → normalisert respons → cost_events + Langfuse. Modellvalg skjer KUN i trusted
gateway-lag (§35). Kontrakter i `@jarvis/contracts` (purpose/mode/reason), registry/health/pricing/
router i `modules/model-gateway`, adaptere i `packages/provider-adapters`.

- **Providere:** OpenAI **LIVE (baseline)**; Anthropic/Claude, Gemini, Kimi (Moonshot,
  OpenAI-kompatibelt API), Ollama = **IMPLEMENTED_NOT_LIVE** (adapter + conformance-tester;
  mangler kun credential/endepunkt: ANTHROPIC_API_KEY, GEMINI_API_KEY, KIMI_API_KEY/MOONSHOT_API_KEY,
  JARVIS_OLLAMA_URL). Ingen fake LIVE-status: health = CONFIGURED til første faktiske suksess.
- **Routing-modes:** AUTO/FAST/QUALITY/CHEAP/LOCAL/SPECIFIC_PROVIDER/CRITIC. Owner-override (§10):
  eksakt provider, ingen stille fallback. LOCAL uten lokal modell → tydelig feil, aldri sky (§26).
- **Fallback (§12):** klassifiserte feil (auth/rate_limit/timeout/server/network/invalid_response/
  bad_request); auth = aldri retry-spam; transient = maks én retry samme provider; deretter neste
  kandidat. Feilforsøk logges som egne cost_events-rader (amount 0, kind model:failed:<kind>).
  Ingen doble tool-side-effects: AI-generering og tool-execution er fortsatt separert (Tool/Policy).
- **Cost (§14):** migrasjon 015 (purpose/success/fallback/critic/latency_ms på cost_events);
  versjonert pricing-tabell (2026-08.1) med cached-token-rabatt; critic har egen kostrad.
- **Critic (§18):** opt-in only (critic:true / mode CRITIC), foretrekker annen provider, feil i critic
  velter aldri primærsvar, ikke koblet til D-class.
- **LIVE-akseptanse i container-runtime (§45):** `mesh-live.ts` i jarvis-api-containeren →
  routed openai:gpt-4o-mini, cost_event {purpose:QUICK_CLASSIFICATION, success:true, fallback:false,
  latency_ms:851, 1 øre}, Langfuse-observasjon med metadata {router_mode:AUTO, routing_reason:LOW_COST,
  purpose} (secret-scan RENT). Fix underveis: span-create manglet body.id - observasjoner ble aldri
  opprettet før BO-08; nå verifisert.
- **LIVE multi-provider fallback/benchmark: NOT YET VERIFIED** (kun én cloud-provider har credential;
  logikken er verifisert via kontrollerte fake-adaptere i suiten, §29).
- **Tester:** 203/203 (Node 22) - 73 nye (router-eval §27, adapter-conformance §28 med full feilmatrise,
  fallback/critic/kost/health/registry/pricing). /status + /ai viser mesh-status (ingen secrets).
- **Regresjon:** brief 200 (0 source_errors, live-kilder), full stack healthy, D-class/OwnerControls/
  kill switch dekket i suiten, gitleaks rent.

## BO-07 LIVE-EVIDENS (2026-08-13)
- **D-27 Langfuse: VERIFIED.** langfuse/langfuse:2 i compose (headless init via .env, restart:unless-stopped,
  Postgres-avhengig, health OK v2.95.11). Ekte OpenAI-kall → trace i Langfuse (navn openai:gpt-4o-mini,
  userId=tenant, sessionId, metadata.task_id/cost_ore), korrelert med cost_events (2 øre). Redaction:
  sentinel + credential-mønstre = IKKE i trace (sentinel_leak=false, key_leak=false). Outage: Langfuse
  stoppet → core model-call lykkes fortsatt (DEGRADED, ikke krasj) → restart → health OK.
- **FULL STACK (OPS): VERIFIED.** Ett image (infra/local/api.Dockerfile, hele workspacet, --prod,
  ingen .env i image - bekreftet med ls i container). Tjenester: postgres(healthcheck) → migrate
  (one-shot, service_completed_successfully, `{"msg":"migrations_complete"}`, 14 migrasjoner) →
  api(healthy, /health 200) + worker (egen container, drenerer durable kø; sandbox-jobb fullført:
  `container-worker-ok`, process-sandbox i container - Docker-sandbox gjelder host, D-32) + langfuse +
  infisical(+redis). **Live fra container-runtime:** gmail/calendar/github read = ALLOW i audit,
  scheduler-catch-up leverte dagens brief til Telegram (2 chunks, audit 17:47:42Z) - nøyaktig én.
  **Restart-test:** compose restart → alt healthy, ingen duplikat-brief. **Down/up (uten -v):** data
  persistert (tasks=6, telegram-audit=2, migrasjoner=14). **Failure-injection:** A postgres-stopp →
  api /health 200 under utfall, brief 200 etter recovery; B crash-restart-policy bevist (testcontainer
  exit 1 → restarts=5; docker kill/stop regnes som brukerstopp og trigges ikke - dokumentert semantikk);
  C langfuse-utfall → api 200; D infisical-utfall → api 200 (+ env-fallback); E api-restart → 200.
  **Host-readiness:** Docker Desktop AutoStart=true satt; restart:unless-stopped bevist i praksis
  (containere kom selv opp etter dagens daemon-krasj). Status: HOST_REBOOT_READY_NOT_PHYSICALLY_TESTED.
  **Sikkerhet:** image uten .env; audit/cost-tabeller scannet for credential-mønstre = 0; gitleaks 59
  commits = no leaks; 130/130 tester (Node 22), typecheck+lint rene. **Merk (bootstrap):** owner-seed
  (tenants/people/devices/memory_spaces for person-tobias/jarvis-core) er idempotent SQL utenfor
  migrasjonene - kjøres én gang per fersk database.
- **UA-0 KJERNEBESLUTNING: CORE RUNTIME READY.** D-27/D-28/D-32/D-35/OPS/scheduler = VERIFIED i
  Docker-runtime. D-30 (Voice), D-36 (Apple), HA-RUNTIME blokkerer ikke UA-0 og står som egne porter.
- **D-35 Infisical: VERIFIED.** infisical/infisical:latest-postgres + redis:7 i compose (egen db `infisical`
  i Docker-PG, restart:unless-stopped, health Ok). Headless bootstrap via `/api/v1/admin/bootstrap`
  (admin + org + maskinidentitet, ingen UI-steg). Prosjekt `jarvis` + universal-auth clientId/clientSecret
  opprettet via API (kun i .env, aldri i repo). InfisicalSecretProvider (universal-auth login → v3 raw
  secrets, fail-closed): testsecret JARVIS_VAULT_TEST hentet = PASS. **Pilot-migrering:** JARVIS_GITHUB_TOKEN
  lagt i vault → FallbackSecretProvider(inf→env) hentet fra vault (MATCH mot .env) → live GitHub-kall med
  vault-verdien = 200 PASS. **Outage:** infisical stoppet → fallback ga env-verdi (MATCH), health=unavailable
  (fail-closed, ingen krasj) → restart → recovery PASS (health=healthy). .env beholdt som fallback/rollback.
- **D-32 DockerSandboxRunner: VERIFIED.** Koblet i ekte durable-kø (enqueue→lease→worker→
  DockerSandboxRunner→container→resultat). Isolasjon: non-root node, --network none, --memory 256m,
  --pids-limit 128, /work-mount, INGEN Jarvis/OpenAI/token-env (0 treff). Acceptance=completed;
  crash/reclaim=completed (A leaset+krasjet, B reclaimet, attempts=2, resultat én gang); timeout=failed;
  cancellation=cancelled; failed-command(exit3)=failed; result-persistens PASS over Postgres-restart.
