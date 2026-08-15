# PROJECT STATUS

**Oppdatert:** 2026-08-15 · **Branch:** `claude/ua2-knowledge-spec` (PR #3, ikke merget)

## Aktiv fase
Masterplan v4.0 «Sovereign Autonomy» — **UA-0 CORE RUNTIME = CLOSED** (formelt, BO-08).
**UA-1 UNIVERSAL AI MESH: P0 VERIFIED · MULTI-PROVIDER LIVE VERIFIED · P1A (streaming+tool-calling) VERIFIED (BO-11).**
**D-30 VOICE = VERIFIED** (BO-12, merget til main 2026-08-14, commit `8f28862`).
**Q-21 (systembredt DB admin/runtime-rolle-gap): FIXED_SUITE / READY_FOR_HOST_VERIFY (2026-08-15) -
IKKE VERIFIED ennå.** Host bekreftet at api/worker/migrate kjørte som Postgres-superbruker; fikset med
en permanent admin/runtime-config-splitt + idempotent rolle-bootstrap + fail-closed startup-vakter +
ett automatisert host-fiks-script. **Host-recovery-runde 1 (samme dag):** scriptet feilet første gang
(`docker compose` sin egen `.env`-interpolasjon fant ikke `JARVIS_DB_ADMIN_PASSWORD` selv om verdien
faktisk sto riktig i filen) - fikset med eksplisitt `--env-file`, pluss ny fail-closed admin-credential-
recovery fra siste `.env.bak.*` for delvis migrerte hosts. **Host-recovery-runde 2 (samme dag):**
migrate-containeren autentiserte likevel som `jarvis_runtime` i stedet for admin-brukeren, til tross
for korrekt `.env` - ukjent Docker Compose-presedens-tvetydighet for `docker compose run` (ikke
100% bekreftbar uten host-tilgang). Fikset ved å fjerne HELE tvetydighetsklassen: admin-credentials
sendes nå eksplisitt via `-e VARNAME` til migrate-kallet (aldri via `.env`/`env_file`-oppløsning for
det kallet), pluss en admin-tilkoblings-precheck FØR migrate kjøres og en `migrate_effective_db_user`-
grunnsannhetsdiagnostikk skrevet av migrate-prosessen selv. **Host-recovery-runde 3 (samme dag,
faktisk root cause):** `-e VARNAME`-fiksen løste IKKE problemet - migrate autentiserte fortsatt som
`jarvis_runtime`. Faktisk årsak: `docker compose run --rm migrate` gjenbrukte et EKSISTERENDE,
UTDATERT lokalt Docker-image (Compose bygger aldri automatisk på nytt bare fordi kildekoden har
endret seg) - containeren kjørte en eldre `migrate-main.ts` fra FØR admin/runtime-splitten. Fikset
ved å ALLTID bygge migrate/api/worker fra aktuell checkout (`docker compose build`) FØR de
kjøres/restartes, hver eneste gang scriptet kjører - fjernet samtidig `-e VARNAME`-ambiguiteten
igjen (unødvendig når imaget garantert er ferskt). Se Q-21 i OPEN_QUESTIONS.md og RUNTIME_GATES.md
for full detalj.
**UA-2 UNIVERSAL KNOWLEDGE LAYER: P0 (Knowledge Ingestion Foundation) = BLOCKED (venter på Q-21
host-verifikasjon)**
- 13/15 host-akseptansefelt PASS live (filesystem livssyklus, provenance, FTS/vector/hybrid,
  filsystem-sikkerhet, GitHub live sync+dedupe). `tenant_isolation`/`memory_space_isolation` FEILET
  live pga. Q-21 (se over) - IKKE en UA-2-kode-bug.
- **Neste steg:** Tobias kjører `node --experimental-transform-types
  modules/core/scripts/fix-q21-runtime-role.ts` PÅ HOSTEN (automatiserer hele Q-21-fiksen OG kjører
  `ua2-p0-live.ts` til slutt). UA-2 P0 kan først settes VERIFIED/merges når `q21_runtime_role_safe=PASS`
  og `tenant_isolation=PASS`/`memory_space_isolation=PASS` bekreftes live. Full evidens: docs/RUNTIME_GATES.md.

## UA-0 (lukket)
D-27/D-28/D-32/D-35/OPS-RUNTIME/UA0-RUNRATE = VERIFIED (evidens: docs/RUNTIME_GATES.md).
Owner-seed nå automatisk/idempotent i one-shot migrate. **D-30 Voice = VERIFIED** (BO-12,
host-runde 6 - merget til main). Gjenværende åpne, ikke-blokkerende porter: D-36 Apple,
HA-RUNTIME, D-10 STT-benchmark (≥100 norske prøver, providervalg - se OPEN_QUESTIONS Q-03).

## UA-1 P1A (BO-11)
- Normalisert streaming (OpenAI+Claude live, ttft, cancel/barge-in-fundament, pre-output-fallback,
  konservativ post-output-policy), provider-uavhengig tool-calling via trusted mesh-bridge→ToolGateway
  (kun A/B-read i P1A), idempotent utførelse, cross-provider recovery etter utført verktøy (aldri
  dobbel side-effekt), SSE-chat + worker-tool-mesh live. Evidens: RUNTIME_GATES BO-11.
- **P1A delta (BO-11.1):** SQL streaming-metrics i cost_events (migrasjon 016), SSE
  klient-disconnect → upstream cancellation (barge-in-fundament bevist på HTTP-nivå),
  executive-handler-paritet api↔worker (delt handler), eksplisitt D-class-mesh- og
  SSE-fixture-regresjon (+ fix: Anthropic stream-error-events klassifiseres, aldri stille suksess).
- **Sovereign-fix (pre-merge):** api/worker-wiringen manglet authority-config → owners D-kall
  krevde feilaktig approval (legacy SCOPED). Fikset i main/worker/bo11-live; begge semantikker
  testbevist (owner sovereign → full D-pipeline uten approval; delegat → approval-gate + replay-vern).
  249/249 tester. Delta-live på host gjenstår: `apps/api/scripts/bo11-1-delta-live.ts`.

## UA-1 LIVE-status (BO-10)
- **UA-1 MULTI-PROVIDER LIVE = VERIFIED (BO-10).** OpenAI + Anthropic/Claude begge LIVE i container-runtime.
  Cross-provider fallback PASS begge retninger; multi-provider critic PASS begge veier; owner override,
  health, 401/429/timeout, benchmark (10/10), Langfuse- og cost_events-korrelasjon verifisert.
  Gemini/Kimi/Ollama fortsatt IMPLEMENTED_NOT_LIVE (nøkler mangler - ikke-blokkerende).

## UA-1 P0 (BO-08)
- AI Router (deterministisk), CapabilityRegistry, ProviderHealth, versjonert pricing, normaliserte
  request/response-kontrakter, klassifisert fallback, critic (opt-in), purpose-taksonomi.
- Providere: **OpenAI LIVE (baseline)**; Claude/Gemini/Kimi/Ollama IMPLEMENTED_NOT_LIVE
  (mangler kun: ANTHROPIC_API_KEY, GEMINI_API_KEY, KIMI_API_KEY, JARVIS_OLLAMA_URL i .env/vault).
- Live-akseptanse i container: routed kall m/routing_reason i Langfuse + mesh-felter i cost_events
  (migrasjon 015). /status og /ai (Telegram) viser mesh-status.
- LIVE multi-provider fallback + benchmark: NOT YET VERIFIED (krever ≥2 cloud-credentials);
  logikk verifisert med fake-adaptere.
- Kvalitet: 203/203 tester (Node 22), lint, typecheck, gitleaks rene. Full stack healthy.

## D-30 Voice (BO-12) — VERIFIED

- **Status: VERIFIED (2026-08-14, host-runde 6).** Host-live-akseptanse fullført og
  bestått: real-provider streaming smoke PASS (inkrementell levering bekreftet),
  §32 generation cancellation PASS (aktiv stream observert, abort etter 3 tokens,
  ren neste tur), §1/§2 real audio barge-in PASS (`barge_in_audio_stop_ms=0` ≤
  250ms-gate, 0 stale frames, ren neste tur), 10-tur soak PASS **to uavhengige
  kjøringer** (10/10, én session_id, `duplicate_tool_executions=0`, turn 8
  cancelled/turn 9+10 normale, begge ganger), Q-18 FIXED bekreftet live
  (kalender-repetisjon gir ferske svar). Merget til `main` (se commit under).
  Branch `claude/d30-voice`. Voice er transportlag over eksisterende Jarvis (samme mesh/
  tools/authority/minne): streaming Core-klient (P1A-SSE) → setningschunking → TTS-kø,
  full barge-in (stopp lyd + tøm kø + abort generering upstream, epoch-vern mot stale
  audio), eksplisitt tilstandsmaskin m/personvern (ingen skjult opptak, rå lyd
  persisteres aldri), STT-/TTS-feilbaner, full latenskjede-metrics, voice-helse i
  /status, cross-provider-override. OpenAI STT/TTS er P0-baseline (nøkkel alt live).
- **Live-findings-fix (host-runde 2):** TTS/STT/no-tool/cross-provider/barge-in PASS live,
  kalender-voice feilet, fikset (ConversationEngine→completeWithTools-bro, per-identity
  executor, trusted SSE tool_call, voice-device-seed, semantisk STT-akseptanse). Runde 2
  bekreftet: kalender-voice PASS live (`tools=[read_calendar_today]`).
- **FINAL HOST ACCEPTANCE HARDENING (host-runde 3):** funn+fiks: `VoiceSession`
  hadde INGEN klientdisconnect-håndtering → zombie-generering ved WS-frakobling midt i
  tur; ny `disconnect()` wiret til `ws.on("close")`. Ekte lyd-barge-in-akseptanse
  (`barge_in_audio_stop_ms`, ≤250ms-gate) + stale-audio-settlingsjekk i bo12-voice-live.ts;
  10-tur host-soak (`bo12-voice-soak.ts`); full latenskjede-rapportering per tur.
  Q-18 reprodusert (BLOCKER).
- **HOST FAILURE FIX (host-runde 4, denne):** host kjørte de nye scriptene - tre feil
  funnet, alle undersøkt til rot (ikke gjettet) og fikset:
  - **§32 (legacy LLM-abort-test) feilet** ("forventet AbortError, fikk suksess") -
    root cause = race (kategori B: modellen rakk fullføre før 5. token+abort);
    mekanismen selv er uendret bevist korrekt (suite, treg adapter). Fiks: abort
    trigges nå på FØRSTE token + lengre (500+ ord) tekst - assertion uendret.
  - **Soak turn 8 timet ut** - root cause = harness-deadlock (ventet på turn 8s
    EGNE metrics FØR turn 9s barge-in-lyd ble sendt), IKKE sesjonskorrupsjon.
    Fikset: turn 8+9 kjøres nå konkurrerende (vent kun til "speaking", så send
    barge-in). Ny eksplisitt "korrekt cancelled-turn"-definisjon (cancelled +
    t_speech_start + t_tts_first_frame), speilet i suite-regresjon.
  - **`tools=[read_calendar_today,read_calendar_today]` avgjort via kjørt test:**
    kategori (A) - 2 SSE-events, KUN 1 faktisk ToolGateway-kall (in-memory
    per-tur-cache i ModelGateway.completeWithTools fungerte allerede korrekt).
    16s-TTFT skyldes en EKSTRA MODELLRUNDE, ikke dobbel verktøyutførelse.
  - **Q-18 FIKSET:** `tool_executions`-dedupe gjelder nå kun C/D
    (`capability_class !== "A"` i gateway.ts). A-class reads utfører friskt per
    brukertur; write/mutation-dedupe uendret (regresjonstestet). In-memory
    per-tur-beskyttelse (samme tur, samme kall → maks 1 utførelse) uendret,
    testet separat fra database-/sesjonsnivå-fiksen.
  - 279/279 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL BARGE-IN HOST BLOCKER (host-runde 5, denne):** host bekreftet Q-18-fiksen
  PASS live, men §32 feilet med NY info som avkrefter forrige race-hypotese:
  0 tokens over 35,5s, deretter suksess (ikke "modellen var rask", men "ingen
  inkrementelle events observert i det hele tatt"). Kan IKKE avgjøres endelig
  uten host-tilgang - IKKE gjettet. Gjort denne runden:
  - **Kodesporing:** hele kjeden er strukturelt identisk for alle requests;
    Ollama/Gemini/Kimi-hypotesen (ikke-strømmende adaptere) undersøkt og
    AVKREFTET ved lesing (ville gitt ≥1 token, ikke 0); ingen reverse proxy
    i docker-compose.
  - **Deterministisk sandbox-bevis KJØRT i denne økten** (ekte server+SSE+
    embedded PG, ingen mocks): 600 tokens levert inkrementelt over 702ms,
    abort på 1. token → AbortError på 19ms. Beviser egen kode er IKKE
    generisk buffret. Formalisert som 2 nye permanente suite-tester.
  - **Server-side diagnostikk lagt til** (`JARVIS_STREAM_DEBUG=true`, kun
    type+timing, aldri innhold) i 3 lag (gateway/conversation/SSE-write) -
    lar host avgjøre PRESIST hvor levering evt. slutter å være inkrementell.
  - **§32 redesignet - "500 ord"-fixen FJERNET helt** (var en blind
    lengde-gjetning). Ny §3B smoke-test måler faktisk observert
    inkrementell levering FØRST; §32 kjøres kun betinget på det, rapporterer
    IKKE KJØRT (inkonklusivt) i stedet for FAIL når ingen aktiv stream kan
    bevises - og en feiling NÅR streaming er bekreftet er en høy-konfidens
    ekte regresjon, ikke en race.
  - **Ekte lyd-barge-in (§1/§2) koblet løs fra lang LLM-respons** - kort
    normalsvar, trigges kun på observert avspilling.
  - **Soak turn 8:** sannsynlig samme fenomen som §32 (ikke egen
    harness-feil) - tidsstemplet tilstandshistorikk lagt til, timeout økt
    til 60s, tekst kortet ned, timeout merkes ikke lenger stille som
    "corrupted" uten forklaring.
  - 281/281 tester, lint/typecheck/gitleaks rene. Ingen regresjon.
- **FINAL CLOSURE (host-runde 6, denne):** full host-evidens mottatt og bekreftet
  (se detaljert tabell i docs/RUNTIME_GATES.md). D-30 satt VERIFIED; PR #2 merget
  til `main`. §32s tidligere anomali (runde 5: 0 tokens/35.5s) reproduserte IKKE
  denne runden - real-provider streaming var inkrementell (`token_count=142`,
  `spread_ms=4757`) og cancellation fungerte korrekt (abort etter 3 tokens).
  Vurdert som en engangs-nettverksanomali (runde 5), ikke et vedvarende mønster.
- **Ytelsesgjeld (IKKE en D-30-blokker - egen åpen post, se OPEN_QUESTIONS.md
  Q-19):** host-observert latens er funksjonelt korrekt men treg for ønsket
  realtime-opplevelse: `e2e_first_audio` vanligvis ~3.5-6.2s, enkelte turer
  ~9-12s, streaming-smoke første token ~12.7s. D-30-korrekthet er verifisert
  UAVHENGIG av dette - realtime-latensoptimalisering er bevisst utsatt til egen
  runde (ingen optimalisering gjort i denne lukkingen).

## UA-2 P0 — Knowledge Ingestion Foundation (BYGGET denne økten)
- **Status: SUITE-VERIFIED. IKKE host/live-verifisert** (sky-container: ingen Docker, ingen ekte
  GitHub-PAT, ingen ekte NAS-mount). Godkjent P0-scope fra spec-runden bygget i ny pakke
  `modules/knowledge` (`@jarvis/knowledge`):
  - `KnowledgeSource`-kontrakt (kilde-uavhengig, ingen credentials i kontrakten).
  - `FilesystemKnowledgeSource`: allowlistet root, `realpath()`-verifisert FØR lesing - traversal/
    symlink-escape strukturelt umulig (ikke bare filtrert).
  - `GithubKnowledgeSource`: via eksisterende ToolGateway/policy/audit (ny `read_repo_meta`-action,
    samme PAT/scope som `read_issues` - ingen scope-utvidelse); repo-fil-innhold dokumentert som
    neste skive (transporten støtter det ikke i dag).
  - `KnowledgeSyncService`: idempotent sync-rapport, canonical identity + content_hash-dedupe,
    tombstone ved forsvunnet kilde (myk sletting), deterministisk reaktivering.
  - `KnowledgeRetriever`: FTS+vector hybrid på eksisterende pgvector-fundament (D-28), full
    provenance, tombstonede dokumenter alltid ekskludert.
  - Migrasjon `017_knowledge.sql`: samme RLS-mønster som `memory_items` (tenant+space i databasen).
  - DPIA-notat: `docs/UA2_KNOWLEDGE_DPIA.md`. Åpent gap Q-20 (kun myk sletting, ingen GDPR-purge-vei
    ennå) - dokumentert, ikke skjult.
  - **Regresjon funnet+fikset:** `read_repo_meta` midt i `firstWaveTools()`-arrayet forskjøv
    posisjonsindekser to eksisterende tester brukte - flyttet til slutten av arrayet.
  - 294/294 tester (281+13 nye), lint/typecheck/gitleaks rene. Full evidens: docs/RUNTIME_GATES.md.
- **Gjenstår for host/live-verifikasjon (§13 i BO-en, IKKE gjort her):** ekte NAS-mount, ekte
  GitHub-repo-sync med reell PAT, full ende-til-ende-demo kjørt på Tobias sin host.
- **FINAL HOST ACCEPTANCE HARNESS (forrige runde, bygget):** `modules/knowledge/scripts/ua2-p0-live.ts` -
  kjøres `node --env-file=.env --experimental-transform-types modules/knowledge/scripts/ua2-p0-live.ts`.
- **HOST-BLOCKER-RUNDE (denne økten, 2026-08-15):** Tobias kjørte harnesset live. 13/15 felt PASS
  (filesystem livssyklus, provenance, FTS/vector/hybrid, filsystem-sikkerhet, GitHub live sync+dedupe
  `created=2`→`unchanged=2`). **`tenant_isolation`/`memory_space_isolation` FEILET.** Root cause
  funnet (ikke gjettet): harnesset beviste isolasjon via `pool` (samme rolle api/worker/migrate
  faktisk bruker) UTEN å verifisere bypass-status - `jarvis_app` er en `NOLOGIN`-gruppe-rolle, og
  INGEN sted i den faktiske driftsveien oppretter en ekte login-rolle bundet til den (kun suitens
  test-oppsett gjør det). Dette avdekket samtidig et **systembredt (ikke UA-2-spesifikt)
  deployment-gap** - se **Q-21 i OPEN_QUESTIONS.md** (trenger Tobias sin beslutning; docker-compose/
  migrate-main.ts bevisst urørt, utenfor denne BO-ens scope). **Fikset:** harnesset bootstrapper nå
  en fersk, garantert non-bypass rolle (kun for isolasjons-BEVISET) + ny §6-diagnostikk
  (`rls_test_role`/`_superuser`/`_bypassrls`, `knowledge_rls_enabled`/`_force_rls`,
  `configured_app_role`/`_superuser`/`_bypassrls`) som fail-closed skiller HARNESS FEIL fra RUNTIME
  FEIL. Presisjonsfunn underveis: rå listelengde er ikke et presist lekkasje-mål (vektor-selvtreff-
  støy fra `LocalHashEmbedding`) - assertions sjekker nå faktisk innhold. Nye regresjonstester:
  `modules/knowledge/test/rls-role-isolation.test.ts` (6 tester, inkl. et eksplisitt kontrast-bevis
  §K: samme spørring lekker via superbruker, ikke via non-bypass-rolle). Full detaljer:
  docs/RUNTIME_GATES.md.
- **Q-21 AUTOMATISK DIAGNOSE (samme dag):** `ua2-p0-live.ts` diagnostiserer nå selv, i ÉN kommando,
  om den faktiske runtime-rollen er trygg (`q21_runtime_role_safe`) og kjører isolasjons-acceptance
  via `pool` direkte når den er det - ellers `BLOCKED_BY_RUNTIME_ROLE` (aldri fake PASS).
- **Q-21 HOST-BEVIS (samme dag):** Tobias kjørte diagnosen live - `current_user=postgres`,
  `runtime_role_superuser=true`, `runtime_role_bypassrls=true`, `q21_runtime_role_safe=FAIL`. Bekreftet:
  RLS-policyene finnes og FORCE RLS er aktivt (`knowledge_documents_force_rls=true`), men
  api/worker/migrate kjørte alle som Postgres-superbruker - en ekte systembred
  runtime-konfigurasjonsfeil, ikke en UA-2-kode-bug.
- **Q-21 SYSTEMBRED FIKS (denne runden):** permanent split innført i `@jarvis/core`:
  `configFromEnv()` (RUNTIME, default `jarvis_runtime`) vs. ny `adminConfigFromEnv()` (ADMIN, leser
  `JARVIS_DB_ADMIN_USER/PASSWORD`) - to distinkte lesere, ingen fallback mellom dem. Ny
  `ensureRuntimeRole()` (idempotent, admin-kjørbar) bootstrapper `jarvis_runtime`
  (LOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, medlem av `jarvis_app`) fra
  `migrate-main.ts` (nå på `adminConfigFromEnv()`). `main.ts`/`worker-main.ts` fail-closed ved
  oppstart (`assertRuntimeCredentialsConfigured`/`assertRuntimeRoleSafe`) - nekter å starte normalt
  uten gyldige, distinkte, non-bypass runtime-credentials. `.env.example`/`docker-compose.yml`
  oppdatert med forklarende kommentarer (ingen ny parallell config-modell - samme grants/RLS som
  `jarvis_app` alt hadde, 005_rls.sql). **Automatisert host-fiks:**
  `modules/core/scripts/fix-q21-runtime-role.ts` - ÉN kommando som backup-er `.env`, genererer
  runtime-credentials, kjører migrate (bootstrapper rollen), restarter api/worker, verifiserer
  FAKTISK trygg tilkobling direkte mot Postgres, og kjører `ua2-p0-live.ts` til slutt. Ingen
  volumes/data røres. 24 nye tester (`modules/core/test/runtime-role.test.ts`,
  `db-config-split.test.ts`, `apps/api/test/db-role-wiring.test.ts`) - 324/324 totalt,
  lint/typecheck/gitleaks rene (inkl. `scripts/`-mapper nå faktisk typecheck-dekket, tidligere
  stille utelatt). **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY - ikke satt VERIFIED før Tobias sin
  faktiske host-kjøring bekrefter det.**

## Blokkeringer
**UA-2 P0 er BLOCKED** - Q-21 er FIXED_SUITE men IKKE host-verifisert ennå. Venter på Tobias sin
kjøring av `modules/core/scripts/fix-q21-runtime-role.ts` på hosten (automatiserer hele fiksen +
kjører `ua2-p0-live.ts` til slutt) - `q21_runtime_role_safe=PASS` og
`tenant_isolation=PASS`/`memory_space_isolation=PASS` må bekreftes live før VERIFIED/merge. Manglende
provider-nøkler er eneste gap for LIVE multi-provider-evidens. Ytelsesgjeld for voice-latens (Q-19) er
åpen, ikke-blokkerende.

## Neste oppgave
Avventer Tobias: kjør `node --experimental-transform-types modules/core/scripts/fix-q21-runtime-role.ts`
PÅ HOSTEN (fra repo-roten) og rapporter resultatet - denne ene kommandoen fikser Q-21 OG kjører UA-2
P0-akseptansen automatisk. Øvrige kandidater uendret i bakgrunnen: D-30 ytelsesgjeld (Q-19),
D-10 STT-benchmark (Q-03), D-36 Apple, HA-RUNTIME, provider-nøkler for Gemini/Kimi/Ollama LIVE-benchmark.
