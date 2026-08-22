# D-105 UA-5 host-akseptanse: real-provider observability + kritisk infra-mutasjon/recovery

**Status: IKKE ENNÅ KJØRT. FIXED_SUITE_VERIFIED (embedded-Postgres + reell
`docker`-CLI-subprosess mot en fake kjørbar fil, se `modules/tool-gateway/
test/docker-transport.test.ts` og `modules/incidents/test/infra-execution.test.ts`),
INGEN LIVE_VERIFIED-status krevd/påstått ennå.** Denne runboken lar Tobias
selv bevise de gjenværende live-kravene for UA-5 kriterium 1 og 3 mot en
EKTE, disponibel Docker-daemon (Docker Desktop eller UGREEN-NAS), UTEN å
røre noen produksjonscontainer (`api`/`worker`/`postgres`/`langfuse`/
`infisical` i `infra/local/docker-compose.yml` forblir utouched - denne
runboken virker UTELUKKENDE mot et engangs `jarvis-sentinel-*`-navngitt
testmål, samme "disponibelt engangsmål"-prinsipp som D-103s
`jarvis-d103-acceptance`-repo). INGEN kommando i dette dokumentet er utført
av Claude Code. Krever en ekte, lokalt tilgjengelig `docker`-daemon som KUN
Tobias kjører kommandoene mot.

## Forutsetning

- `docker` CLI installert og en EKTE daemon kjørende (`docker ps` skal
  fungere uten feil) på maskinen som kjører `apps/api`/`apps/worker`.
- `.env` har `JARVIS_DOCKER_BIN=docker` satt (eller full sti til `docker`-
  binæren) - uten denne er `docker`-tool_id-et strukturelt
  `credential_unavailable`, IDENTISK gating-oppførsel som `JARVIS_VERCEL_TOKEN`.
- `api`/`worker` startet normalt (samme oppskrift som D-103-runboken).

## §1 Real observability-innhenting (kriterium 1)

1. Opprett en hendelse:
   ```
   POST /incidents/create
   { "identity": {...eier-identitet...}, "memory_space": "business", "title": "D-105 host acceptance" }
   ```
2. Kjør ETT reelt docker-kall for å bevise providerens helse:
   ```
   POST /observability/docker/status
   { "identity": {...} }
   ```
   Forventet: `status.available = true`, `status.containers` inneholder
   FAKTISKE, ekte containernavn fra din maskin (f.eks. `jarvis-api-1`).
   **`OBSERVABILITY_PROVIDER_LIVE=true` krever nøyaktig dette svaret.**
3. Hent EKTE, ferske logglinjer fra en EKSISTERENDE, allerede kjørende
   container (f.eks. den ekte `api`-containeren - lese-handlinger er IKKE
   sentinel-begrenset, se `docker-transport.ts`):
   ```
   POST /incidents/evidence/acquire_logs
   { "identity": {...}, "memory_space": "business", "incident_id": "<fra §1>",
     "container": "jarvis-api-1", "tail": 20 }
   ```
   Forventet: `evidence` er en liste med `incident_evidence`-rader,
   `summary`-feltet inneholder FAKTISK loggtekst FRA DIN containers stdout,
   `source_type="log"`. **`REAL_LOG_ACQUISITION=true` krever dette.**
4. Inspiser en verifiserbar korrelasjon mot DB-tilstand:
   ```
   POST /incidents/correlate/db
   { "identity": {...}, "window_start": "<for 1 time siden>", "window_end": "<nå>" }
   ```
   Forventet: `db_state.connectivity="ok"`, `db_state.latest_migration` peker
   på FAKTISK siste anvendte migrasjon i din database.
   **`DB_STATE_CORRELATION_LIVE=true` krever dette.**

## §2 Kritisk infra-mutasjon + tested recovery (kriterium 3)

**ALDRI mot et produksjonsnavn** - `docker.redeploy_container` NEKTER
strukturelt alt annet enn `jarvis-sentinel-*` (se `assertSentinelTarget()` i
`docker-transport.ts`, håndhevet I TRANSPORTEN, ikke bare i policy).

1. Utfør den FØRSTE mutasjonen (oppretter et disponibelt testmål fra bunnen av):
   ```
   POST /infra/execution/mutate
   { "identity": {...}, "target": "jarvis-sentinel-host-run-1",
     "target_image": "alpine:3.19", "idempotency_key": "d105-host-1" }
   ```
   Forventet: `execution.before_state=null` (ingen tidligere container),
   `execution.after_state.image="alpine:3.19"`, `execution.after_state.status="running"`,
   `execution.verification_outcome="SUCCESS"`.
   **`REAL_CRITICAL_INFRA_MUTATION=true`/`AFTER_STATE_CAPTURED=true` krever dette.**
2. Bekreft FAKTISK via `docker ps`/`docker inspect jarvis-sentinel-host-run-1`
   i et eget terminalvindu - containeren skal FAKTISK kjøre `alpine:3.19`.
3. Utfør en ANDRE mutasjon (ekte before-tilstand denne gangen):
   ```
   POST /infra/execution/mutate
   { "identity": {...}, "target": "jarvis-sentinel-host-run-1",
     "target_image": "alpine:3.20", "idempotency_key": "d105-host-2" }
   ```
   Forventet: `execution.before_state.image="alpine:3.19"`,
   `execution.after_state.image="alpine:3.20"`, `execution.state_diff.changed.image`
   viser FAKTISK `{before:"alpine:3.19", after:"alpine:3.20"}`.
   **`BEFORE_STATE_CAPTURED=true`/`CANONICAL_DIFF_VERIFIED=true` krever dette.**
4. Utfør EKTE recovery tilbake til forrige image:
   ```
   POST /infra/recovery/attempt
   { "identity": {...}, "tool_id": "docker", "action": "redeploy_container",
     "idempotency_key": "d105-host-2",
     "parameters": { "name": "jarvis-sentinel-host-run-1", "image": "alpine:3.20" },
     "execution_id": "<execution_id fra steg 3>" }
   ```
   Forventet: `recovery.status="SUCCESS"`, `recovery.recovery_of_execution_id`
   peker på steg 3 sin `execution_id`. Bekreft FAKTISK via
   `docker inspect jarvis-sentinel-host-run-1` at image nå er `alpine:3.19` igjen.
   **`REAL_RECOVERY_EXECUTED=true`/`RECOVERY_STATE_VERIFIED=true` krever dette.**
5. Rydd opp testmålet manuelt (denne runboken oppretter et ekte, om enn
   trivielt, disponibelt objekt - IKKE en simulert en):
   ```
   docker rm -f jarvis-sentinel-host-run-1
   ```

## §3 Etter kjøring

Oppdater `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-105-raden) og
`docs/PROJECT_STATUS.md` med de FAKTISKE flaggverdiene observert over
(`OBSERVABILITY_PROVIDER_LIVE`/`REAL_LOG_ACQUISITION`/
`DEPLOY_OR_VERSION_CORRELATION_LIVE`/`DB_STATE_CORRELATION_LIVE`/
`REAL_CRITICAL_INFRA_MUTATION`/`BEFORE_STATE_CAPTURED`/`AFTER_STATE_CAPTURED`/
`CANONICAL_DIFF_VERIFIED`/`REAL_RECOVERY_EXECUTED`/`RECOVERY_STATE_VERIFIED`)
- ALDRI markert `true` uten en faktisk kjøring som beviser det, per samme
  ærlighetsdisiplin som D-103.
