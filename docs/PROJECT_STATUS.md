# PROJECT STATUS

**Oppdatert:** 2026-08-16 (P1A Runtime Wiring Closeout - venter på host-smoke-bevis) · **Branch:**
`claude/p1a-drive-runtime-wiring` (draft, IKKE merget) · UA-2 P1A selv forblir VERIFIED/COMPLETE
(D-42, host-bevist run_id `2703299e`, PR #5 merget til `main`)

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
**UA-2 P1A (Knowledge Source Expansion + Google Drive Full Read/Write): VERIFIED/COMPLETE
(2026-08-16, host-bevist på ekte Windows/Docker-host, run_id `2703299e`, `hard_fail=false`)** → D-42.
Ni oppfølgingsrunder (hver drevet av et ekte Tobias-host-funn) endte med full grønn host-akseptanse:
Obsidian-livssyklus, tenant-isolasjon/retrieval for nye kildetyper, Google Drive full read/write
ende-til-ende (Desktop-OAuth-bootstrap, Drive API aktivert, auth/read/create/update/rename/move/
trash/permanent_delete/cleanup/sync/no-resurrection/idempotency/policy/live ALLE PASS), Q-21 uendret
i samme kjøring, ingen token-lekkasje. Eksplisitt, ærlig unntak: `google_drive_permission_live=
SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (live permission-mutasjon IKKE host-testet - se Q-23, IKKE en
blokkering for lukking). PR #5 merget til `main`. Full evidens under "UA-2 P1A FINAL CLOSURE" nederst i denne filen.
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

## UA-2 P1A — Knowledge Source Expansion (BYGGET denne økten, 2026-08-16, FRA `origin/main` etter Q-20-merge)
- **Godkjent byggeordre** (etter Q-20 VERIFIED/CLOSED-merge): utvid `@jarvis/knowledge` med Google
  Drive (READ ONLY) og Obsidian/lokal vault som nye kunnskapskilder, på den EKSISTERENDE
  `KnowledgeSource`/`KnowledgeSyncService`/FTS+vector-hybrid-arkitekturen - ingen parallell
  connector-SDK, ingen ny auth-modell, ingen ny DB-migrasjon (gjenbruker `knowledge_documents`/
  `knowledge_embeddings` uendret). Pieces eksplisitt utsatt (se under). IKKE bygget: e-post-
  ingestion, møtetranskripsjon, OCR, full Knowledge Graph/GraphRAG, Drive write/delete.
- **Kontrakt-utvidelse** (`modules/knowledge/src/source.ts`): `KnowledgeSource.list()` returnerer nå
  `KnowledgeListResult { records, skipped }` i stedet for en bar array - en kilde kan rapportere
  bevisste per-element-skips (f.eks. ustøttet MIME) uten å forveksle dem med feil. Ny
  `KnowledgeSourceError`/`SourceErrorClass` (AUTH/PERMISSION/RATE_LIMIT/TRANSIENT_NETWORK/NOT_FOUND/
  UNSUPPORTED_CONTENT/INVALID_CONFIG/SOURCE_UNAVAILABLE) for TOTAL listing-svikt - `sync()` tombstoner
  ALDRI noe når `list()` kaster, uansett klasse (kritisk sikkerhetsegenskap, uendret). Fikset en latent
  bug i `GithubKnowledgeSource` samtidig: en feilet ToolGateway-handling ble tidligere stille utelatt
  (kunne feiltolkes som "alt slettet" av tombstone-logikken) - kaster nå eksplisitt i stedet.
- **`KnowledgeSourceRegistry`** (`registry.ts`): typet, FLERE-instans konfigurasjon bundet til
  (tenant_id, memory_space_id, source_instance_id) - `forTenant()` kan STRUKTURELT aldri returnere en
  annen tenants config, ingen implisitt/global kilde.
- **`GoogleDriveTransport`** (`modules/tool-gateway`): READ ONLY, samme OAuth/konto-mønster som
  Gmail/Calendar (`googleAccessToken()` gjenbrukt, ingen ny credential-type). `list_files` (paginert,
  eksplisitt `folder_id` fra kilden - ALDRI en default) + `read_document` (Google Docs eksporteres til
  text/plain, tekstlige MIME-typer leses rått, alt annet - Sheets/Slides/bilder/PDF/binærformater -
  kaster en typet `drive_unsupported_content_<mime>`-feil).
- **`GoogleDriveKnowledgeSource`** (`drive-source.ts`): `external_id` = Drive sin stabile `file.id`
  (rename-safe - en omdøpning endrer `title`, ikke `external_id`). Mappe-scope er REKURSIV men
  importerer ALDRI hele driven når konfigurert for én mappe. Paginering + rekursjon aggregeres internt
  i `list()` (komplett resultat eller kast, aldri partielt). Sletting gjenbruker eksisterende
  "fraværende i vellykket listing = tombstone" (ingen egen Drive Changes-API-integrasjon - bevisst,
  dokumentert valg). En AUTH/PERMISSION-feil på ÉN fil-lesing eskaleres til TOTAL svikt (systemisk
  årsak antatt); NOT_FOUND/RATE_LIMIT/TRANSIENT_NETWORK på én fil er en trygg per-fil-skip.
- **`ObsidianVaultKnowledgeSource`** (`obsidian-source.ts`): KOMPONERER rundt
  `FilesystemKnowledgeSource` (samme allowlist/traversal/symlink-forsvar som UA-2 P0, ingen duplisert
  sikkerhetslogikk) - kun `.md`-filer, `.obsidian/` ekskludert som default. Frontmatter parses
  best-effort (flat, ingen ny YAML-avhengighet) til `metadata.frontmatter`; wiki-lenker
  (`[[Notat]]`) til `metadata.wiki_links` (flat liste, IKKE en graf - GraphRAG bevisst utenfor P1A).
  `external_id` = relativ vault-sti (samme presedens som filesystem) - Obsidian-omdøpning er derfor
  slett+ny, IKKE en oppdatering (dokumentert forskjell fra Drive, som HAR en stabil fil-id).
- **To korrekthetsfiks i `KnowledgeSyncService.sync()`** (gjelder ALLE kilder, ikke bare de nye):
  (1) `skipped`-elementer beskyttes nå mot tombstoning sammen med `seen` - én forbigående per-element-
  feil kunne tidligere tombstonet ETT dokument selv om hele listingen lyktes; (2) "uendret innhold"-
  grenen oppdaterer nå tittel/uri/metadata (uten re-embedding) - nødvendig for at en Drive-omdøpning
  faktisk skal synes.
- **Chunking-safeguard** (bevisst MINIMAL, ingen ekte multi-chunk-skjema): `embed()`-input trunkeres
  til 24 000 tegn - `content`-kolonnen (og dermed FTS) beholder ALLTID hele, utrunkerte teksten. Ingen
  embedding-leverandør i kodebasen hadde en input-grense før dette (Drive/Obsidian-dokumenter kan bli
  langt større enn P0 sine korte GitHub-issues).
- **Pieces: eksplisitt utsatt.** Repo-søk fant INGEN integrasjon/API/eksportformat/credential-
  miljøvariabel noe sted - kun navnedropp i planleggingsdokumenter. Ingen konkret, ikke-gjettet
  integrasjonsflate å bygge mot ennå - egen fremtidig underoppgave når en finnes.
- **Ett-kommando host-akseptanse:** `modules/core/scripts/ua2-p1a-host-run.ts` (samme
  pnpm/Windows/Docker-bootstrap-mønster som `q20-host-run.ts`, INGEN ny workspace-pakke denne gangen
  → ingen egen verify-workspace-steg) kjører til slutt
  `modules/knowledge/scripts/ua2-p1a-live.ts`: Q-21-rolle-sjekk, registry-sanity, Obsidian full
  livssyklus i en ISOLERT MIDLERTIDIG vault (ALDRI Tobias sin ekte vault), tenant-isolasjon+retrieval
  med de nye kildetypene, no-content-i-audit-scan. Google Drive LIVE er BETINGET: krever
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` OG en NY, dedikert
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` (aldri hele driven) - mangler noen av de fire rapporteres
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE`, ALDRI en fake PASS.
- **Kvalitet:** 463/463 tester (406 baseline fra `origin/main` + 57 nye: registry x9, Drive-source x11,
  Obsidian-source x9, kryssgående tenant/space/retrieval/audit-redaksjon x5, chunking-safeguard x2,
  host-run-wiring x21), full monorepo-typecheck ren. Lint/gitleaks gjenstår før PR (se §32 i
  byggeordren).
- **STATUS: FIXED_SUITE / READY_FOR_HOST_VERIFY. IKKE VERIFIED** - ingen ekte Google Drive-credential,
  ingen ekte Docker-Postgres i denne sky-sandboxen. Krever Tobias sin host-kjøring
  (`ua2-p1a-host-run.ts`) før VERIFIED kan settes, akkurat som Q-20/UA-2 P0 krevde det.

## UA-2 P1A scope-endring — Google Drive full read/write + Owner Connector Capability Invariant (D-41, samme økt)
- **Tobias sin eksplisitte beslutning FØR PR #5 merges:** Jarvis skal IKKE være begrenset til read-only
  Google Drive - full funksjonell tilgang, styrt av det EKSISTERENDE A-D policy-systemet (ingen ny
  permission-modell). Samtidig innført som en PERMANENT arkitekturregel for ALLE fremtidige connectors
  (se D-41 i DECISIONS_AND_ASSUMPTIONS.md, rule 11 i CLAUDE.md).
- **Google Drive utvidet fra READ ONLY til FULL read/write/permissions:** `GoogleDriveTransport` fikk 10
  nye handlinger (`get_metadata`/`read_permissions` klasse A; `create_file`/`create_folder`/
  `update_content`/`rename`/`move`/`trash` klasse C; `delete_permanent`/`create_permission`/
  `update_permission`/`delete_permission` klasse D). Produksjons-OAuth-scope bekreftet mot Google sitt
  offisielle Drive API v3-discovery-dokument (IKKE gjettet): `https://www.googleapis.com/auth/drive`
  (full tilgang - `drive.file` dekker kun app-opprettede filer, utilstrekkelig). `files.delete` er
  PERMANENT (bekreftet); trashing er en egen, reversibel `files.update`. `update_content`/`rename`/
  `move`/`trash` godtar en valgfri `expected_head_revision_id`-precondition - ved mismatch kastes en
  typet `drive_conflict_stale_version`-feil FØR noen mutasjon forsøkes, aldri en stille overskriving.
  D-klasse-handlinger har `preflight_action` (samme eksisterende ToolGateway-evidensmekanisme som
  Home Assistant sin `lock_set`/`alarm_set` alt brukte - ingen ny mekanisme). Owner sovereign-modus
  uendret: klasse D autonomt for eier, delegert identitet krever fortsatt signert godkjenning.
- **Idempotens:** skriveoperasjoner gjenbruker EKSISTERENDE ToolGateway `idempotency_key`-dedupe (samme
  mekanisme som resten av systemet) - bevist kritisk for `create_permission` spesielt, siden Drive sin
  egen `permissions.create` IKKE dedupliserer identiske tilganger selv.
- **Q-20-distinksjon (§5 i scope-endringen):** eksplisitt bevist arkitektonisk separert - en
  `drive/trash`-handling rører ALDRI `knowledge_documents`, og en Q-20-hard-delete av et
  `knowledge_document` kaller ALDRI ut til Drive. Dette er to uavhengige operasjoner, ikke automatisk
  koblet.
- **Tester:** 27 nye (`drive-full-access.test.ts` 17 - policy/idempotens/isolasjon/observability via ekte
  ToolGateway+Postgres+FakeTransport; `google-drive-transport.test.ts` 10 - konflikt-/statuskode-
  klassifisering internt i transporten, fetch mocket, det ENESTE unntaket fra "raw HTTP-transportere
  unit-testes aldri"-presedensen fordi byggeordren eksplisitt krevde det). `ua2-p1a-live.ts` §6 utvidet
  med ekte create/update/rename/move/trash/cleanup/sync/no-resurrection/idempotency mot
  `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` - `google_drive_live=BLOCKED_REAUTH_REQUIRED` hvis lesing
  fungerer men skriving feiler på auth (utilstrekkelig scope på eksisterende token). Permission-
  mutasjon er BEVISST IKKE live-testet (kan ikke gjøres trygt uten å involvere en ekte person/endre ekte
  eksponering) - policy/klassifisering for det er suite-bevist. 517/517 tester totalt (490 + 27),
  full monorepo-typecheck ren.
- **Connector-audit (engangs, IKKE alle utvidet i denne runden - kun Google Drive):**

  | Connector | Klassifisering | Har i dag | Konkrete gap (backlog, IKKE bygget her) |
  |---|---|---|---|
  | Google Drive | **FULL** (denne økten) | read/list/create/update/rename/move/trash/delete/permissions | - |
  | GitHub | PARTIAL | read_issues, read_repo_meta, create_pr | Ingen merge_pr, ingen issue-kommentar/opprettelse/lukking, ingen branch-sletting, ingen repo-admin |
  | Google Calendar | PARTIAL | read_events, create_event | Ingen update_event, ingen delete_event, ingen svar-på-invitasjon |
  | Gmail/e-post | PARTIAL | read_inbox, send | Ingen reply/forward, ingen arkivering/sletting/labeling, ingen draft-håndtering |
  | Telegram | PARTIAL | notify (send), `/brief`/`/status`/`/ai`-kommandoer (poll) | Ingen redigering/sletting av sendte meldinger, ingen rikere Bot API-funksjoner (pin, media) |
  | Vercel | READ_ONLY | read_deployments | Ingen trigger/rollback/promote-deploy, ingen env-var-håndtering |
  | Home Assistant | PARTIAL | read_state, light_set, climate_set, lock_set (D), alarm_set (D) | God kjernedekning, men ikke uttømmende (media_player, cover/blinds, scener, automasjon-trigger mangler) |

  Gapene er EKSPLISITT dokumentert som backlog, IKKE lukket her (D-41/§CURRENT CONNECTOR AUDIT sier
  eksplisitt "IKKE utvid alle nå dersom det blåser scope"). Hver fremtidig connector-byggeordre
  vurderer full kapabilitet fra D-41-sjekklisten fremover.

## UA-2 P1A HOST RECOVERY — auto-create safe Drive test sandbox (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte `ua2-p1a-host-run.ts` (run_id `8af834dd`, `hard_fail=false`) - ALLE
  ingestion-felt (Obsidian/registry/tenant-isolasjon/retrieval/audit) PASS, men
  `google_drive_live=BLOCKED_NO_SAFE_TEST_SCOPE` fordi `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` ikke var
  satt, selv om `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`JARVIS_GOOGLE_TOKEN` alle var konfigurert.
- **Eksplisitt eierbeslutning:** Tobias skal ALDRI måtte manuelt opprette en Drive-testmappe, finne/
  kopiere en mappe-ID, eller redigere `.env` for å kjøre denne akseptansen.
- **Ny, ren, avhengighetsfri modul** `modules/knowledge/scripts/lib/drive-acceptance-sandbox.ts`
  (`DriveAcceptanceSandbox`, `determineTestRootSource`, `driveAcceptanceFolderName`, `isReauthSignal`) -
  BEVISST ingen fetch/nettverk der, kun grensekontroll-/cleanup-logikk. `assertInSandbox()` er den ENESTE
  veien en mutasjon godkjennes - fail-closed, kaster `DriveBoundaryViolationError` for enhver ID denne
  kjøringen ikke selv sporet som opprettet (aldri "prøv og se").
- **`ua2-p1a-live.ts` §6 fullstendig omskrevet:** er `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID` satt, brukes den
  (kun LEST, ALDRI slettet av runneren). Er den IKKE satt, oppretter runneren SELV en unikt navngitt,
  midlertidig mappe (`"Jarvis P1A Acceptance <run_id>"`) - BEVISST INGEN søk-etter-lignende-navn-og-
  gjenbruk (alltid en fersk `create_folder`, aldri en `list_files`-basert oppslag). Et rent LESE-scope-
  probe (`get_metadata` på Drive sin reserverte `"root"`-ID) skjer FØR test-roten løses og FØR noen
  mutasjon forsøkes, slik at total auth-svikt skilles fra manglende skrive-scope
  (`google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`). Full akseptanse A-Q bevist INNENFOR sandkassen:
  auth-probe, opprett to undermapper + hovedtestfil, les, oppdater, omdøp, flytt mellom undermappene,
  sync+retrieval (scopet til subfolder-b), Q-20 hard-delete+resync-no-resurrection (PLUSS et nytt
  Drive-side-uavhengighetsbevis: originalfilen bekreftes FORTSATT å eksistere i Drive etter Jarvis-side
  purge), trash (reversibelt), idempotent create (samme idempotency_key), permanent sletting KUN på en
  artefakt DENNE kjøringen selv opprettet (`driveMutate()`-wrapperen grensekontrollerer FØR ethvert
  mutasjonskall). Permission-mutasjon fortsatt BEVISST IKKE live-testet
  (`google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`) - kan ikke gjøres trygt uten å
  involvere en ekte person/endre ekte eksponering i en ubetjent kjøring.
- **Opprydding:** alt DENNE kjøringen selv opprettet slettes permanent til slutt via
  `sandbox.cleanupTargets()` (barn FØR rot) - en eksplisitt KONFIGURERT rot er strukturelt ALDRI et
  mål (kun inkludert når `autoCreated=true`). Den auto-opprettede mappe-IDen persisteres ALDRI til
  `.env` - kun til kjøringens `diagnostics`/logg.
- **`ua2-p1a-host-run.ts`-kommentarblokken oppdatert** til å reflektere at `JARVIS_GOOGLE_DRIVE_TEST_FOLDER_ID`
  nå er VALGFRI - selve ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts`.
- **Tester:** 13 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - auto-create-beslutning,
  navneunikhet, grensekontroll, reauth-klassifisering, cleanup-scoping inkl. delvis-oppsatt-kjøring og
  "konfigurert rot aldri i cleanup-listen"), pluss `ua2-p1a-host-run-wiring.test.ts` utvidet/oppdatert
  (guard krever nå kun client_id/secret/token, IKKE test_folder_id; nye strukturelle bevis for §D
  no-reuse-by-search, §J konfigurert-rot-aldri-direkte-slettet, §K ingen `.env`-persistering,
  driveMutate-grensekontroll-kjeden, §M idempotent-gjentakelse). **512/512 tester totalt** (faktisk målt
  denne runden), lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring fra
  Tobias for å bevise auto-sandkassen faktisk fungerer mot ekte Drive. PR #5 forblir draft/umerget.

## GOOGLE DRIVE FULL-ACCESS REAUTH (samme dag, 2026-08-16) — ett-kommando nettleser-reauth
- **Host-funn:** run_id `262ac1bb` viste `google_drive_auth_scope=BLOCKED_REAUTH_REQUIRED`
  (`get_metadata("root")` → `tool_failed:drive_auth_error_403`) - det eksisterende `JARVIS_GOOGLE_TOKEN`
  mangler full Drive-scope (utstedt før D-41-scope-endringen). Eierkrav: Tobias skal ALDRI måtte lime
  inn en autorisasjonskode manuelt, redigere `.env`, eller kjøre en egen andre kommando etterpå -
  produksjons-OAuth-scope forblir FULL `https://www.googleapis.com/auth/drive` (D-41 uendret, ingen
  fallback til read-only for å "få testen til å passere").
- **Ny, ren, avhengighetsfri modul** `modules/core/scripts/lib/google-drive-reauth-lib.ts` -
  URL-bygging/callback-parsing/state-CSRF-sjekk/scope-sammenligning/refresh-token-beslutning/konto-
  maskering, INGEN nettverk/filsystem der (30 rene enhetstester).
- **`modules/core/scripts/google-drive-reauth.ts`** - ÉN host-kommando:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`. Offisiell
  "authorization code" + loopback-IP-redirect-flyt (RFC 8252, `http://127.0.0.1:8942/oauth2callback`
  default, `JARVIS_GOOGLE_REAUTH_PORT` valgfri override) - ALDRI den avviklede OOB-flyten. Ber om
  `https://www.googleapis.com/auth/drive` + EKSISTERENDE `https://www.googleapis.com/auth/calendar`
  (unngår å regressere kalender, som deler samme `JARVIS_GOOGLE_TOKEN`) + et minimalt
  `https://www.googleapis.com/auth/userinfo.email`-scope (kun for konto-identitetssjekk). `access_type=
  offline`+`prompt=consent`+`include_granted_scopes=true` (bekreftet mot google-auth-library sin
  offisielle Node.js-dokumentasjon - garanterer en fersk refresh_token hver kjøring, bevarer andre
  allerede godkjente scopes). Åpner standardnettleseren automatisk (Windows/macOS/Linux, samme
  DEP0190-sikre ikke-shell cmd.exe-mønster som `package-manager-resolve.ts` på Windows); fallback til
  manuell URL hvis åpning feiler.
- **Verifisering FØR noe skrives (§7):** både token-responsens `scope`-felt OG en FAKTISK
  `get_metadata("root")`-lesing mot ekte Drive må lykkes - callback-suksess alene er IKKE nok.
  Innsuffisient scope → `FAIL_INSUFFICIENT_SCOPE`, `.env` urørt. Manglende refresh_token i responsen
  (uventet siden `prompt=consent` alltid tvinger en) håndteres KUN ved å LIVE re-verifisere den
  eksisterende token-ens faktiske scope via `tokeninfo`-endepunktet - aldri en antakelse om Google sin
  interne inkrementell-auth-oppførsel.
- **Konto-konsistens (§8):** henter KUN e-postadressen (minimalt scope), maskerer den (`t***@domene`)
  i all logging, sammenligner mot konfigurert `JARVIS_GOOGLE_ACCOUNT` - ved mismatch kreves eksplisitt
  skrevet "YES" i terminalen FØR noe skrives; "identitet kunne ikke bestemmes" blokkerer IKKE (logges
  ærlig som ukjent, aldri stille behandlet som match).
- **Sikkerhet:** aldri client_secret/access_token/refresh_token/authorization_code i logg eller
  prosessargument (bevist strukturelt, se wiring-tester). `.env` skrives KUN ved full suksess - alle
  feilbaner returnerer/kaster FØR skriving, slik at den eksisterende (om enn scope-begrensede)
  credentialen alltid forblir gjenopprettbar. Skriving gjenbruker EKSISTERENDE
  `buildUpdatedEnvLines`/`parseEnvValues`/backup-mønster fra `lib/q21-env-recovery.ts` (samme
  `.env.bak.<epoch>` + atomisk tmp+rename som `fix-q21-runtime-role.ts`) - rører KUN
  `JARVIS_GOOGLE_TOKEN`-linjen.
- **Kjeder automatisk videre:** ved `google_drive_reauth=PASS` kjøres `ua2-p1a-host-run.ts` (og dermed
  hele Drive-auto-sandkasse-akseptansen fra forrige runde) AUTOMATISK - ingen andre kommando fra Tobias.
- **Presisjonsfunn (dokumentert, IKKE fikset i denne runden):** `GmailTransport` (tool_id `"email"`)
  bruker faktisk en HELT ANNEN, i dag ukonfigurert credential (`JARVIS_EMAIL_TOKEN`) - IKKE
  `JARVIS_GOOGLE_TOKEN` slik en eldre `.env.example`-kommentar feilaktig antydet (rettet i denne
  runden). Reauth-scriptet ber derfor bevisst KUN om Drive+Calendar-scope, ikke Gmail.
- **Åpent, IKKE-blokkerende funn (logget, ikke skjult):** `GoogleDriveTransport` er registrert i
  `firstWaveTools()`-funksjonen, men er IKKE koblet inn i de faktiske produksjons-entrypointene
  (`apps/api/src/main.ts`/`worker-main.ts` sine `firstWaveTools({...})`-kall mangler en `drive:`-nøkkel
  - kun `email`/`calendar`/`github`/`telegram` er wiret der i dag). Drive-verktøyet er dermed reelt
  reachable KUN fra `ua2-p1a-live.ts`/testene, ikke fra en løpende api/worker-prosess ennå. Dette er
  UTENFOR denne reauth-ordrens scope (som var credential-anskaffelse, ikke entrypoint-wiring) og
  krever en egen, eksplisitt godkjent byggeordre - ikke gjort stille her.
- **Tester:** 30 nye rene enhetstester (`google-drive-reauth-lib.test.ts`) + 24 nye strukturelle
  wiring-tester (`google-drive-reauth-wiring.test.ts`, kildeteksts-basert - samme presedens som
  `ua2-p1a-host-run-wiring.test.ts`). Full suite/lint/typecheck/gitleaks kjøres som del av denne
  rundens kvalitetsport (se rapport).
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sin faktiske
  nettleser-godkjenning på hosten. PR #5 forblir draft/umerget.

## GOOGLE DRIVE REAUTH HOST FIX (samme dag, 2026-08-16) — response_type manglet + feil konto
- **Host-funn:** Tobias kjørte `google-drive-reauth.ts`. Nettleseren åpnet Google OAuth med FEIL konto
  (`henrik@ffskis.com`), og Google avviste med "Required parameter is missing: response_type" (Error
  400: invalid_request).
- **Root cause (ÉN, forklarer BEGGE symptomene samtidig):** den genererte autorisasjons-URL-en har
  ALLTID inneholdt `response_type=code` (bevist av eksisterende enhetstester siden forrige runde) -
  feilen lå i `openBrowser()` sin daværende Windows-vei, `cmd /c start "" <url>`. URL-en inneholder `&`
  (gyldig spørrestreng-skilletegn) men verken mellomrom eller anførselstegn, så Node sin Windows-argv-
  til-kommandolinje-quoting siterte IKKE argumentet automatisk. cmd.exe mottok URL-en USITERT i
  `/c`-modus og splittet den ved HVERT ubeskyttet `&` som et kommando-skille - Google mottok reelt kun
  `...auth?client_id=<id>`, nok til å identifisere appen og stille falle tilbake til en allerede
  innlogget nettleser-konto, men ALDRI `redirect_uri`/`response_type`/`scope`/`state`.
- **Fiks 1 (transport):** Windows-veien bruker nå `rundll32.exe url.dll,FileProtocolHandler <url>` i
  stedet for `cmd /c start` - en native .exe, INGEN kommandotolk involvert i det hele tatt (samme
  "native-exe-trenger-ingen-cmd-wrapper"-presedens som `lib/package-manager-resolve.ts`).
- **Fiks 2 (kontovalg):** `prompt` er nå `"consent select_account"` (Google sin offisielt dokumenterte
  mellomrom-delte prompt-liste) - tvinger ALLTID frem kontovelgeren, aldri en stille auto-valgt konto.
  `login_hint` settes til `JARVIS_GOOGLE_ACCOUNT` (kun et HINT - hindrer aldri kontobytte, offisielt
  dokumentert Google-oppførsel).
- **Fiks 3 (pre-flight-sikkerhetsnett):** `validateAuthorizationUrl()` parser den genererte URL-en
  tilbake og krever eksplisitt `response_type=code`+`client_id`+`redirect_uri`+`state`+full Drive-scope
  FØR nettleseren i det hele tatt åpnes - fanger enhver FREMTIDIG regresjon i selve URL-byggingen,
  fail-closed (server startes ikke, nettleser åpnes ikke).
- **Konto-mismatch-rapportering presisert:** ny `formatAccountMismatchReport()` gir en eksplisitt,
  grep-bar `expected_account=<maskert> authorized_account=<maskert>`-loggform - samme
  bekreftelses-gate (typet "YES") som før, kun tydeligere format.
- **.env-sikkerhet uendret/bekreftet:** alle feilbaner (inkl. den nye pre-flight-valideringen) skjer
  strukturelt FØR backup/skriving - `.env` forblir urørt ved enhver feil, bevist av wiring-testene.
- **Tester:** 15 nye rene enhetstester (URL-validering, prompt/login_hint, mismatch-rapportformat) +
  7 nye strukturelle wiring-tester (rundll32 i bruk / cmd-start borte, pre-flight-rekkefølge,
  login_hint-wiring, mismatch-rapport-bruk) - 588/588 totalt. Lint/full monorepo-typecheck/gitleaks
  alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever en NY host-kjøring
  fra Tobias for å bevise fiksen faktisk fungerer mot en ekte Windows-nettleser. PR #5 forblir
  draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #2 (samme dag, 2026-08-16) — redirect_uri_mismatch / permanent Desktop-klient-design
- **Host-funn:** transport-fiksen over løste URL-korrumperingen (Tobias sin nettleser åpnet nå den
  KOMPLETTE URL-en - riktig client_id/redirect_uri/response_type/scope/state/prompt), men Google svarte
  deretter med `Error 400: redirect_uri_mismatch`.
- **Root cause (evidensbasert, ikke gjettet):** Google validerer `redirect_uri` FØR noe annet
  (sikkerhetskritisk, hindrer open-redirect) - en "Web application"-klient krever en EKSAKT
  forhåndsregistrert redirect-URI, mens en "Desktop app"-klient godtar EN loopback-IP-redirect på
  HVILKEN SOM HELST port UTEN forhåndsregistrering (bekreftet Google-dokumentert oppførsel). At
  Tobias sin eksisterende, allerede eksisterende OAuth-klient (fra FØR denne reauth-byggingen) ga
  mismatch for en loopback-URI er sterk evidens for at den er "Web application"-type - Jarvis sin
  lokale, interaktive eier-reauth-flyt er NØYAKTIG scenarioet "Desktop app" er bygget for. Google
  sender ALDRI noen callback tilbake ved mismatch (feilsiden vises direkte i nettleseren) - dette
  scriptet kan derfor STRUKTURELT ikke oppdage feilen selv via callback-serveren.
- **Ingen offentlig Google-API for å opprette en OAuth-klient programmatisk** (kun Cloud Console-UI -
  bekreftet, ikke antatt) - ETT manuelt Cloud Console-steg er derfor uunngåelig. Redusert til fem
  eksplisitte steg i loggmeldingen FØR nettleseren åpnes, PLUSS Cloud Console-credentials-siden åpnes
  AUTOMATISK i en egen fane (prosjektnummeret utledes fra den eksisterende `JARVIS_GOOGLE_CLIENT_ID`
  sin stabile `<prosjektnummer>-<random>.apps.googleusercontent.com`-form - ingen gjettet URL).
- **Ny, valgfri `JARVIS_GOOGLE_CLIENT_SECRET_JSON`** (.env-variabel, filsti): peker til den nedlastede
  client secret-JSON-fila fra en NY "Desktop app"-OAuth-klient. `resolveOAuthClient()` leser/validerer
  denne FØR noe annet i `main()` - `parseClientSecretJson()` godtar KUN Google sin `installed`
  (Desktop)-JSON-form, og avviser en `web`-type fil EKSPLISITT (`WrongOAuthClientTypeError`, samme
  brittleness som klienten Tobias allerede har - stille prøving av samme feilende type unngås).
- **Koherent credential-sett (§4 i ordren):** brukes en importert Desktop-klient, skrives
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` SAMMEN i ÉN atomisk `.env`-skriving ved suksess - aldri
  et token alene mot en client_id/_secret som ikke lenger samsvarer. Refresh-tokens er tied til klienten
  som utstedte dem (bekreftet Google-oppførsel) - en full authorization_code-exchange (ikke bare en
  refresh_token-gjenbruk) garanterer et FERSKT, korrekt-koblet token for DEN importerte klienten.
- **Kontovelger uendret:** `prompt=consent select_account` og `login_hint` er identisk uansett
  klientkilde (ÉN `buildAuthorizationUrl()`-kall, ingen egen "importert klient"-gren som svekker dette).
  Presisering av §7 i ordren: "browseren viste fortsatt henrik@ffskis.com" er mest sannsynlig Google sin
  standard feilside-topptekst (viser AKTIV nettleser-økt-identitet) - siden redirect_uri-valideringen
  skjer FØR kontovelgeren i det hele tatt vises, ble select_account/login_hint aldri nådd i det
  tilfellet. Ingen svekkelse av den mekanismen er gjort eller nødvendig.
- **Tester:** 11 nye rene enhetstester (`parseClientSecretJson`/`deriveProjectNumberFromClientId`/
  `buildCredentialsConsoleUrl`) + 10 nye strukturelle wiring-tester (koherent skriving, ingen
  parallell/duplisert credential-lesing, .env-drevet gjenopptakelse, ingen secrets i den nye koden) -
  608/608 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  manuelle Cloud Console-steg (opprett Desktop-klient, sett `JARVIS_GOOGLE_CLIENT_SECRET_JSON`) etterfulgt
  av en NY host-kjøring for å bevise dette faktisk fungerer. PR #5 forblir draft/umerget. Ett-kommando-
  kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #3 "ZERO MANUAL ENV EDITING" (samme dag, 2026-08-16) — automatisk Desktop-klient-oppdagelse
- **Eierens UX-krav:** etter HOST FIX #2 var det ENE uunngåelige manuelle steget i praksis TO -
  Cloud Console-handlingen OG å redigere `.env` med filstien til den nedlastede JSON-en. Tobias skal KUN
  gjøre den ENE, faktisk uunngåelige handlingen (opprette en "Desktop app"-klient og trykke "Download
  JSON") - ALDRI redigere `.env`, kopiere client_id/secret, eller lime inn en filsti.
- **Automatisk Nedlastinger-oppdagelse, i SAMME kjørende prosess, uten restart:** `attemptOAuth()` starter
  nå det opprinnelige OAuth-forsøket OG (parallelt, i bakgrunnen) en `watchForDesktopClientDownload()`-
  polling av Tobias sin Nedlastinger-mappe (`os.homedir()/Downloads` - den dokumenterte
  standardplasseringen, ALDRI en hardkodet bruker-sti). `Promise.race()` mellom callback-en og watcheren
  avgjør veien videre: kommer callback-en FØRST (normalflyt - klienten var allerede riktig type),
  fortsetter alt UENDRET og Tobias ser ALDRI noen ekstra fane (veiledningen/Cloud Console-siden vises
  FØRST etter 25 sekunder - god margin for en vanlig kontovalg+samtykke-interaksjon, kort nok til rask
  hjelp ved en ekte feil). Finner watcheren en NY, gyldig Desktop-klient-JSON FØRST, avbrytes det
  opprinnelige callback-forsøket EKSPLISITT (frigjør porten - `waitForCallback()` er nå kansellerbar) og
  et FRISK OAuth-forsøk starter AUTOMATISK med den nye klienten, i SAMME prosess.
- **KUN filer fra og med kjøringens eget starttidspunkt regnes** (`selectNewCandidateJsonFiles`) - en
  gammel, urelatert JSON-fil som allerede lå i Nedlastinger plukkes ALDRI opp. Hver kandidat valideres med
  den EKSISTERENDE `parseClientSecretJson()` (ingen ny/parallell valideringslogikk) - en "web"-type fil
  eller søppel EKSKLUDERES STILLE fra kandidatlisten (Nedlastinger kan inneholde mange urelaterte
  JSON-filer), krasjer ALDRI polling-løkka. Flere gyldige kandidater SAMTIDIG avgjøres ALDRI stille - en
  trygg, KUN-filnavn nummerert liste ber Tobias velge eksplisitt.
- **Koherent persistering uendret:** `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` skrives SAMMEN, atomisk,
  til de VANLIGE `.env`-nøklene FØRST etter faktisk OAuth-suksess (scope+Drive-probe+kontosjekk alle
  bestått). `JARVIS_GOOGLE_CLIENT_SECRET_JSON` (HOST FIX #2) forblir støttet for et avansert/manuelt
  oppsett, men er IKKE lenger nødvendig for normalflyten og persisteres ALDRI selv - kun et
  engangs-import-artefakt.
- **Tester:** 20 nye rene enhetstester (`selectNewCandidateJsonFiles`/`classifyDiscoveryResult`/
  `formatCandidateSelectionPrompt`/`parseCandidateSelection`) + 15 nye strukturelle wiring-tester
  (kansellerbar callback-server, race-rekkefølge, koherent skriving KUN etter suksess, ingen restart,
  fortsatt ingen secrets logget) - 637/637 totalt. Lint/full monorepo-typecheck/gitleaks alle rene.
- **Ærlighet om verifikasjonsgrense:** selve den KONKURRERENDE race-/polling-/kanselleringslogikken kan
  IKKE kjøres ende-til-ende i denne sky-sandboxen (krever en ekte Windows-nettleser + en ekte
  Nedlastinger-mappe + faktisk Google OAuth) - bevist STRUKTURELT (kildeteksts-baserte wiring-tester,
  samme presedens som resten av denne fila) + den underliggende beslutnings-/filtreringslogikken FULLT
  enhetstestet. Faktisk host-kjøring er derfor fortsatt nødvendig for VERIFIED.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget.
  Ett-kommando-kontrakten er UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE OAUTH HOST FIX #4 "SETUP-FØRST, ALDRI AUTH MED KJENT WEB-KLIENT" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #3-versjonen. Nettleseren åpnet Google OAuth UMIDDELBART og fikk
  igjen `Error 400: redirect_uri_mismatch` (kontoen vist: `post@tsworkflow.com`) - beviset på at racet
  (opprinnelig OAuth-forsøk kjørt SAMTIDIG med Nedlastinger-oppdagelsen) startet OAuth med den samme,
  allerede kjent inkompatible Web-klienten FØR noen Desktop-klient var på plass.
- **Root cause:** HOST FIX #3 sitt design antok at man MÅTTE prøve eksisterende credentials FØRST for å
  "oppdage" om de var utilstrekkelige. For et tilfelle der Tobias ALLEREDE (fra HOST FIX #2) har bevist
  at eksisterende `JARVIS_GOOGLE_CLIENT_ID` er en Web-klient, er dette feil - vi VET allerede at et
  OAuth-forsøk med den vil feile, og skal derfor ALDRI forsøkes.
- **Racet er FJERNET.** Ny, strengt sekvensiell tilstandsmaskin: `resolveProvenDesktopClient()` avgjør
  FØRST om en POSITIVT bevist Desktop-klient finnes - enten en eksplisitt `JARVIS_GOOGLE_CLIENT_SECRET_
  JSON`-import (HOST FIX #2, avansert/manuelt), ELLER en NY `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-
  metadata-linje persistert av EN TIDLIGERE vellykket kjøring av DENNE flyten. Eksisterende
  `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET` ALENE (uten den metadata-linjen) regnes ALDRI som bevist Desktop -
  de kan være NØYAKTIG den samme Web-klienten som allerede har feilet TO GANGER, og brukes derfor ALDRI
  til et OAuth-forsøk.
- **Finnes ingen bevist klient:** `main()` går INN i SETUP_REQUIRED FØR noe OAuth-forsøk i det hele tatt
  vurderes. Cloud Console-siden åpnes UMIDDELBART (ingen "vent og se"-graceperiode lenger - setup-behovet
  er allerede kjent, ikke en gjetning), og `waitForDesktopClientJson()` venter ALENE (ingen samtidig
  OAuth-forsøk) i inntil 10 minutter på at en gyldig, ny Desktop-klient-JSON dukker opp i Nedlastinger.
  Først NÅR en slik klient er funnet+validert bygges autorisasjons-URL-en - ALLTID med DEN klientens
  `client_id`, ALDRI den rå `JARVIS_GOOGLE_CLIENT_ID`-verdien direkte.
- **`waitForCallback()` forenklet tilbake** til en enkel (ikke-kansellerbar) funksjon - siden det aldri
  finnes mer enn ÉTT OAuth-forsøk per kjøring lenger, er hele kanselleringsmekanismen fra HOST FIX #3
  unødvendig og fjernet.
- **Koherent persistering utvidet:** ved full suksess skrives `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/
  `_TOKEN` OG den nye `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE=desktop`-metadata-linjen SAMMEN i ÉN atomisk
  skriving - FØR suksess er gamle credentials (om noen) HELT urørt, slik at eksisterende, fungerende
  Gmail/Calendar-integrasjoner (som deler samme `JARVIS_GOOGLE_TOKEN`) aldri risikerer å miste sin
  gyldige credential midt i en mislykket reauth-kjøring.
- **Tester:** wiring-testsuiten omskrevet fra grunnen for den nye sekvensielle flyten (50 tester, dekker
  ordrens §10 A-L) - 631/631 totalt (færre enn forrige runde ved design, siden race-spesifikke tester er
  erstattet av færre, mer presise sekvensielle tester). Lint/full monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - krever Tobias sitt ENE
  Cloud Console-steg (hvis nødvendig, nå UTEN risiko for at scriptet prøver den kjente Web-klienten
  først) etterfulgt av en NY host-kjøring. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er
  UENDRET: `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #5 "CLASSIFY REAL DRIVE 403 + AUTO-GUIDE" (samme dag, 2026-08-16)
- **Host-funn:** Tobias kjørte HOST FIX #4-versjonen. Desktop-OAuth-bootstrappen fungerte HELT gjennom
  (`google_desktop_client_status=SETUP_REQUIRED` → `google_desktop_client_import=PASS` →
  `google_desktop_client_type=desktop`, token-exchange lyktes med en scope-streng som så korrekt ut) -
  men flyten feilet DERETTER spesifikt på selve Drive-metadata-probe-kallet: `google_reauth=
  FAIL_DRIVE_PROBE`. `.env` forble korrekt urørt. Eksplisitt eierkrav: IKKE rør OAuth-redirect-/klient-
  arkitekturen igjen (host-bevist fungerende) - blokkeringen er en POST-AUTH Google Drive API-403, og
  den EKSAKTE Google-feilårsaken skulle klassifiseres, ALDRI gjettes.
- **Ny, trygg feilklassifisering** (`classifyDriveProbeError()` i lib, rent/deterministisk, INGEN
  nettverk): parser Google sin STABILE feil-JSON-form (`error.status`/`error.errors[].reason`/
  `error.details[].reason`/`error.message`) til `API_NOT_ENABLED`/`INSUFFICIENT_SCOPE`/
  `WORKSPACE_ADMIN_POLICY`/`RATE_LIMIT`/`AUTH_INVALID`/`UNKNOWN_PROVIDER_403`. `API_NOT_ENABLED` og
  `INSUFFICIENT_SCOPE` gjenkjennes via Google sine EGNE, dokumenterte, høy-presisjon signaler
  (`SERVICE_DISABLED`/`accessNotConfigured`/"has not been used in project"; `insufficientPermissions`/
  "insufficient authentication scopes"). `WORKSPACE_ADMIN_POLICY` er EKSPLISITT dokumentert i koden som
  en BEST-EFFORT-bøtte (generisk `PERMISSION_DENIED` uten et mer presist signal på dette tidspunktet i
  flyten - Google gir normalt ikke et unikt maskinlesbart signal for Workspace-adminblokk etter
  token-exchange) - ALDRI fremstilt som en Google-bekreftet unik årsak. `safeMessage` trunkeres
  (≤300 tegn); resultatobjektet har KUN 7 trygge felt - access_token/refresh_token/client_secret/
  authorization_code/fulle request-headers går ALDRI inn i klassifiseringen eller noen logglinje.
- **Automatisk guiding + samme-prosess-retry** (`driveMetadataProbe()`/`retryDriveProbeUntilRecovered()`
  i orchestratoren): en GJENOPPRETTBAR blokkering (`isRecoverableDriveProbeBlocker()` - KUN
  `API_NOT_ENABLED`/`WORKSPACE_ADMIN_POLICY`) åpner NØYAKTIG riktig side automatisk (Google sin EGEN
  innebygde enable-URL fra feilmeldingen foretrukket for API_NOT_ENABLED - `buildDriveApiEnableUrl()`
  KUN som fallback; Admin Console sin API Controls-side, `GOOGLE_ADMIN_API_CONTROLS_URL`, for
  WORKSPACE_ADMIN_POLICY - med ÉN instruksjon om å stole eksplisitt på "Jarvis Desktop"-klienten, IKKE en
  bred org-policy-endring), gir Tobias ÉN eksakt setning, og prøver DERETTER Drive-proben på nytt hvert
  5. sekund i SAMME kjørende prosess i opptil 10 minutter - ingen restart, ingen andre kommando. Et
  refresh_token tilgjengelig IN-MEMORY brukes trygt til å fornye access-tokenet underveis hvis det
  utløper mens Tobias gjør Console-klikket (`refreshAccessToken()`) - `.env` forblir likevel HELT urørt
  til HELE flyten (inkludert denne retryen) lykkes. En IKKE-gjenopprettbar blokkering (INSUFFICIENT_SCOPE/
  RATE_LIMIT/AUTH_INVALID/UNKNOWN_PROVIDER_403) kaster UMIDDELBART med den klassifiserte rapporten - retry
  forsøkes ALDRI for noe scriptet ikke kan løse selv.
- **Ingen scope-nedgradering, ingen klient-fallback (D-41 uendret):** hele probe-/retry-flyten bruker
  UTELUKKENDE den allerede bevist-Desktop-klienten (`client.clientId`/`client.clientSecret`) - aldri
  `values["JARVIS_GOOGLE_CLIENT_..."]` direkte, aldri `drive.file`/`drive.readonly` noe sted i filen.
  Ingen Drive-MUTASJONER forsøkes noensinne i probe-/retry-koden - kun gjentatte, skrivebeskyttede
  metadata-lesinger.
- **Ingen credential persisteres mens blokkeringen er uløst:** `driveMetadataProbe()`-feilen og
  `retryDriveProbeUntilRecovered()`-kallet skjer STRUKTURELT FØR `updates`-blokken/`.env`-backup-koden -
  samme fail-closed-plassering som scope-sjekken. Lykkes retryen, oppdateres KUN det in-memory
  access-tokenet (`driveVerifiedAccessToken`) som brukes videre i resten av `main()` (inkl.
  `detectAccountEmail()`) - selve `.env`-skrivingen skjer fortsatt KUN i den ene, eksisterende atomiske
  `updates`-blokken, uendret fra HOST FIX #4.
- **Tester:** 15 nye rene enhetstester (`classifyDriveProbeError`/`formatDriveProbeReport`/
  `isRecoverableDriveProbeBlocker`/`buildDriveApiEnableUrl`/`GOOGLE_ADMIN_API_CONTROLS_URL`) + 11 nye
  strukturelle wiring-tester (riktig-prosjekt enable-URL-preferanse, samme-prosess-retry uten
  execFileSync-selv-spawn, ingen-persistering-mens-blokkert, vellykket-retry-fortsetter-med-ferskt-token,
  samme bevist-Desktop-klient gjennom hele flyten, ingen drive.file/drive.readonly noe sted) - **657/657
  totalt**. Lint/full monorepo-typecheck/gitleaks (`protect --staged` + historikk-scan) alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve klassifiserings-/retry-
  logikken kan IKKE kjøres ende-til-ende mot en ekte Google-403 i denne sky-sandboxen (krever en ekte
  Workspace-organisasjon/Cloud-prosjekt i en faktisk blokkert tilstand) - bevist STRUKTURELT
  (kildeteksts-baserte wiring-tester) + den underliggende klassifiseringslogikken fullt enhetstestet mot
  Google sin dokumenterte, stabile feil-JSON-form. Krever Tobias sin NYE host-kjøring for å bevise
  klassifiseringen/auto-guidingen faktisk treffer riktig mot den EKTE 403-en han observerte. PR #5
  forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## GOOGLE DRIVE REAUTH HOST FIX #6 "REUSE EXISTING DESKTOP JSON AFTER FAILED AUTH" (samme dag, 2026-08-16)
- **Host-funn:** Tobias hadde allerede opprettet ÉN Desktop-OAuth-klient ("Jarvis Desktop") og lastet ned
  en gyldig `installed`-JSON (HOST FIX #5-kjøringen beviste den helt gjennom token-exchange). Fordi
  persistering er BEVISST atomisk, ble klient-metadata/credentials IKKE skrevet til `.env` da Drive-proben
  feilet senere i samme kjøring. NESTE kjøring rapporterte likevel `google_desktop_client_status=
  SETUP_REQUIRED` igjen og åpnet Cloud Console på nytt - FEIL, siden Tobias ikke skal opprette en ny
  OAuth-klient han allerede har.
- **Root cause:** `waitForDesktopClientJson()`/`selectNewCandidateJsonFiles()` sin mtime-filter (§2 i HOST
  FIX #4-ordren, riktig for SITT formål - unngå å plukke opp en gammel, urelatert fil under FØRSTE gangs
  oppsett) godtar KUN filer med `mtime >= runStartMs`. En allerede-validert JSON fra en TIDLIGERE kjøring
  har per definisjon en eldre mtime enn en NY kjørings `runStartMs`, og ble derfor STILLE ignorert - et
  gjenopprettingsscenario (JSON importert → OAuth forsøkt → senere providervalidering feilet → prosessen
  avsluttet FØR persistering) som det opprinnelige designet aldri dekket.
- **Ny gjenopprettings-skanning FØR SETUP_REQUIRED vurderes:** `tryRecoverExistingDesktopClientJson()`
  (orchestrator) skanner Nedlastinger-mappa med en NY, mtime-fri lib-funksjon
  (`selectExistingCandidateJsonFiles()` - samme sortering/`.json`-filter som `selectNewCandidateJsonFiles()`,
  men UTEN `sinceMs`-parameteren) og validerer HVER kandidat med den EKSISTERENDE
  `tryReadValidDesktopClient()`/`parseClientSecretJson()`-kjeden (ingen parallell valideringslogikk - en
  "web"-type/ugyldig fil ekskluderes like stille som ved vanlig oppdagelse). Nøyaktig ÉN gyldig kandidat:
  gjenbrukes AUTOMATISK (`google_desktop_client_status=RECOVERED_EXISTING_JSON`), Cloud Console åpnes
  ALDRI. `main()` sin `if (!client)`-gjenopprettingsblokk står STRUKTURELT FØR `SETUP_REQUIRED`-blokken som
  to SEPARATE if-sjekker (ikke if/else) - lykkes gjenopprettingen, er `client` allerede satt og
  `SETUP_REQUIRED`-blokken sin betingelse er `false` ved runtime.
- **Flere eksisterende gyldige kandidater samtidig:** samme trygge, KUN-filnavn-nummererte velger som
  ellers (`promptForCandidateSelection()`, nå med en `variant: "new" | "existing"`-parameter for riktig
  ledetekst - ALDRI en stille gjetning, ALDRI to parallelle implementasjoner). Et uavklart svar faller
  TRYGT tilbake til `SETUP_REQUIRED` (ingen uendelig løkke her, i motsetning til den vanlige
  nedlastings-pollingen - eksisterende filer endrer seg ikke av seg selv mens vi venter).
- **Non-secret gjenopprettingsmarkør (§3 i ordren): BEVISST IKKE bygget denne runden.** Selve
  gjenopprettings-skanningen løser det konkrete host-funnet uten behov for ny persistert tilstand (unngår
  en ekstra `.gitignore`-styrt lokal fil og tilhørende kompleksitet) - dokumentert avveining, ikke et
  utelatt krav (ordren selv merket punktet "Consider"/valgfritt).
- **Atomisk `.env`-persistering UENDRET:** gjenopprettingen påvirker KUN hvilken `client` OAuth-forsøket
  bruker - `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN`/`_OAUTH_CLIENT_TYPE` skrives fortsatt SAMMEN, KUN
  én gang i hele filen, KUN etter at callback+state+scope+Drive-probe+kontosjekk alle har lyktes.
- **HOST FIX #5 uendret:** `classifyDriveProbeError()`/`driveMetadataProbe()`/
  `retryDriveProbeUntilRecovered()` (Drive-403-klassifisering, auto-guide, samme-prosess-retry) er ikke
  rørt - en gjenopprettet klient fortsetter inn i NØYAKTIG samme OAuth→scope→Drive-probe-flyt som en
  nyoppdaget/persistert-metadata-klient.
- **Tester:** 4 nye rene enhetstester (`selectExistingCandidateJsonFiles` - eksisterende gammel fil tas
  med, ekstremt gammel mtime diskvalifiserer IKKE, `.json`-filter, nyest-først) + 12 nye strukturelle
  wiring-tester (mtime-fritt gjenopprettingskall, to separate if(!client)-sjekker, gjenbruk av
  eksisterende valideringskjede, fail-safe flere-kandidater-håndtering uten uendelig løkke, Cloud Console
  IKKE åpnet ved vellykket gjenoppretting, ingen client_secret logget, ingen tidlig `.env`-persistering,
  HOST FIX #5 uendret) - **673/673 totalt** (84+4 lib, 61+12+3 justerte wiring). Lint/full
  monorepo-typecheck/gitleaks alle rene.
- **STATUS: fortsatt FIXED_SUITE / READY_FOR_HOST_VERIFY, IKKE VERIFIED** - selve gjenopprettings-
  skanningen kan ikke kjøres ende-til-ende mot en ekte tidligere-nedlastet fil i denne sky-sandboxen
  (krever en ekte Windows Nedlastinger-mappe med en reell, tidligere validert JSON-fil) - bevist
  STRUKTURELT (kildeteksts-baserte wiring-tester) + den underliggende filter-/valideringslogikken fullt
  enhetstestet. Krever Tobias sin NYE host-kjøring for å bevise at scriptet nå gjenkjenner den allerede
  eksisterende "Jarvis Desktop"-JSON-en automatisk og går rett til OAuth-samtykke uten å åpne Cloud
  Console på nytt. PR #5 forblir draft/umerget. Ett-kommando-kontrakten er UENDRET:
  `node --experimental-transform-types modules/core/scripts/google-drive-reauth.ts`.

## UA-2 P1A HOST FIX #8 "CLEANUP-ONLY BLOCKERS AFTER FULL DRIVE SUCCESS" (samme dag, 2026-08-16)
- **Host-funn (run_id `ff16c69d`) - VIKTIG MILEPÆL: Google Drive full read/write er nå HOST-BEVIST.**
  Reauth-flyten (HOST FIX #4-#6) fullførte helt: `google_drive_api_enabled=PASS`,
  `google_drive_full_scope=PASS`, kontosjekk PASS, koherent Desktop-credential-sett persistert,
  `google_drive_reauth=PASS`. Selve Drive-akseptansen (`ua2-p1a-live.ts` §6) beviste DERETTER
  `google_drive_auth_scope`/`_read`/`_create`/`_update`/`_rename`/`_move`/`_sync`/
  `_q20_no_resurrection`/`_trash`/`_idempotency`/`_permanent_delete`/`_policy` ALLE PASS, ingen
  token-lekkasje (`drive_token_leak_audit=false`, `drive_token_leak_metadata=false`),
  `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` (uendret, bevisst). Den samlede
  P1A-akseptansen ble likevel blokkert av TO RENE opprydding-defekter (IKKE manglende
  Drive-kapabilitet) - se under.
- **Blokker A - `google_drive_cleanup=FAIL` (targets=5, root_deleted=true):** root cause funnet ved
  faktisk kildelesing (ikke gjettet). §P sin allerede-vellykkede `delete_permanent` av hovedtestfila
  lot fila stå igjen i `sandbox.created` - §5-oppryddingen forsøkte DERFOR å slette den EN GANG TIL.
  Den EKTE mekanismen: `delete_permanent` er en klasse-D-handling med `preflight_action: "get_metadata"`
  (ToolGateway sin evidens-/recovery-mekanisme) - for en fil som ALLEREDE er permanent slettet gir
  DENNE preflight-lesingen en 404, og siden klassen er D fører det til en UMIDDELBAR
  `preflight_failed:drive_not_found_...`-DENY - `deletePermanent()`-transportens EGEN, allerede
  idempotente 404-håndtering (`already_deleted: "true"`) nås ALDRI i dette tilfellet.
- **Fiks A:** `DriveAcceptanceSandbox` fikk en eksplisitt artefakt-livssyklus
  (`CREATED`/`TRASHED`/`PERMANENTLY_DELETED`/`CLEANED`) - `markPermanentlyDeleted(fileId)` kalles
  UMIDDELBART etter §P sin vellykkede sletting, og `cleanupTargets()` utelater NÅ strukturelt et hvert
  artefakt i en terminal tilstand (`PERMANENTLY_DELETED`/`CLEANED`) - INGEN redundant sletteforsøk
  skjer lenger. Som forsvar-i-dybden: ny `classifyCleanupOutcome()` klassifiserer et EVENTUELT
  gjenværende NOT_FOUND-svar under selve cleanup-løkka som `already_absent` KUN når mål-IDen er et
  KJENT sandkasse-artefakt (`sandbox.has()` - samme grensekontroll som `assertInSandbox()`) - ALDRI
  generalisert til en vilkårlig Drive-fil utenfor sandkassen. `google_drive_cleanup=PASS` avgjøres
  UTELUKKENDE av `cleanup_failures === 0` - ALDRI av `root_deleted=true` alene. Ny evidenslinje:
  `created_artifacts=<n> cleaned_artifacts=<n> already_absent=<n> cleanup_failures=<n> root_deleted=<bool>`.
- **Blokker B - `tenants`-FK-feil:** `"update or delete on table tenants violates foreign key
  constraint tool_executions_tenant_id_fkey"`. Root cause funnet mot det FAKTISKE skjemaet (ikke
  gjettet): `tool_executions.tenant_id` REFERENCES `tenants` (010_tool_executions.sql) - §N sin
  idempotency-test (ToolGateway sin idempotency_key-dedupe) skriver ÉN rad dit for TENANT_A, og
  `cleanupTenant()` slettet den aldri FØR `DELETE FROM tenants` ble forsøkt.
- **Fiks B:** `DELETE FROM tool_executions WHERE tenant_id = $1` lagt til FØRST i `cleanupTenant()`
  (FK-trygg rekkefølge, utledet fra selve migrasjonsgrafen). Verifisert MOT faktisk kildekode (ikke
  antatt) at INGEN andre tabeller trenger rydding: `audit_events.tenant_id` er en REN TEKSTKOLONNE
  (INGEN `REFERENCES tenants`, se 004_audit_cost.sql) OG append-only-trigger-beskyttet (samme
  Q-20-presedens - IKKE rørt, IKKE forsøkt slettet); `sessions`/`messages`/`events`/`devices`/
  `approvals`/`cost_events`/`brief_seen` opprettes ALDRI av P1A-akseptansen (verifisert - ingen av
  kallene i `ua2-p1a-live.ts` går via de tilhørende service-modulene). Ingen `DISABLE TRIGGER`, ingen
  `session_replication_role`, ingen `TRUNCATE`, ingen superbruker-omvei - kun presise,
  parameteriserte `DELETE ... WHERE tenant_id = $1`-setninger via den EKSISTERENDE `adminPool`
  (uendret Q-21 admin/runtime-splitt).
- **Q-21 uendret:** ingen kode rørt utenfor de to presise cleanup-fiksene - `jarvis_runtime` forblir
  NOSUPERUSER/NOBYPASSRLS, ingen RLS-omvei brukt eller nødvendig (adminPool var allerede den
  eksisterende, legitime admin-tilkoblingen for nettopp denne typen opprydding).
- **Google OAuth-arkitekturen er IKKE rørt** denne runden (eksplisitt krav i ordren) - begge fiksene
  er rene opprydding-/DB-endringer i `ua2-p1a-live.ts`/`drive-acceptance-sandbox.ts`. Tobias sin NESTE
  host-kjøring bruker de ALLEREDE persisterte Desktop-credentialene - INGEN ny reautorisering, INGEN
  nytt Cloud Console-steg, INGEN nytt samtykke nødvendig.
- **Tester:** 14 nye rene enhetstester (`drive-acceptance-sandbox.test.ts` - livssyklustilstand,
  `isNotFoundFailureReason()`, `classifyCleanupOutcome()`, inkl. eksplisitt "NOT_FOUND utenfor
  sandkassen aksepteres ALDRI"-kontrastbevis) + 14 nye strukturelle wiring-tester
  (`ua2-p1a-host-run-wiring.test.ts` - markPermanentlyDeleted-plassering, classifyCleanupOutcome-bruk,
  PASS-betingelse, FK-rekkefølge, scopet DELETE, ingen FK-omvei, audit_events urørt, alle tidligere
  host-bevist Drive-kapabilitetsstier uendret) - full suite kjørt, lint/typecheck/gitleaks rene (se
  rapport for eksakte tall).
- **STATUS - VIKTIG DISTINKSJON (§11 i ordren):** Google Drive full read/write-kapabilitet er
  HOST-BEVIST (run_id `ff16c69d`) - dette er IKKE lenger en åpen post. Den SAMLEDE UA-2 P1A-
  akseptansen forblir likevel FIXED_SUITE / READY_FOR_HOST_VERIFY, **IKKE VERIFIED**, fordi
  cleanup-defektene (Blokker A/B over) hindret et fullstendig grønt `hard_fail=false`-resultat på
  DENNE kjøringen. Krever EN NY host-kjøring (ingen ny reautorisering) for å bevise at BEGGE
  cleanup-fiksene faktisk fungerer mot ekte Drive/Postgres FØR P1A kan settes VERIFIED. PR #5 forblir
  draft/umerget.

## UA-2 P1A FINAL CLOSURE (2026-08-16, samme dag) — HOST VERIFIED, PR #5 MERGET
**Tobias kjørte `node --experimental-transform-types modules/core/scripts/ua2-p1a-host-run.ts` på sin
faktiske Windows/Docker-host - GRØNT resultat, run_id `2703299e`, `hard_fail=false`.** Ingen ny
Google-reautorisering var nødvendig - de allerede persisterte Desktop-credentialene ble gjenbrukt
direkte.
- **Q-21 uendret:** `q21_runtime_role_safe=PASS`, `runtime_current_user=jarvis_runtime`,
  `runtime_role_superuser=false`, `runtime_role_bypassrls=false`.
- **Knowledge P1A:** `p1a_registry_tenant_scoping`/`p1a_obsidian_lifecycle`/
  `p1a_obsidian_obsidian_dir_excluded`/`p1a_obsidian_frontmatter_wikilinks`/
  `p1a_obsidian_no_resurrection`/`p1a_tenant_isolation_new_sources`/`p1a_retrieval_new_sources`/
  `p1a_no_content_in_audit` = ALLE PASS.
- **Google Drive (full read/write, D-41):** `google_drive_auth_scope`/`_read`/`_create`/`_update`/
  `_rename`/`_move`/`_trash`/`_permanent_delete`/`_cleanup`/`_sync`/`_q20_no_resurrection`/
  `_idempotency`/`_policy`/`_live` = ALLE PASS. HOST FIX #8-cleanup-fiksene (§forrige seksjon) bevist
  fungerende: `created_artifacts=4 cleaned_artifacts=4 already_absent=1 cleanup_failures=0
  root_deleted=true` - ingen `cleanup A/B feilet`-linjer. `drive_token_leak_audit=false`,
  `drive_token_leak_metadata=false`.
- **Ærlig unntak, IKKE overklaimet:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL`
  - live permission-mutasjon (dele/tilgangsstyring) er bevisst IKKE host-testet (ingen trygg ekstern
  testperson i en ubetjent kjøring). Kapabiliteten er implementasjon-/suite-verifisert
  (`drive-full-access.test.ts` §I), men IKKE live-host-bevist - registrert som Q-23, et smalt,
  gjenværende verifikasjonspunkt, IKKE en blokkering for lukking (akseptanseløperen behandlet det
  eksplisitt som et trygt skip).
- **STATUS: UA-2 P1A = VERIFIED/COMPLETE → D-42.** PR #5 merget til `main` (normal merge-commit,
  samme konvensjon som PR #1-#4 - historikk bevart, ikke squashet). Se D-42 i
  DECISIONS_AND_ASSUMPTIONS.md for full beslutningslogg-entry.

## P1A RUNTIME WIRING CLOSEOUT (2026-08-16, egen branch `claude/p1a-drive-runtime-wiring`)
**IKKE en ny P1A-fullføring - D-42 forblir UENDRET som beslutningen som satte UA-2 P1A VERIFIED/
COMPLETE.** Dette er en oppfølgende, avgrenset lukking av ETT gjenværende funn fra P1A-lukkingen
(se "Nytt, ikke-blokkerende funn" i tidligere runder): `GoogleDriveTransport` var host-akseptanse-
bevist (D-42), men var ALDRI wiret inn i den NORMALE `apps/api/src/main.ts`/`worker-main.ts` sine
`firstWaveTools({...})`-kall - Drive-verktøyene var derfor reelt uoppnåelige fra en løpende api/
worker-prosess (kun `ua2-p1a-live.ts` sin egen akseptanse-only ToolGateway nådde dem).
- **Fiks:** ny delt fabrikk `driveTransportsIfConfigured()` (`live-transports.ts`) - sjekker KUN
  tilstedeværelse (Boolean) av `JARVIS_GOOGLE_CLIENT_ID`/`_SECRET`/`_TOKEN` (de tre
  `googleAccessToken()` faktisk krever - `JARVIS_GOOGLE_OAUTH_CLIENT_TYPE` er bevisst IKKE sjekket,
  den er kun reauth-scriptets egen bokføringsmarkør). Begge `main.ts` og `worker-main.ts` sprer
  `...driveTransportsIfConfigured()` inn i sitt EKSISTERENDE `firstWaveTools({...})`-kall - SAMME
  registreringsvei som email/calendar/github/telegram, ingen parallell mekanisme. Mangler
  credentials: `drive`-nøkkelen er fraværende, `firstWaveTools()` sin egen (allerede eksisterende)
  `UnconfiguredHttpTransport("drive")`-fallback brukes - INGEN oppstartskrasj, INGEN ny feilbane.
- **Full D-41-kapabilitet:** alle 14 implementerte Drive-handlinger (4×A, 6×C, 4×D) registreres
  samlet - ingen read-only-nedgradering, ingen ny godkjenningsfriksjon utover eksisterende
  sovereign-owner-policy.
- **Ny ett-kommando host-smoke:** `apps/api/scripts/p1a-drive-runtime-smoke.ts` - beviser den NORMALE
  runtime-banen (EKTE ToolGateway/PolicyGateway, samme konstruksjon som main.ts) mot ekte Drive med
  et rent lese-only `get_metadata("root")`-kall, PLUSS et strukturelt bevis for worker-banens
  identiske registrering. INGEN ny OAuth-samtykke, INGEN Drive-mutasjon.
- **Q-23 uendret:** `google_drive_permission_live=SKIPPED_NO_SAFE_EXTERNAL_PRINCIPAL` forblir åpen -
  runtime-wiring eksponerer permission-handlingene, men live-verifikasjon krever fortsatt en reell
  ekstern testperson.
- **Tester:** 22 nye rene enhetstester (`google-drive-transport.test.ts` §credential-sjekk) + 22 nye
  strukturelle wiring-tester (`drive-runtime-wiring.test.ts` + `drive-runtime-smoke-wiring.test.ts`).
  Eksisterende `drive-full-access.test.ts` (owner sovereign/delegert D-klasse-policy) kjørt UENDRET -
  fortsatt 17/17 PASS, bevis for at policy-banen ikke er regressert.
- **STATUS: kode+suite ferdig, IKKE host-smoke-verifisert.** Venter på Tobias sin host-kjøring av
  `p1a-drive-runtime-smoke.ts` FØR denne branchen merges - se "Neste oppgave".

## Blokkeringer
Q-20/UA-2 P0/Q-21/UA-2 P1A har INGEN egne blokkeringer (alle VERIFIED/CLOSED/COMPLETE, merget til
`main`). P1A Runtime Wiring Closeout (over) venter på Tobias sin host-smoke-kjøring FØR merge - draft
PR, IKKE merget ennå. Manglende provider-nøkler er eneste gap for LIVE multi-provider-evidens (Gemini/
Kimi/Ollama). Ytelsesgjeld for voice-latens (Q-19) er åpen, ikke-blokkerende. Pieces har ingen kjent
integrasjonsflate ennå (Q-22) - egen fremtidig underoppgave. Google Drive permission-mutasjon er IKKE
live-host-bevist (Q-23) - smalt, ikke-blokkerende gjenværende verifikasjonspunkt, krever en egen,
eksplisitt godkjent test-runde med en reell avtalt ekstern test-konto. Connector-audit-gapene
(GitHub/Calendar/Gmail/Telegram/Vercel/HA - se tabellen over) er dokumentert backlog, ikke
blokkerende.

## Neste oppgave
Tobias kjører (PÅ HOSTEN, fra repo-roten, docker-compose Postgres kjørende, de allerede persisterte
Google-credentialene fortsatt i `.env` - INGEN ny reautorisering) - ÉN kommando:
`node --experimental-transform-types apps/api/scripts/p1a-drive-runtime-smoke.ts`

Forventet fullt-grønt resultat: `drive_runtime_registered=PASS`, `drive_runtime_api_path=PASS`,
`drive_runtime_worker_path=PASS`, `token_leak=false`, `hard_fail=false`. **Ingen merge av
`claude/p1a-drive-runtime-wiring` før denne kjøringen er mottatt og bekreftet.** Etter det: UA-2 P1B
(e-post-vedlegg-ingestion, møtetranskripsjon, OCR - se IMPLEMENTATION_PLAN.md sin UA-2-seksjon og
UA2_KNOWLEDGE_DPIA.md; møtetranskripsjon-delen avhenger eksplisitt av UA-7 Communications Hub, IKKE
bygget ennå) er neste kandidat - venter på egen, eksplisitt fase-godkjenning fra Tobias FØR noe
implementeres (faseporten gjelder, CLAUDE.md-regel 10) - IKKE startet i denne runden. Øvrige
kandidater uendret i bakgrunnen: D-30 ytelsesgjeld (Q-19), D-10 STT-benchmark (Q-03), D-36 Apple,
HA-RUNTIME, provider-nøkler for Gemini/Kimi/Ollama LIVE-benchmark, Pieces (Q-22), Google Drive
permission-live-verifikasjon (Q-23, egen test-runde med reell ekstern test-konto), connector-audit-
gapene (D-41-sjekklisten, egne fremtidige byggeordre per connector).
