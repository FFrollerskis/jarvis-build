# Baseline – remediering del 1

**Dato:** 2026-10-01 · **Gren:** `remediation/01-containment-baseline` · **Skrevet av:** Claude Code i en cloud-sandkasse uten tilgang til NAS-en, PC-en eller Docker-daemon.

> Denne filen inneholder bare **observerbare fakta**. Alt som krever tilgang til NAS/PC står som `IKKE KONTROLLERT` med en kommando som produserer beviset. Ingen hemmelige verdier er skrevet.

## 1. Koden

| Punkt | Verdi | Hvordan sjekket |
|---|---|---|
| Auditert commit | `35075a2` (merge av PR #217) | `FINAL_AUDIT_REPORT.md` |
| HEAD ved start av del 1 | `9706af0` (= `35075a2` + én docs-commit som kun oppdaterer `PROJECT_STATUS.md`) | `git log` |
| Differanse audit → start | kun `docs/PROJECT_STATUS.md` (+12 linjer) | `git diff 35075a2 9706af0 --stat` |
| Gjeldende HEAD | siste commit på grenen – se PR (oppdateres av hver commit) | `git rev-parse HEAD` |
| Arbeidstre ved start | rent, ingen ukjente lokale endringer | `git status` |
| `origin` | `https://github.com/tsworkflow/jarvisbuild` | `git remote -v` |

Funn ble re-verifisert mot gjeldende kode før hver endring (se [FINDINGS_LEDGER.md](FINDINGS_LEDGER.md)).

## 2. Hva som kjører på NAS-en og PC-en

| Punkt | Status | Bevis |
|---|---|---|
| Deployet commit/image på NAS | **IKKE KONTROLLERT.** Siste kjente (fra samtalen, ikke fra NAS): Tobias redeployet D-358/D-360/D-361 og feilsøkte `voice-gateway`/Tailscale-porten (D-362). Om han hentet `main` etter PR #217 er ukjent. | `ops/remediation/collect-runtime-baseline.sh` (seksjonene «Repository» og «Image identity per service») |
| Kjørende image-digests | **IKKE KONTROLLERT.** Pinnene i compose er digestene Docker Hub/MCR ga **2026-10-01**; NAS-ens faktiske digest kan avvike. | samme script; sammenlign mot `infra/local/docker-compose.yml` **før** `up --build` |
| Eksponerte porter på NAS | **IKKE KONTROLLERT.** Kun deklarert konfigurasjon er kontrollert (se §3). | `ss -tln` + `docker port` via scriptet |
| PC-worker (`JarvisClaudeWorker`) | **IKKE KONTROLLERT** – om den er schedulert og hvilken versjon. v2.3.0 er ifølge auditen aldri deployet. | PowerShell: `schtasks /Query /TN JarvisClaudeWorker /V /FO LIST` |
| `gemma_local` på PC-en (Ollama) | **IKKE KONTROLLERT** | `curl` mot `JARVIS_GEMMA_LOCAL_URL` fra NAS |
| Tailscale Serve/Funnel | **IKKE KONTROLLERT** (D-362 beviser at `tailscaled` lyttet på 3020) | `tailscale serve status` (scriptet) |

**Hva som faktisk kunne kontrolleres fra sandkassen:** repoet, `docker compose config` (kun konfig-oppløsning, ingen daemon), oppslag av image-digests mot Docker Hub/MCR, og testkjøringer mot lokale Postgres-klustre. Ingenting av dette er runtime-bevis for NAS-en.

## 3. Aktive tjenester og eksponerte porter (deklarert, `docker compose config`)

Samme kommando mot compose-filen **før** og **etter** del 1 (dummy-miljø, ingen daemon):

| Tjeneste | Før (`9706af0`) | Etter (denne grenen) | Image før → etter |
|---|---|---|---|
| `postgres` (superbruker) | `0.0.0.0:5432` | `127.0.0.1:5432` | `pgvector/pgvector:pg16` → `…@sha256:7b822b0a…` |
| `infisical` | `0.0.0.0:3060` | `127.0.0.1:3060` | `infisical/infisical:latest-postgres` → `…@sha256:36438985…` |
| `langfuse` | `0.0.0.0:3050` | `127.0.0.1:3050` | `langfuse/langfuse:2` → `2.95.11@sha256:85c278dc…` |
| `infisical-redis` | ingen | ingen | `redis:7-alpine` → `…@sha256:858f009f…` |
| `api` | `0.0.0.0:3010` | `127.0.0.1:3010` | bygges fra `api.Dockerfile` (`node:22-alpine` → `…@sha256:0a7108bf…`) |
| `worker` | ingen | ingen | samme image som `api` |
| `migrate`, `db-bootstrap` | ingen (one-shot) | ingen | `db-bootstrap` pinnet som postgres |
| `voice-gateway` | `127.0.0.1:3020` (D-362) | `127.0.0.1:3020` | `voice-gateway.Dockerfile`: `node:22-bookworm-slim` og `debian:bookworm-slim` pinnet |
| `browser-gateway` | `0.0.0.0:3030` (uautentisert) | **ingen host-port** | `browser-gateway.Dockerfile`: `playwright:v1.63.0-noble@sha256:eff16c30…` |

Tilgang utenfra går via Tailscale Serve mot `127.0.0.1` (`docs/runbooks/D250_NAS_MIGRATION.md`). Etter `up -d` på NAS-en må dette bekreftes med `ss -tln` – **ikke gjort**.

## 4. Aktive schedulere, workere og bakgrunnsløkker (fra koden)

**`api`-prosessen** (`apps/api/src/main.ts`):

| Hva | Intervall/tid | Merknad |
|---|---|---|
| `deviceRegistry.refresh()` | hvert 30. s | |
| `worker.drain()` (kø `executive`) | hvert 2. s | **drenerer samme kø som `worker`-containeren**; uten `command`-gren nå |
| `DailyScheduler` × 19 (Europe/Oslo) | daglig, se under | `*_HOUR` parses nå med `envHour` (tom = default, ugyldig = oppstartsfeil) |
| Telegram-poller | kontinuerlig hvis token satt | kun lese-minimumssett; `/godkjenn`/`/avvis` uten handler |
| ~~Selvmodifikasjons-sveip × 3 (60 s)~~ | **fjernet** | frosset til del 9 |

DailyScheduler-jobber (navn · env · default-time): `daily-brief` · `JARVIS_BRIEF_HOUR` · 7 (Telegram-blokken) · `finance-spend-integrity-sweep` · `JARVIS_FINANCE_SPEND_SWEEP_HOUR` · 4 · `stripe-payment-sync` · `JARVIS_STRIPE_SYNC_HOUR` · 3 · `vipps-payment-sync` · `JARVIS_VIPPS_SYNC_HOUR` · 3 · `neonomics-sweep` · `JARVIS_NEONOMICS_SYNC_HOUR` · 3 · `wallester-sweep` · `JARVIS_WALLESTER_SYNC_HOUR` · 5 · `business-open-loop-sweep` · `JARVIS_BUSINESS_SWEEP_HOUR` · 6 · `business-weekly-brief` · `JARVIS_BUSINESS_WEEKLY_BRIEF_HOUR` · 7 · `situation-sweep` · `JARVIS_SITUATION_SWEEP_HOUR` · 7 · `business-events-sync` · `JARVIS_BUSINESS_EVENTS_SYNC_HOUR` · 5 · `conversation-graph-sync` · `JARVIS_CONVERSATION_GRAPH_SYNC_HOUR` · 5 · `business-scoring-recalc` · `JARVIS_BUSINESS_SCORING_HOUR` · 7 · `support-inbox-sync` · `JARVIS_SUPPORT_INBOX_SYNC_HOUR` · 8 · `growth-action-recommendation-sweep` · `JARVIS_GROWTH_RECOMMENDATION_SWEEP_HOUR` · 9 · `location-/health-/vision-/memory-retention-sweep` · `JARVIS_*_RETENTION_SWEEP_HOUR` · 2 · `connector-health-sweep` · `JARVIS_CONNECTOR_HEALTH_SWEEP_HOUR` · 10.

**`worker`-prosessen** (`apps/api/src/worker-main.ts`): drenerer kø (`executive`, `coding`, `knowledge-ingest-email`), `Watchdog` (egen intervall; sjekker `database`, `stuckTasks` [RLS-blind, JARVIS-041], `costExplosion`), prosess-sandbox for coding-jobber. Executive-handleren har **ingen** sandbox lenger.

**PC (utenfor repoet):** `JarvisClaudeWorker` (Windows Task Scheduler) – status ukjent. I repoet er `ops/claude-worker/worker.mjs` nå frosset (§6).

## 5. Relevante feature-flagg og miljøvariabler (kun navn; verdier er ikke kontrollert på NAS)

| Variabel | Effekt |
|---|---|
| `JARVIS_BUDGET_APPROVED` | `spend_approved` i `BudgetGuard` (env-flagg, ikke signert override – JARVIS-039) |
| `JARVIS_SANDBOX` (`process`/`docker`) | sandbox for coding-jobber; compose setter `process` for `worker` |
| `JARVIS_GEMMA_LOCAL_URL` / `_MODEL` | aktiverer `gemma_local` (standardmodell) |
| `JARVIS_VOICE_ALLOW_TEST_ADAPTERS` | **ny:** tillater Marker/Fake-adaptere (kun dev/test); ellers feiler voice-gateway oppstart uten ekte STT/TTS |
| `JARVIS_VOICE_DEBUG_DUMP_DIR` + `_CONSENT` | rå-lyd-dump: ikke lenger videresendt av compose; krever samtykke i kode |
| `JARVIS_CLAUDE_WORKER_UNFREEZE` | **ny:** kun `remediation-part-9-reviewed` åpner claude-worker |
| `JARVIS_HOST_ACCEPTANCE_CONSENT` | **ny:** kreves av 27 host-run/live-skript |
| `JARVIS_TENANT_ID`, `JARVIS_OWNER_PERSON_ID` | eier-identitet/tenant (default `tenant-personal`/`person-tobias`) |
| `JARVIS_PUBLIC_VOICE_BASE_URL` | Tailscale-URL for voice/enrollment |
| `INFISICAL_*`, `JARVIS_DB_ADMIN_PASSWORD` | vault og DB-admin – **alle containere får fortsatt hele `.env`** (STB-06 ikke gjort) |

Selvmodifikasjon styres ikke av noen miljøvariabel lenger – koden er fjernet fra `api`-oppstarten (frosset til del 9).

## 6. Hva del 1 endret i den kjørende konfigurasjonen (oppsummert)

Se [PHASE_1_GATE.md](PHASE_1_GATE.md) for bevismatrisen. Kort: porter bundet/fjernet, modellens verktøyflate redusert til 5 lese-handlinger, executive `command` + `/worker/tick` + `/tools/critical-demo` avvist, selvmodifikasjon og claude-worker frosset, voice-dump av og fail-closed uten ekte STT/TTS, eksplisitt pris for alle modeller, image-pinning, fail-fast env, backup/restore-verktøy, host-skript krever samtykke, og en strukturell sjekk (`pnpm check:containment`).

## 7. Slik produseres runtime-beviset (operatør)

På NAS-en, fra repo-roten (skripet er skrivebeskyttet og skriver aldri hemmeligheter):
```bash
ops/remediation/collect-runtime-baseline.sh > /tmp/jarvis-runtime-baseline.md
```
Lim resultatet inn under en ny overskrift «Runtime-bevis (NAS, <dato>)» i denne filen i en egen commit. På PC-en (PowerShell): `schtasks /Query /TN JarvisClaudeWorker /V /FO LIST`.

Rekkefølge for utrulling av del 1 på NAS-en (hver handling er en host-handling Tobias må gjøre – `BLOCKED_EXTERNAL`):
1. Kjør baseline-scriptet **før** noe endres (gammelt bilde).
2. Sammenlign kjørende image-digests (`docker compose images`/scriptet) mot pinnene; bruk NAS-ens digest hvis den er **nyere/ulik** og kjent god.
3. Backup + restore-bevis ([BACKUP_RESTORE_RUNBOOK.md](BACKUP_RESTORE_RUNBOOK.md)).
4. `git pull` + `docker compose -f infra/local/docker-compose.yml up -d --build`.
5. `ss -tln` og `docker port` – ingen Jarvis-port på `0.0.0.0`.
6. Fantomkostnad: [PHANTOM_COST_COMPENSATION.md](PHANTOM_COST_COMPENSATION.md).
7. Fjern `JARVIS_VOICE_DEBUG_DUMP_DIR` fra `.env`, slett `infra/local/voice-debug-dumps/`.
8. PC: deaktiver `JarvisClaudeWorker`; roter/avgrens GitHub-PAT.
