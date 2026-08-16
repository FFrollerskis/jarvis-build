# PROJECT STATUS

**Oppdatert:** 2026-08-16 (Q-20 final closure) · **Branch:** `claude/q20-data-erasure` (PR #4, merges
til `main`)

## Aktiv fase
Masterplan v4.0 «Sovereign Autonomy» — **UA-0 CORE RUNTIME = CLOSED** (formelt, BO-08).
**UA-1 UNIVERSAL AI MESH: P0 VERIFIED · MULTI-PROVIDER LIVE VERIFIED · P1A (streaming+tool-calling) VERIFIED (BO-11).**
**D-30 VOICE = VERIFIED** (BO-12, merget til main 2026-08-14, commit `8f28862`).
**Q-21 (systembredt DB admin/runtime-rolle-gap): VERIFIED/CLOSED (2026-08-15, host-bevist,
run_id `778bb87d`)** → D-38. Host bekreftet at api/worker/migrate opprinnelig kjørte som
Postgres-superbruker (RLS aldri håndhevet til tross for korrekte policyer); fikset permanent med
admin/runtime-DB-config-splitt + idempotent `jarvis_runtime`-rolle-bootstrap + fail-closed
startup-vakter + ett automatisert host-fiks-script (tre host-recovery-runder samme dag - se
RUNTIME_GATES.md for full feilsøkingslogg; faktisk root cause var et stale Docker-image som ble
gjenbrukt av `docker compose run` i stedet for å bygges på nytt). **Host-bevis:**
`migrate_effective_db_user=postgres`, `runtime_current_user=jarvis_runtime`,
`runtime_role_superuser=false`, `runtime_role_bypassrls=false`, `runtime_role_canlogin=true`,
`runtime_role_member_jarvis_app=true`, `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
`memory_space_isolation=PASS`.
**UA-2 UNIVERSAL KNOWLEDGE LAYER: P0 (Knowledge Ingestion Foundation) = VERIFIED/COMPLETE
(2026-08-15, samme host-kjøring)** → D-39. Alle P0-akseptansekriterier host-bevist mot ekte
Postgres/pgvector, ekte filsystem, ekte GitHub-repo: filesystem full livssyklus, ekte FTS/vector/
hybrid, filsystem-sikkerhet (allowlist/traversal), GitHub live sync+dedupe, tenant/memory-space-
isolasjon - alle PASS, `duplicate_documents=0`, `hard_fail=false`. `symlink_escape=
SKIPPED_HOST_PERMISSION` (Windows-hosten tillot ikke symlink uten admin-rettigheter denne
kjøringen) - eksplisitt IKKE et live-PASS, mekanismen forblir suite-bevist
(`filesystem-source.test.ts`). Full evidens: docs/RUNTIME_GATES.md.
**Q-20 (teknisk data-erasure-foundation, FØR UA-2 P1): VERIFIED/CLOSED (2026-08-16, host-bevist på
ekte Windows/Docker-host, run_id `eaabe2b1`)** → D-40. Ny pakke `@jarvis/erasure` - sentral, typed
`ErasureService` (preview/execute/verify) med scope-modell (`tenant`/`person`/`memory_space`/
`knowledge_source`/`knowledge_document`/`conversation`). Hard-delete av knowledge- OG memory-innhold +
alt avledet (embeddings/versjoner/entiteter/relasjoner/oppsummeringer/beslutninger/forpliktelser/
frister), FK-trygg/fail-closed/idempotent. `erasure_fingerprints`-suppresjonsledger hindrer at
`KnowledgeSyncService` gjenoppliver slettet innhold ved neste source-sync (kun SHA-256-fingerprint,
aldri klartekst) - bevist LIVE. D-klasse policy-integrasjon gjenbruker eksisterende `PolicyGateway`/
sovereign/approval uendret, bevisst IKKE via `ToolGateway`s D-pipeline (ville lagret en KOPI av
innholdet i et recovery-snapshot - dokumentert unntak). `jarvis_app` fikk et nytt, avgrenset
`GRANT DELETE` (kun de faktisk hard-slettede tabellene - `events`/`audit_events` forblir
append-only-blokkert). **Host-bevis:** `q20_preview`/`q20_hard_delete`/`q20_derived_delete`/
`q20_fts_erasure`/`q20_vector_erasure`/`q20_hybrid_erasure`/`q20_memory_erasure`/`q20_no_resurrection`/
`q20_idempotency`/`q20_tenant_isolation`/`q20_space_isolation`/`q20_receipt_safe`/`q20_sentinel_scan` =
ALLE PASS, `hard_fail=false`; resync-bevis `created=0`/`suppressed=1`; retrieval etter purge
`fts_hits=0`/`vector_hits=0`/`hybrid_hits=0`/`memory_hits=0`; `q21_runtime_role_safe=PASS` uendret i
samme kjøring. Tre host-recovery-runder samme dag (workspace-bootstrap → Windows pnpm-
prosessoppløsning → DEP0190-opprydding, se RUNTIME_GATES.md) løste kun host-/prosess-hygiene, ingen
erasure-logikk endret. **Teknisk foundation, IKKE juridisk GDPR-sertifisering.** Fortsatt eksplisitt
dokumenterte, ikke purgede stores: `events`/`audit_events`-payload, `tasks`/`tool_executions`-innhold,
Langfuse/trace-fil, `person`-scope dekker ikke knowledge-dokumenter. Full evidens:
docs/DATA_ERASURE.md og docs/RUNTIME_GATES.md.

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
  stille utelatt).
- **HOST RECOVERY-RUNDER (samme dag, tre runder til faktisk grønt):** første host-kjøring av
  fiks-scriptet feilet delvis (`.env`-interpolasjonsbug i Docker Compose - fikset med eksplisitt
  `--env-file`), deretter feilet migrate-containeren fortsatt med `password authentication failed for
  user "jarvis_runtime"` selv om admin-precheck viste `postgres` (runde 2 - grundig kildesporet, ingen
  kodebug funnet i selve wiringen). Faktisk root cause (runde 3, Tobias sin egen hypotese, bekreftet):
  `docker compose run --rm migrate` bygger ALDRI om et image automatisk - containeren kjørte et
  utdatert, pre-Q21-image. Fikset ved å alltid kjøre `docker compose build migrate api worker` før
  migrate/restart i hvert scriptkall. Full feilsøkingslogg: docs/RUNTIME_GATES.md.
- **STATUS: VERIFIED/COMPLETE (2026-08-15, host-bevist, run_id `778bb87d`) → D-38/D-39.** Full
  host-kjøring bekreftet grønt: `q21_runtime_role_safe=PASS`, `tenant_isolation=PASS`,
  `memory_space_isolation=PASS`, alle øvrige UA-2 P0-felt PASS unntatt `symlink_escape=
  SKIPPED_HOST_PERMISSION` (eksplisitt IKKE et live-PASS, forblir suite-bevist). Se
  header-seksjonen øverst i denne filen og docs/RUNTIME_GATES.md for full evidens.

## Q-20 — Data Erasure Foundation (BYGGET denne økten, 2026-08-16)
- **Inventory først** (docs/DATA_ERASURE.md §2): faktisk skjema lest (ikke antatt) - klassifisert
  A (CONTENT)/B (DERIVED)/C (OPERATIONAL METADATA)/D (SECURITY/AUDIT, append-only-blokkert).
- **Én sentral, typed erasure-tjeneste** (`modules/erasure`, `@jarvis/erasure`) - IKKE separate
  tilfeldige delete-funksjoner per modul. `previewErasure`/`executeErasure`/`verifyErasure`.
  Scope-modell: `tenant`/`person`/`memory_space`/`knowledge_source`/`knowledge_document`/
  `conversation`, `tenant_id` alltid eksplisitt - ingen cross-tenant purge uttrykkbart (bevist, §H).
- **Hard delete** (`modules/erasure/src/plan.ts`): FK-trygg rekkefølge, én transaksjon, fail-closed
  (en injisert midt-i-feil ruller HELE transaksjonen tilbake - bevist, §N). Dekker knowledge
  (`knowledge_documents`/`knowledge_embeddings`) + memory (`memory_items` + alt avledet) +
  conversations (`messages`/`sessions`) + `artifacts` (kun tenant-scope).
- **Ny migrasjon `018_erasure.sql`:** `erasure_requests`/`erasure_fingerprints`-ledger (RLS, samme
  mønster som resten) + et EKSPLISITT, avgrenset `GRANT DELETE` til `jarvis_app` (kun de tabellene
  som faktisk hard-slettes fra - systemet hadde ALDRI hatt en DELETE-rettighet noe sted før dette;
  `events`/`audit_events` forblir uten DELETE-grant, i tillegg til append-only-trigger-blokkert).
- **Resurrection protection (§5):** `erasure_fingerprints` lagrer KUN en irreversibel SHA-256-
  fingerprint av canonical identity - ALDRI innhold/external_id i klartekst. `KnowledgeSyncService`
  sjekker denne før nytt canonical document opprettes (`report.suppressed`, ny felt). Bevist LIVE
  (embedded Postgres): purge → resync (fil fortsatt på disk) → `created=0, suppressed=1`.
- **Erasure receipt/ledger (§6):** kun identifiers/counts, ALDRI slettet innhold - bevist (§K/§L,
  en plantet SENTINEL finnes aldri i `erasure_requests`/`erasure_fingerprints`).
- **Policy/risk (§7/§8):** gjenbruker EKSISTERENDE `PolicyGateway`/sovereign/approval/nonce-replay
  uendret - ingen ny auth-modell. Owner sovereign kjører uten approval; delegert identitet nektes
  uten signert approval, tillates med gyldig Ed25519-signatur (bevist, begge veier).
- **§9-unntak (dokumentert):** IKKE via `ToolGateway`s generiske D-pipeline (ville lagret en KOPI av
  innholdet i et `before_state`-recovery-snapshot - undergraver selve erasure). `executeErasure()`
  kaller `PolicyGateway.authorize()` direkte og skriver sin egen trygge ledger-rad.
- **Backup/restore-kontrakt (§10):** `TIER1_TABLES` (watchdog) utvidet med knowledge-tabellene (reell
  pre-eksisterende gap) + erasure-ledgeren. Ny `reapplyErasuresAfterRestore()` - re-fjerner et
  restorert dokument som matcher ledgeren, idempotent (bevist).
- **Observability (§11):** events/audit_events (strukturelt blokkert), Langfuse/lokal trace-fil
  (ingen purge-integrasjon) dokumentert som kjente, IKKE skjulte gap.
- **Retrieval verification (§12):** FTS/vector/hybrid/memory-retrieval alle bevist 0 treff etter
  purge (§E/§F/§G, live-script §8-§11).
- **Q-21 uendret/ikke-regresert (§13):** kjører via `jarvis_runtime` (NOSUPERUSER/NOBYPASSRLS) i
  ALLE tester og i live-scriptet (§O-testen leser `pg_roles` direkte og bekrefter dette per kjøring).
- **Live host-akseptanse-script:** `modules/erasure/scripts/q20-erasure-live.ts` - alle 21 trinn fra
  byggeordren, kjørt AV DENNE ØKTEN mot en ekte (embedded, ikke mocket) Postgres:
  `hard_fail=false`, alle `q20_*`-felt PASS (ved bygging - senere host-bevist reelt, se under).
- 14 nye tester (`modules/erasure/test/erasure-service.test.ts` 13 + `modules/watchdog/test/
  erasure-restore-contract.test.ts` 1), full suite grønn, lint/typecheck/gitleaks rene.
- **STATUS ved bygging: FIXED_SUITE / READY_FOR_HOST_VERIFY. OPPDATERT: VERIFIED/CLOSED (D-40) -
  se "Q-20 FINAL CLOSURE" under.** Teknisk erasure-foundation - IKKE en juridisk GDPR-sertifisering.

## Q-20 HOST RECOVERY #1 (samme dag, 2026-08-16) — workspace-bootstrap-feil
Tobias sin første kjøring feilet FØR noe Q-20-innhold ble testet: `ERR_MODULE_NOT_FOUND:
Cannot find package '@jarvis/core'`. Root cause: branchen la til en NY pnpm-workspace-pakke
(`modules/erasure`) - hosten sin `node_modules` var aldri bootstrappet for den (host-bootstrap-feil,
IKKE et Q-20-funn). Node 24 (host) bekreftet IKKE root cause (`engines: >=22` er oppfylt).
**Fikset** med ny ett-kommando-orkestrator `modules/core/scripts/q20-host-run.ts` (kun Node-
innebygde moduler på toppnivå - kan kjøre FØR `pnpm install`): bootstrapper workspacet
(`pnpm install --frozen-lockfile`), verifiserer resolvering (`modules/erasure/scripts/
verify-workspace.ts`), sikrer ferske Docker-images, kjører migrasjonene (inkl. `018_erasure.sql`)
via ADMIN-rollen (uendret Q-21-splitt), restarter api/worker, og kjører til slutt selve
`q20-erasure-live.ts`. Feilen reprodusert og fiksen bekreftet i byggemiljøet (node_modules fjernet
→ samme feil → `pnpm install` reparerer). 18 nye wiring-tester
(`modules/core/test/q20-host-run-wiring.test.ts`). Kommando uendret siden:
`node --experimental-transform-types modules/core/scripts/q20-host-run.ts`. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #2 (samme dag, 2026-08-16) — Windows pnpm-prosessoppløsning
Samme runner feilet deretter på selve `pnpm install --frozen-lockfile`-steget:
`spawnSync pnpm ENOENT` - til tross for at `pnpm` fungerer fint fra Tobias sin egen PowerShell.
Root cause: Node sin `execFileSync`/`spawnSync` uten shell-involvering gjør ikke Windows sin PATHEXT-
baserte utvidelsesoppløsning (`pnpm.cmd`). **Fikset (runde 1)** med ny, avhengighetsfri
`modules/core/scripts/lib/package-manager-resolve.ts` - deterministisk oppløsning: `pnpm`/`pnpm.cmd`
direkte på PATH → ellers `corepack`/`corepack.cmd` med EKSPLISITT pinnet versjon (`pnpm@9.15.9` fra
`package.json`, ALDRI `corepack enable`) → ellers fail-closed med tydelig diagnostikk. 11 nye
enhetstester. **Bekreftet FOR REAL i byggemiljøet** (ikke bare unit-testet): hele bootstrap-kjeden
kjørt direkte som ekte prosess - `package_manager_resolution=PASS
package_manager_driver=pnpm package_manager_version=9.15.9`, `install_frozen_lockfile=PASS`,
`erasure_workspace_dependencies=PASS`. Ett-kommando-kontrakten uendret. Full evidens:
docs/RUNTIME_GATES.md.

## Q-20 HOST RECOVERY #3 (samme dag, 2026-08-16) — DEP0190-opprydding
Host-output fra runde 2 sin fiks endte med Node sin `DEP0190`-advarsel (`shell: true` kombinert med
et args-array er en kjent injeksjonsrisiko - Node må selv gjette hvordan argumentene skal escapes).
**Fikset PERMANENT FØR merge:** `shell` er nå fjernet som alternativ overalt i
`q20-host-run.ts`/`package-manager-resolve.ts`. Et Windows `.cmd`-shim kjøres i stedet via en
eksplisitt, ikke-shell cmd.exe-barneprosess med et internt kontrollert argv (`buildSpawnInvocation()`,
`/d /s /c <sti> <args>` - samme mønster som `cross-spawn`-biblioteket bruker for nøyaktig dette
Windows-problemet). Native `.exe`/unix-binærer kjøres fortsatt direkte (ingen unødvendig indirection).
Ny regresjonstest bekrefter `shell: true` aldri finnes i kildekoden igjen. 16 nye/oppdaterte
enhetstester (34 totalt i `package-manager-resolve.test.ts`). Ingen erasure-/migrasjons-/DB-rolle-
/retrieval-/policy-logikk endret - kun prosess-spawning-hygiene.

## Q-20 FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/q20-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `eaabe2b1`.** Bootstrap
(`package_manager_resolution=PASS package_manager_driver=pnpm.cmd`), migrasjon 018 anvendt via
admin-rollen, Q-21 uendret (`q21_runtime_role_safe=PASS`), og ALLE `q20_*`-felt PASS
(`hard_fail=false`) - hard delete av original+avledet innhold, FTS/vector/hybrid/memory-retrieval=0
etter purge, resurrection-suppresjon bevist (`created=0`/`suppressed=1`), idempotens bevist,
tenant/space-isolasjon urørt, trygg kvittering, sentinel-scan uten funn. **STATUS: Q-20 =
VERIFIED/CLOSED → D-40.** Full evidens: docs/RUNTIME_GATES.md, docs/DECISIONS_AND_ASSUMPTIONS.md.
PR #4 merges til `main`.

## Blokkeringer
Ingen blokkering for Q-20 lenger - VERIFIED/CLOSED (host-bevist, run_id `eaabe2b1`), PR #4 merges til
`main`. UA-2 P0 og Q-21 har heller ingen egne blokkeringer (begge VERIFIED/CLOSED, allerede merget).
Manglende provider-nøkler er eneste gap for LIVE multi-provider-evidens (Gemini/Kimi/Ollama).
Ytelsesgjeld for voice-latens (Q-19) er åpen, ikke-blokkerende.

## Neste oppgave
Q-20 er VERIFIED/CLOSED og merget til `main`. Anbefalt neste UA-2-del: **UA-2 P1** (flere
kunnskapskilder - Obsidian, Pieces, Google Drive, e-post, møtetranskripsjon, OCR - se
IMPLEMENTATION_PLAN for eksakt P1-scope). Venter på Tobias sin eksplisitte fase-godkjenning før
implementering starter (faseporten gjelder, CLAUDE.md-regel 10) - **IKKE startet i denne runden.**
Øvrige kandidater uendret i bakgrunnen: D-30 ytelsesgjeld (Q-19), D-10 STT-benchmark (Q-03),
D-36 Apple, HA-RUNTIME, provider-nøkler for Gemini/Kimi/Ollama LIVE-benchmark.
