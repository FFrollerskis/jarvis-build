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
