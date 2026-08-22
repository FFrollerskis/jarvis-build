# D-105 UA-5 host-akseptanse: real-provider observability + kritisk infra-mutasjon/recovery

**Status (2026-08-22): ALLE fire seksjoner (§1/§2/§3) er FAKTISK kjørt av
Tobias mot ekte Windows + Docker Desktop og en ekte GitHub-tilkobling -
`OBSERVABILITY_PROVIDER_LIVE=true`, `REAL_LOG_ACQUISITION=true`,
`DB_STATE_CORRELATION_LIVE=true`, `DEPLOY_OR_VERSION_CORRELATION_LIVE=true`.
`UA5_CRITERION_1=COMPLETE`, `UA5_CRITERION_3=COMPLETE`. §3-kjøringen
ingesterte en EKTE Actions-kjøring for `tsworkflow/jarvisbuild`
(`workflow_run_id=32593753550`, `head_sha=63c598ec693a57cf486da801aa4174197de1149e`
- PR #49 sin egen merge-commit på main), bekreftet idempotent, og
`/incidents/correlate` returnerte en FAKTISK ikke-null `active_deployment`
som eksakt matchet den ingesterte deploy-en. Se D-105-raden
(«UA-5 KANONISK CLOSEOUT»-avsnittet) i DECISIONS_AND_ASSUMPTIONS.md for
full detalj, inkl. hvorfor `suspect_deployment=null` på den ferske
akseptanse-hendelsen er FORVENTET (ingen bevis-tidsvindu ble registrert) og
IKKE en mangel. Denne runboken forblir gyldig som en repeterbar
akseptansesjekk for FREMTIDIGE host-kjøringer, og lar Tobias selv bevise de
samme live-kravene på nytt mot en EKTE, disponibel Docker-daemon (Docker
Desktop eller UGREEN-NAS) og en EKTE GitHub-tilkobling, UTEN å røre noen
produksjonscontainer (`api`/`worker`/`postgres`/`langfuse`/`infisical` i
`infra/local/docker-compose.yml` forblir utouched - denne runboken virker
UTELUKKENDE mot et engangs `jarvis-sentinel-*`-navngitt testmål for §2,
samme "disponibelt engangsmål"-prinsipp som D-103s
`jarvis-d103-acceptance`-repo). INGEN kommando i dette dokumentet er utført
av Claude Code. Krever en ekte, lokalt tilgjengelig `docker`-daemon og en
ekte `JARVIS_GITHUB_TOKEN` som KUN Tobias kjører kommandoene mot.

## Forutsetning

- `docker` CLI installert og en EKTE daemon kjørende (`docker ps` skal
  fungere uten feil) på maskinen som kjører `apps/api`/`apps/worker`.
- `.env` har `JARVIS_DOCKER_BIN=docker` satt (eller full sti til `docker`-
  binæren) - uten denne er `docker`-tool_id-et strukturelt
  `credential_unavailable`, IDENTISK gating-oppførsel som `JARVIS_VERCEL_TOKEN`.
- `api`/`worker` startet normalt (samme oppskrift som D-103-runboken).
- **Identitet/`memory_space` (host-fix, 2026-08-22):** bruk AKKURAT den
  eier-identiteten `apps/api/src/migrate-main.ts` sin `seedOwner()` allerede
  har opprettet på din maskin - `tenant_id="tenant-personal"`,
  `person_id="person-tobias"`, `memory_space="personal"` (samme identitet
  som D-103-runboken bruker, se der linje ~271-274). Alle
  `"memory_space": "..."`-verdier under er DERFOR `"personal"`, IKKE
  `"business"` - en hardkodet `"business"` finnes ikke på en fersk seed og
  gir `identity_denied`/`unknown_memory_space`. Har du seedet en annen
  tenant/memory_space lokalt, bytt ut ALLE forekomster under med DIN
  faktiske, allerede validerte verdi - ALDRI gjett en verdi runboken selv
  ikke har bekreftet eksisterer.

## §1 Real observability-innhenting (kriterium 1)

1. Opprett en hendelse:
   ```
   POST /incidents/create
   { "identity": {...eier-identitet, se Forutsetning...}, "memory_space": "personal", "title": "D-105 host acceptance" }
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
   { "identity": {...}, "memory_space": "personal", "incident_id": "<fra §1>",
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

**VIKTIG - host-fix (D-41-korreksjon, 2026-08-22):** mål-autorisasjon sitter
IKKE lenger i transporten. `docker-target-policy.ts` sin `authorizeDockerTarget()`
(håndhevet av `ToolGateway.execute()` via `parameterAuthorizer`) skiller
EKSPLISITT mellom to tier:

- **AKSEPTANSE (denne runboken):** `jarvis-sentinel-*` er ALLTID tillatt for
  ALLE muterende docker-handlinger (`redeploy_container`/`stop_container`/
  `start_container`) - uavhengig av `JARVIS_DOCKER_MUTATION_TARGETS`. Denne
  runboken bruker UTELUKKENDE denne veien, mot et disponibelt engangsmål -
  ALDRI en ekte tjeneste.
- **PRODUKSJON (IKKE denne runboken):** et eier-konfigurert ekte mål
  (`JARVIS_DOCKER_MUTATION_TARGETS=jarvis-api-1,...`) kan KUN nås av
  `stop_container`/`start_container` (bevist trygge - ren kjøretilstand,
  INGEN konfigurasjon å miste). `redeploy_container` forblir STRUKTURELT
  DEFERRED for produksjon (kun sentinel) - nåværende implementasjon bevarer
  IKKE mounts/miljøvariabler/nettverk/porter/restart-policy/healthcheck ved
  rekonstruksjon, og er derfor IKKE eksponert mot ekte tjenester før en
  konfigurasjonsbevarende redeploy er bygget og bevist (se D-105-raden i
  DECISIONS_AND_ASSUMPTIONS.md).

Denne runboken beviser DEN SAMME produksjonskode-veien (ingen egen
"akseptanse-modus" i selve `executeInfraMutation()`/`ToolGateway`), men
pålegger en EKSTRA akseptanse-only mål-restriksjon (sentinel-navn) - denne
distinksjonen (samme kode, ekstra akseptanse-scoping) er bevisst, ikke en
svakhet i noen av veiene.

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

## §3 Real GitHub deployment-ingestion + korrelasjon (kriterium 1)

**Status (2026-08-22): `DEPLOY_OR_VERSION_CORRELATION_LIVE=true` - denne
seksjonen ER kjørt live av Tobias** (ingest av `workflow_run_id=32593753550`,
`head_sha=63c598ec693a57cf486da801aa4174197de1149e`; idempotens bekreftet;
`/incidents/correlate` returnerte en ikke-null `active_deployment` som
eksakt matchet den ingesterte deploy-en - se D-105-raden i
DECISIONS_AND_ASSUMPTIONS.md for full detalj). Seksjonen under forblir
gyldig som en repeterbar akseptansesjekk for FREMTIDIGE kjøringer (f.eks.
etter en fremtidig endring i selve ingestion-koden). Ruten:
`POST /deployments/ingest/github` - går GJENNOM den eksisterende
`ToolGateway.execute()`-veien (`github.get_workflow_run` + best-effort
`github.get_commit`), ALDRI et direkte GitHub-HTTP-kall og ALDRI en seedet/
fabrikkert deploy (se `modules/incidents/src/deployment-ingestion.ts`).

1. Finn en EKTE, allerede eksisterende Actions-workflow-kjøring for
   `tsworkflow/jarvisbuild` (f.eks. siste `CI`-kjøring på `main` - hent
   `run_id`-en fra GitHub sin Actions-fane, eller via
   `gh run list --repo tsworkflow/jarvisbuild --limit 1`).
2. Ingest DEN kjøringen gjennom den nye produksjonsruten:
   ```
   POST /deployments/ingest/github
   { "identity": {...eier-identitet, se Forutsetning...},
     "repo": "tsworkflow/jarvisbuild", "workflow_run_id": "<ekte run_id fra steg 1>" }
   ```
   Forventet: `200 OK`, `deployment.commit_sha` er den FAKTISKE `head_sha`-
   en fra kjøringen, `deployment.status` reflekterer FAKTISK
   status/conclusion (ALDRI en gjettet `success`), `deployment.deployed_at`
   er GitHub sitt EKTE `created_at`-tidsstempel for kjøringen (ALDRI
   tidspunktet du kjørte kommandoen). Bekreft dette manuelt mot GitHub sin
   UI/`gh run view <run_id>` FØR du går videre.
3. Kjør SAMME ingestion en gang til med IDENTISK `workflow_run_id`:
   forventet `created=false` og SAMME `deployment.deployment_id` som steg 2
   - beviser idempotens (ingen duplikatrad).
4. Opprett en hendelse og korreler:
   ```
   POST /incidents/create
   { "identity": {...}, "memory_space": "personal", "title": "D-105 GitHub deployment-ingestion host acceptance" }
   ```
   ```
   POST /incidents/correlate
   { "identity": {...}, "memory_space": "personal", "incident_id": "<fra over>", "repo": "tsworkflow/jarvisbuild" }
   ```
   Forventet: `correlation.active_deployment` er IKKE lenger `null` - den
   peker på deploy-en fra steg 2, med FAKTISK `commit_sha`/`workflow_run_id`.
   **`DEPLOY_OR_VERSION_CORRELATION_LIVE=true` krever nøyaktig dette svaret
   - ALDRI markert `true` uten at `active_deployment` faktisk er ikke-null
   med FAKTISK provenance fra steg 2.**
5. (Valgfritt, kun hvis du faktisk har relevant bevis å teste tidsvindu-
   logikken mot) Legg til reelt bevis via
   `POST /incidents/evidence/add` med en `observed_at` etter deploy-ens
   `deployed_at`, korreler på nytt, og bekreft at `correlation.
   suspect_deployment` FAKTISK peker på riktig deploy per den
   deterministiske `findSuspectDeployment()`-logikken (nyeste deploy FØR
   `observed_at`, `null` hvis ingen finnes - ALDRI gjettet). Har du ikke et
   ekte tidsrelevant bevis å teste med: hopp over dette steget og la
   `suspect_deployment` forbli udokumentert `null` for denne kjøringen -
   ALDRI konstruer et kunstig bevis kun for å tvinge frem en `suspect_deployment`.
   (Dette var NØYAKTIG det som skjedde i den FAKTISKE 2026-08-22-kjøringen:
   den ferske akseptanse-hendelsen hadde ingen registrert bevis, så
   `suspect_deployment=null` - `active_deployment` alene var tilstrekkelig
   for å bevise `DEPLOY_OR_VERSION_CORRELATION_LIVE=true`, jf. steg 4.)

## §4 Etter kjøring

Oppdater `docs/DECISIONS_AND_ASSUMPTIONS.md` (D-105-raden) og
`docs/PROJECT_STATUS.md` med de FAKTISKE flaggverdiene observert over
(`OBSERVABILITY_PROVIDER_LIVE`/`REAL_LOG_ACQUISITION`/
`DEPLOY_OR_VERSION_CORRELATION_LIVE`/`DB_STATE_CORRELATION_LIVE`/
`REAL_CRITICAL_INFRA_MUTATION`/`BEFORE_STATE_CAPTURED`/`AFTER_STATE_CAPTURED`/
`CANONICAL_DIFF_VERIFIED`/`REAL_RECOVERY_EXECUTED`/`RECOVERY_STATE_VERIFIED`)
- ALDRI markert `true` uten en faktisk kjøring som beviser det, per samme
  ærlighetsdisiplin som D-103.
