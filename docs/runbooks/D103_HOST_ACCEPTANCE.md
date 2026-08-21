# D-103 UA-5 host-akseptanse: produksjonskode-reachability (Blokker A + B)

**Status:** ÉN gang KJØRT av Tobias (task `d103-host-acceptance-986f37e6`), fant en
ekte, tidligere ukjent tredje feil (git credential-hijack via ambient
`credential.helper` - se "Historisk funn" under) - DENNE reparerte versjonen av
runboken er IKKE kjørt ennå. INGEN kommando i dette dokumentet er utført av
Claude Code. Krever ekte `ANTHROPIC_API_KEY` og `JARVIS_GITHUB_TOKEN` som KUN
Tobias skal skrive inn.

## Historisk funn: FØRSTE ekte kjøring (2026-08-21, task `d103-host-acceptance-986f37e6`)

Denne runboken (D-103 sin opprinnelige versjon) ble kjørt ÉN gang på Tobias sin
Windows-host, FØR "d103-host-git-auth-isolation-repair". Resultatet var delvis
vellykket og avdekket en TREDJE, tidligere ukjent produksjonsblokker:

- Produksjons-`api` OG produksjons-`worker` startet BEGGE korrekt.
- En ekte kodejobb ble sendt inn via `/tasks/submit`.
- **Blokker A-fiksen fungerte LIVE:** riktig coding-worker (`worker-903f4a30`)
  claimet jobben - IKKE `main.ts` sin egen (executive-only) worker.
- Den ekte `ClaudeCodeAgent`-koden nådde helt frem til `git push` (klone,
  endre, teste, committe fullførte alle).
- Push FEILET: `remote: Permission to <testrepo> denied to post-ops. fatal:
  unable to access ... error 403`.
- Verifisert i SAMME PowerShell-prosess `worker-main.ts` ble startet fra:
  `JARVIS_GITHUB_TOKEN` var SATT, autentiserte til GitHub API som forventet
  eier-identitet med bekreftet push/admin-tilgang.
- Push-forespørselen brukte likevel en HELT ANNEN, ambient, cached identitet
  (`post-ops`) - IKKE den forventede eier-identiteten, til tross for at
  `JARVIS_GITHUB_TOKEN` var korrekt konfigurert.

Root cause (bevist, se `git-auth.ts` og D-103 HOST-FIX i
`DECISIONS_AND_ASSUMPTIONS.md`): git spør ALLTID en ambient `credential.helper`
(typisk Git Credential Manager, ofte registrert SYSTEM-nivå av Git for Windows-
installereren) FØR `GIT_ASKPASS` i det hele tatt konsulteres - askpass er en
ren prompt-FALLBACK, aldri en prioritert credential-kilde. `d103-host-git-auth-
isolation-repair` fikser DETTE (git sin egen `-c credential.helper=`-mekanisme
nullstiller helper-kjeden prosess-lokalt for AKKURAT clone/push) OG en separat,
latent bug i selve askpass-invokeringsformatet (se samme dokumentasjon).

**Tobias trenger IKKE slette, logge ut av, eller endre sin normale Git
Credential Manager-tilstand for å kjøre denne runboken på nytt.** Den
konfliktende, cachede `post-ops`-kontoen er faktisk NYTTIG bevis: hvis en
rerun fortsatt lykkes (pusher/PR-er som den forventede identiteten) MENS
`post-ops` fortsatt er cachet på maskinen, er det et direkte bevis på at
isolasjonsfiksen faktisk virker i nærvær av en reell, konkurrerende ambient
credential - ikke bare i et rent testmiljø.

## Hva denne runboken beviser

D-103 fikset to strukturelle blokkere som ble avdekket under D-102-revisjonen:

- **Blokker A**: flere worker-prosesser (`apps/api/src/main.ts` sin egen
  in-process-worker og `apps/api/src/worker-main.ts` sin egen) pollet samme
  kø uten profil-filter, og kunne claime hverandres jobbtyper. Denne runboken
  kjører BEGGE prosessene SAMTIDIG (nøyaktig produksjonstopologien) og
  verifiserer at `coding`-jobben blir hentet av `worker-main.ts` sin worker
  (den eneste med en `coding`-handler) - aldri av `main.ts` sin.
- **Blokker B**: `git clone`/`git push` i kodejobb-sandboxen hadde ingen
  credential-kanal. Denne runboken lar en EKTE `ClaudeCodeAgent`-jobb
  klone, endre, teste, committe, pushe en branch og åpne en EKTE GitHub-PR
  mot et repo Tobias selv velger (bruk et engangs-testrepo, ALDRI
  `jarvisbuild` selv).

## Forutsetninger (én gang)

1. Docker Desktop kjører (Postgres via `infra/local/docker-compose.yml`).
2. Node 22 og pnpm installert; `pnpm install` allerede kjørt i repo-roten.
3. En installert `claude`-CLI-binær (Claude Code, headless), sti kjent på forhånd.
4. Et EKTE, men DISPONIBELT GitHub-testrepo Tobias eier (IKKE `jarvisbuild`),
   med en `main`-branch og minst én commit, som en Anthropic-nøkkel-drevet
   agent får lov til å pushe branches til og åpne PR-er mot.
5. En GitHub PAT (klassisk eller fine-grained) med MINST `repo`-scopet mot
   akkurat det testrepoet (se `.env.example` sin `JARVIS_GITHUB_TOKEN`-seksjon
   for fullt scope-krav - `workflow`-scopet trengs IKKE for denne runboken,
   kun for `dispatch_workflow`/`rerun_workflow_run`/`cancel_workflow_run`).
6. En ekte `ANTHROPIC_API_KEY`.

## Sikker hemmelighet-inntasting (revidert - IKKE lim samme verdi inn flere steder)

Forrige runbok-generasjon ba om at samme hemmelighet ble limt inn i FLERE
separate PowerShell-vinduer (`$env:X = "<verdi>"` i vindu A, SAMME verdi i
vindu B). Det er to problemer med det mønsteret: (1) en literal
`$env:X = "sk-ant-..."`-linje BLIR liggende i PSReadLine sin kommandohistorikk
(`(Get-PSReadlineOption).HistorySavePath`) i klartekst, og (2) manuell
gjeninntasting i flere vinduer øker sjansen for at en verdi ved et uhell
limes et tredje sted (chat, notatblokk).

Denne runboken løser BEGGE: **ÉN PowerShell-økt**, hemmelighetene tastes inn
ÉN gang via `Read-Host -AsSecureString` (som ALDRI skriver klartekst til
skjerm ELLER historikk - PSReadLine lagrer kun selve kommandolinjen som ble
kjørt, `Read-Host` sitt svar er brukerinput til et running program, ikke en
del av kommandolinjen), konverteres til klartekst KUN i en lokal variabel i
minnet, og injiseres i `$env:`-blokken til DENNE prosessen FØR `api`- og
`worker`-prosessene startes SOM BARN av denne samme økten (`Start-Process`
arver forelderens miljø automatisk - ingen manuell re-inntasting i et nytt
vindu).

```powershell
# === D-103 host-akseptanse: ÉN PowerShell-økt, kjøres fra repo-roten ===
$ErrorActionPreference = "Stop"

function Read-SecretPlain([string]$prompt) {
    $secure = Read-Host -Prompt $prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# Hemmeligheter tastes inn ÉN gang hver, skjules mens du skriver, havner
# ALDRI i $Host sin skjermbuffer eller PSReadLine-historikken.
$anthropicKey = Read-SecretPlain "ANTHROPIC_API_KEY"
$githubToken  = Read-SecretPlain "JARVIS_GITHUB_TOKEN (PAT, repo-scope, testrepo)"
$dbAdminPass  = Read-SecretPlain "Postgres admin-passord (velg et nytt, lokalt engangspassord)"
$dbRuntimePass = Read-SecretPlain "Postgres runtime-passord (velg et nytt, lokalt engangspassord)"

$claudeBin = Read-Host "Full sti til 'claude'-CLI-binæren"
$testRepoUrl = Read-Host "HTTPS-URL til DISPONIBELT GitHub-testrepo (f.eks. https://github.com/<deg>/<testrepo>.git)"

# Delt env for DENNE økten - arves av alle Start-Process-barn under. Aldri
# skrevet til disk, aldri en del av selve kommandolinjen som ble tastet inn.
$env:JARVIS_ENV = "dev"
$env:JARVIS_API_PORT = "3010"
$env:JARVIS_DB_HOST = "127.0.0.1"
$env:JARVIS_DB_PORT = "5432"
$env:JARVIS_DB_NAME = "jarvis"
$env:JARVIS_DB_ADMIN_USER = "postgres"
$env:JARVIS_DB_ADMIN_PASSWORD = $dbAdminPass
$env:JARVIS_DB_USER = "jarvis_runtime"
$env:JARVIS_DB_PASSWORD = $dbRuntimePass
$env:JARVIS_DB_RUN_MIGRATIONS = "false"   # migrate-main.ts kjøres eksplisitt under, ikke ved api-oppstart
$env:JARVIS_BUDGET_APPROVED = "true"
$env:ANTHROPIC_API_KEY = $anthropicKey
$env:JARVIS_GITHUB_TOKEN = $githubToken
$env:JARVIS_CLAUDE_BIN = $claudeBin
$env:JARVIS_TENANT_ID = "tenant-personal"
$env:JARVIS_OWNER_PERSON_ID = "person-tobias"

# 1) Postgres opp (samme docker-compose som ellers i prosjektet)
docker compose -f infra/local/docker-compose.yml up -d postgres
Start-Sleep -Seconds 5

# 2) Migrasjoner + owner-seed (admin-rolle, ÉN gang - oppretter/bekrefter
#    tenant-personal/person-tobias/device jarvis-core/memory_space personal)
node --experimental-transform-types apps/api/src/migrate-main.ts

# 3) Start api (main.ts) og worker (worker-main.ts) som ADSKILTE prosesser
#    i SAMME miljø - dette ER produksjonstopologien Blokker A gjaldt.
$apiProc = Start-Process -PassThru -NoNewWindow node `
    -ArgumentList "--experimental-transform-types","apps/api/src/main.ts"
$workerProc = Start-Process -PassThru -NoNewWindow node `
    -ArgumentList "--experimental-transform-types","apps/api/src/worker-main.ts"

Start-Sleep -Seconds 3
Write-Host "api pid=$($apiProc.Id) worker pid=$($workerProc.Id)"

# 4) Send inn EN EKTE kodejobb via /tasks/submit - identiteten under er
#    AKKURAT den migrate-main.ts sin seedOwner() allerede opprettet.
$taskId = "d103-host-acceptance-" + [guid]::NewGuid().ToString("N").Substring(0,8)
$body = @{
    identity = @{
        person_id = "person-tobias"; tenant_id = "tenant-personal"
        memory_space = "personal"; session_id = "sess-d103-host-run"
        device_id = "jarvis-core"; channel = "api"; auth_strength = "active"
    }
    contract = @{
        task_id = $taskId
        owner_person_id = "person-tobias"; tenant_id = "tenant-personal"
        goal = "Legg til en linje i README.md som bekrefter D-103 host-akseptanse ble kjort $(Get-Date -Format o)"
        acceptance_criteria = @("README.md er endret")
        input = @{
            data = @{ repo_url = $testRepoUrl; test_command = @("node","-e","process.exit(0)") }
            trust_level = "internal"; provenance = "d103-host-acceptance-runbook"
        }
        allowed_tools = @("github")
        allowed_memory_spaces = @("personal")
        allowed_network_targets = @()
        agent_profile = "coding"
        model_budget_ore = 20000
        retry_policy = @{ max_attempts = 1; backoff_seconds = 0 }
        max_steps = 5
    }
} | ConvertTo-Json -Depth 10

$submitResult = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3010/tasks/submit" `
    -ContentType "application/json" -Body $body
Write-Host "task_id=$($submitResult.task_id)"

# 5) Poll status - direkte SQL, IKKE gjennom /tasks/submit sitt svar (ingen
#    status-GET-rute finnes i dag, se coding.ts/server.ts).
$env:PGPASSWORD = $dbAdminPass
$deadline = (Get-Date).AddMinutes(5)
do {
    Start-Sleep -Seconds 5
    $row = docker compose -f infra/local/docker-compose.yml exec -T postgres `
        psql -U postgres -d jarvis -t -A -F "|" `
        -c "SELECT status, worker_id, last_error FROM tasks WHERE task_id = '$taskId';"
    Write-Host "status: $row"
} while ($row -match "^running" -and (Get-Date) -lt $deadline)

# 6) Verifiser Blokker A: worker_id for DENNE jobben skal IKKE vaere
#    api-prosessens (main.ts) egen in-process-worker (kun "executive"
#    registrert der) - status skal vaere 'completed' eller en agent-/
#    testfeil, ALDRI 'ingen handler for coding'.
# 7) Verifiser Blokker B: sjekk resultatet (artifacts / pr-result.json) for
#    en ekte PR-URL, og bekreft manuelt i GitHub UI at branchen/PR-en
#    faktisk finnes pa testRepoUrl - IKKE i jarvisbuild.
docker compose -f infra/local/docker-compose.yml exec -T postgres `
    psql -U postgres -d jarvis -t -A -c "SELECT result FROM tasks WHERE task_id = '$taskId';"

# 8) Opprydding
Stop-Process -Id $apiProc.Id -Force
Stop-Process -Id $workerProc.Id -Force
Remove-Item Env:\ANTHROPIC_API_KEY, Env:\JARVIS_GITHUB_TOKEN, Env:\JARVIS_DB_ADMIN_PASSWORD, `
    Env:\JARVIS_DB_PASSWORD, Env:\PGPASSWORD -ErrorAction SilentlyContinue
# docker compose -f infra/local/docker-compose.yml down   # valgfritt - lar Postgres-data ligge igjen hvis utelatt
```

## Hva et vellykket resultat ser ut som

Etter `d103-host-git-auth-isolation-repair` skal en rerun eksplisitt bevise
ALLE disse (ikke bare "jobben fullførte"):

- `WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true` - `tasks.worker_id` er
  `worker-main.ts` sin prosess, ALDRI `main.ts` sin (samme som forrige kjøring,
  uendret av denne reparasjonen).
- `CLONE_AUTH_VERIFIED=true` - `git clone` fullførte uten
  `git_auth_unavailable` eller en `clone_failed`-feil.
- `PUSH_AUTH_VERIFIED=true` - `git push` fullførte UTEN et `403 Permission
  denied`-avvik (dette var AKKURAT det som feilet i den forrige kjøringen).
- `EXPECTED_TOKEN_IDENTITY_MATCH=true` - kontroller manuelt i GitHub UI (PR-en/
  branchens "Created by"/commit-forfatter, eller repo sin Insights → Traffic/
  Audit log hvis tilgjengelig) at handlingen ble utført av DEN FORVENTEDE
  eier-identiteten (samme identitet `JARVIS_GITHUB_TOKEN` autentiserer som via
  GitHub API) - IKKE en ukjent/uventet konto.
- `AMBIENT_HOST_CREDENTIAL_DID_NOT_OVERRIDE=true` - hvis en ambient
  Git Credential Manager-konto (som `post-ops` fra forrige kjøring) fortsatt
  er cachet på maskinen, skal DEN kontoen ALDRI dukke opp noe sted i denne
  kjøringens PR/branch/commit-forfatterskap.
- `PR_CREATED=true` - `tasks.result` inneholder et `pr`-felt med en ekte GitHub
  PR-URL på `testRepoUrl`, OG en reell, åpen PR er synlig i GitHub UI.
- `tasks.status = 'completed'` for `$taskId`.
- Ingen `git_auth_unavailable`-feil (ville bety at `JARVIS_GITHUB_TOKEN`
  ikke ble lest korrekt).
- Ingen `claude_code_not_configured`-feil (ville bety at `JARVIS_CLAUDE_BIN`
  ikke pekte på en gyldig binær).

## Hva en mislykket kjøring betyr

| Feil i `last_error` | Betydning |
|---|---|
| `git_auth_unavailable` | `JARVIS_GITHUB_TOKEN` ikke satt/lesbar for worker-prosessen |
| `claude_code_not_configured` | `JARVIS_CLAUDE_BIN` peker ikke på en kjørbar `claude` |
| `policy_denied:*` | `JARVIS_OWNER_PERSON_ID`/`JARVIS_TENANT_ID` matcher ikke identiteten i steg 4 - sjekk SOVEREIGN-autoritetsoppsettet i `worker-main.ts` |
| `clone_failed: *` | `$testRepoUrl` feil, eller PAT mangler `repo`-scope, eller repoet finnes ikke |
| `NO_CHANGES_TO_COMMIT` | Agenten (ærlig) fant ikke grunnlag for en endring - prøv et enklere `goal` |
| (ingen rad i det hele tatt) | `/tasks/submit` feilet FØR jobben ble lagt i køen - sjekk `$submitResult`/api-loggen |
| `push_failed: ... Permission ... denied to <ukjent-konto>` | Skulle IKKE lenger skje etter `d103-host-git-auth-isolation-repair` - dette er AKKURAT feilklassen fra den forrige kjøringen (ambient `credential.helper` kapret auth). Skjer det likevel: samle `git -c credential.helper= credential fill`-output og eksakt `last_error`, IKKE forsøk å fikse ved å slette Git Credential Manager-tilstand selv - meld tilbake i stedet. |

**Live-verifiseringsstatus for DENNE reparasjonen (ærlig, ikke fabrikkert):**
denne runboken er ENDRET (nye forventede suksessmarkører over) men IKKE kjørt
av Claude Code etter `d103-host-git-auth-isolation-repair`. `LIVE_E2E_
VERIFIED=false`, `TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=false`,
`HOST_ACTION_REQUIRED=true` forblir presist slik inntil Tobias kjører DENNE
versjonen på nytt og et ekte push+PR faktisk fullfører med riktig identitet.
`WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true` og `REAL_CODING_JOB_REACHED_GIT_
PUSH=true` er derimot ALLEREDE bevist ekte (fra den forrige kjøringen,
uendret av denne reparasjonen). Alle andre felter i tabellen over er forventet
oppførsel BASERT PÅ kildekoden (verifisert ved lesing, se D-103 og D-103
HOST-FIX i `docs/DECISIONS_AND_ASSUMPTIONS.md`), IKKE en observert live-kjøring
av DENNE reparerte versjonen.
