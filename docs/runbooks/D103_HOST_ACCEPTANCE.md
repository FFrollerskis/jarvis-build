# D-103 UA-5 host-akseptanse: produksjonskode-reachability (Blokker A + B)

**Status: TRE GANGER kjørt av Tobias - TREDJE KJØRING LYKTES FULLSTENDIG.**
Kjøring 1 (`d103-host-acceptance-986f37e6`) fant en git credential-hijack via
ambient `credential.helper` - fikset av "d103-host-git-auth-isolation-repair"
(v1, merget). Kjøring 2 (`d103-host-acceptance-d5294343`), ETTER v1 var
merget, beviste v1s isolasjon FAKTISK virket (ingen ambient identitet
lenger), men fant en NY Windows-spesifikk feil i selve v1s `GIT_ASKPASS`-
invokeringsmekanisme (se "Historisk funn" under) - fikset av
"d103-git-credential-helper-windows-repair" (v2, merget som PR #46,
merge-commit `ad96d33`). **Kjøring 3 (`d103-host-final-ea3e6b3f`, worker
`worker-aa818fcf`), mot DENNE kanoniske `main`-en, MED system-nivå
`credential.helper=manager` fortsatt bevisst uendret: LYKTES FULLSTENDIG**
- `status=completed`, `tests=passed`, `branch=jarvis/d103-host-final-ea3e6b3f`,
`commit_sha=8a9fda6d172193e4abb002dad814411ffb629300`, ekte PR opprettet
(`tsworkflow/jarvis-d103-acceptance#1`, bevisst IKKE merget - engangs
aksepttest-repo). Se "Historisk funn: TREDJE ekte kjøring" under for full
detalj. D-103 (v1+v2) er dermed `CANONICAL / WINDOWS_LIVE_E2E_VERIFIED /
COMPLETE` - UA-5 kriterium 2 er `COMPLETE`. Denne runboken forblir i repoet
som dokumentasjon av den fulle historikken og som mal for en EVENTUELL
fremtidig re-kjøring (f.eks. etter en fremtidig reparasjon som igjen
berører git-transport-autentisering) - INGEN videre kjøring er påkrevd for
D-103 selv. INGEN kommando i dette dokumentet er utført av Claude Code.
Krever ekte `ANTHROPIC_API_KEY` og `JARVIS_GITHUB_TOKEN` som KUN Tobias skal
skrive inn.

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

## Historisk funn: ANDRE ekte kjøring (2026-08-21, task `d103-host-acceptance-d5294343`, ETTER v1 merget)

Denne runboken (v1s reparerte versjon, "d103-host-git-auth-isolation-repair")
ble kjørt på nytt på Tobias sin Windows-host, mot kanonisk `main` (merge-commit
`ad5eb92`), med Git for Windows sin system-nivå `credential.helper=manager`
BEVISST bevart uendret (som instruert i forrige kjørings historiske funn over):

- Produksjons-`api` OG produksjons-`worker` startet BEGGE korrekt fra
  kanonisk `main`.
- En ekte kodejobb ble sendt inn via `/tasks/submit` - worker `worker-782f9ac8`
  claimet jobben korrekt (Blokker A-fiksen fortsatt bevist LIVE).
- **v1s isolasjonsfiks FUNGERTE:** INGEN `post-ops`-identitet (eller noen
  annen ambient identitet) dukket opp noe sted i denne kjøringen -
  `AMBIENT_CREDENTIAL_HELPER_CAN_OVERRIDE_JARVIS_AUTH=false` bekreftet LIVE,
  selv MED system-nivå Git Credential Manager fortsatt konfigurert.
- Push FEILET likevel, på et HELT ANNET sted enn forrige gang:
  `error: cannot spawn "C:\Users\Tobia\AppData\Local\Temp\jarvis-git-askpass-
  <x>\askpass.cmd": Permission denied` etterfulgt av `fatal: could not read
  Username for 'https://github.com': terminal prompts disabled`.
- Dette er STRUKTURELT forskjellig fra forrige feil: ingen ambient identitet
  ble noensinne konsultert (isolasjonen virket), OG terminal-fallback-sperren
  virket korrekt (`GIT_TERMINAL_PROMPT=0` hindret en interaktiv prompt) -
  KUN selve v1s `GIT_ASKPASS`-skript-invokeringsmekanisme klarte ikke å starte
  på ekte Windows.

Root cause (utledet fra dokumentert git/Windows-prosessoppstart-mekanikk, se
`git-auth.ts` og D-103 HOST-FIX v2 i `DECISIONS_AND_ASSUMPTIONS.md` for full
begrunnelse - IKKE personlig live-bevist av Claude Code mot en ekte
Windows-boks): git kaller `GIT_ASKPASS` med `use_shell=1`, men hopper over
selve shell-innpakningen for en bar kommandostreng uten shell-metategn - git
kaller da `CreateProcessW()` DIREKTE på `.cmd`-stien, som IKKE er et gyldig
Win32 PE-kjørbart avbilde og derfor strukturelt ikke kan lastes direkte.
"d103-git-credential-helper-windows-repair" fikser DETTE ved å erstatte
`GIT_ASKPASS` HELT med git sin `credential.helper`-mekanisme (`-c
credential.helper=!"<node>" "<skript>"`, alltid shell-evaluert på begge
plattformer - ALDRI en direkte `CreateProcess()` av en genererte fil).

**Tobias trenger, akkurat som forrige gang, IKKE slette, logge ut av, eller
endre sin normale Git Credential Manager-tilstand.** Den fortsatt konfliktende
`credential.helper=manager`-registreringen er igjen nyttig bevis: at v1s
isolasjon fortsatt holder (ingen ambient identitet lekker inn) MENS v2s nye
`credential.helper`-mekanisme SELV skal fungere, er en sterkere test enn et
rent, ambient-fritt miljø.

## Historisk funn: TREDJE ekte kjøring (2026-08-21, task `d103-host-final-ea3e6b3f`, ETTER v2 merget - LYKTES)

Denne runboken (v2s reparerte versjon, "d103-git-credential-helper-windows-
repair", merget som PR #46) ble kjørt på nytt på Tobias sin Windows-host, mot
kanonisk `main` (merge-commit `ad96d33466315a5687ec977ce33ff36aa5fda7c7`),
MED Git for Windows sin system-nivå `credential.helper=manager`
(`C:/Program Files/Git/etc/gitconfig`) BEVISST bevart uendret (som i de to
foregående kjøringene):

- Produksjons-`api` OG produksjons-`worker` startet BEGGE korrekt fra
  kanonisk `main`.
- En ekte kodejobb ble sendt inn - worker `worker-aa818fcf` claimet jobben
  korrekt (Blokker A-fiksen fortsatt bevist LIVE, tredje gang på rad).
- Jobben progresserte `running` → `running` → `running` → `completed`.
- **v2s `credential.helper`-mekanisme FUNGERTE FULLSTENDIG:** ingen
  `cannot spawn ...askpass.cmd`-feil (v1s askpass-mekanisme er jo helt
  fjernet), ingen `post-ops`-identitet eller annen ambient identitet dukket
  opp noe sted - `AMBIENT_HOST_CREDENTIAL_DID_NOT_OVERRIDE=true` bekreftet
  MED en ekte konkurrerende ambient helper fortsatt konfigurert.
- Klone, agent-endring, uavhengig testport (tests=passed), commit
  (`commit_sha=8a9fda6d172193e4abb002dad814411ffb629300`), autentisert push
  (branch `jarvis/d103-host-final-ea3e6b3f`) og PR-publisering
  (`tsworkflow/jarvis-d103-acceptance#1`) fullførte ALLE.
- Terminalt resultat: `status=completed`, `last_error=<tom>`.

**Én presis nyanse (IKKE overklamet):** `EXPECTED_TOKEN_IDENTITY_MATCH` ble
IKKE friskt re-bevist via en dedikert `/user`-identitetspreflight i DENNE
kjøringen - det steget mottok en GitHub 403. INGEN fabrikkert
identitetsbekreftelse legges til her. Den strukturelle proof-of-work er i
stedet den fullstendige, isolerte, autentiserte clone→push→PR-kjeden som
selv lyktes MENS ambient `credential.helper=manager` forble konfigurert,
kombinert med kjøring 1/2s tidligere direkte bevis på at
`JARVIS_GITHUB_TOKEN` autentiserer som `tsworkflow` (forventet eier-
identitet).

**Kjent, IKKE-blokkerende observasjon:** agentens egen frie resultattekst
inneholdt et stale utsagn ("endringen er ikke committet ennå") SAMTIDIG som
den strukturerte pipeline-tilstanden allerede bar en ekte `commit_sha` og en
opprettet PR. Kanonisk sannhet er ALLTID den strukturerte, database-
persisterte tilstanden (`tasks.result`/`commit_sha`/PR-URL) - ALDRI
agentens frie prosa-beskrivelse (jf. Q-26, samme prinsipp som D-101s
harness-persistens-funn).

**`tsworkflow/jarvis-d103-acceptance#1` forblir bevisst UMERGET** - et
engangs bevisartefakt for denne runboken, IKKE et produksjonsleveranse.
Ingen videre handling på den PR-en er del av D-103.

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

Etter `d103-git-credential-helper-windows-repair` (v2) skal en rerun
eksplisitt bevise ALLE disse (ikke bare "jobben fullførte"):

- `WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true` - `tasks.worker_id` er
  `worker-main.ts` sin prosess, ALDRI `main.ts` sin (uendret gjennom alle tre
  kjøringene).
- `CLONE_AUTH_VERIFIED=true` - `git clone` fullførte uten
  `git_auth_unavailable` eller en `clone_failed`-feil.
- `WINDOWS_CREDENTIAL_TRANSPORT_EXECUTED=true` - INGEN `cannot spawn
  ...askpass.cmd: Permission denied`-feil (eller noen annen prosessoppstart-
  feil for credential-mekanismen) - dette var AKKURAT det som feilet i
  kjøring 2, og er det denne v2-reparasjonen spesifikt adresserer.
- `PUSH_AUTH_VERIFIED=true` - `git push` fullførte UTEN et `403 Permission
  denied`-avvik (kjøring 1) OG UTEN en askpass-spawn-feil (kjøring 2).
- `EXPECTED_TOKEN_IDENTITY_MATCH=true` - kontroller manuelt i GitHub UI (PR-en/
  branchens "Created by"/commit-forfatter, eller repo sin Insights → Traffic/
  Audit log hvis tilgjengelig) at handlingen ble utført av DEN FORVENTEDE
  eier-identiteten (samme identitet `JARVIS_GITHUB_TOKEN` autentiserer som via
  GitHub API) - IKKE en ukjent/uventet konto.
- `AMBIENT_HOST_CREDENTIAL_DID_NOT_OVERRIDE=true` - hvis en ambient
  Git Credential Manager-konto (som `post-ops`, eller system-nivå
  `credential.helper=manager` fra kjøring 2) fortsatt er konfigurert på
  maskinen, skal DEN kontoen ALDRI dukke opp noe sted i denne kjøringens
  PR/branch/commit-forfatterskap.
- `PR_CREATED=true` - `tasks.result` inneholder et `pr`-felt med en ekte GitHub
  PR-URL på `testRepoUrl`, OG en reell, åpen PR er synlig i GitHub UI.
- `TASK_COMPLETED=true` - `tasks.status = 'completed'` for `$taskId`.
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
| `push_failed: ... Permission ... denied to <ukjent-konto>` | Skulle IKKE skje etter v1 ELLER v2 - dette var feilklassen fra kjøring 1 (ambient `credential.helper` kapret auth). Skjer det likevel: samle `git -c credential.helper= credential fill`-output og eksakt `last_error`, IKKE forsøk å fikse ved å slette Git Credential Manager-tilstand selv - meld tilbake i stedet. |
| `push_failed: ... cannot spawn ...askpass.cmd: Permission denied` / `clone_failed: ... cannot spawn ...` | Skulle IKKE lenger skje etter `d103-git-credential-helper-windows-repair` - dette var AKKURAT feilklassen fra kjøring 2 (GIT_ASKPASS erstattet HELT av `credential.helper` i v2). Skjer det likevel: samle EKSAKT `last_error`-tekst OG utdata fra `git -c credential.helper= -c "credential.helper=!\"<node>\" \"<skript>\"" credential fill` kjørt manuelt, meld tilbake - IKKE forsøk selv å reversere til v1s mekanisme. |

**Live-verifiseringsstatus (ærlig, ikke fabrikkert, oppdatert etter kjøring 3):**
kjøring 3 (`d103-host-final-ea3e6b3f`) BEVISER nå, LIVE, på ekte Windows, mot
kanonisk `main`: `WORKER_PROFILE_ROUTING_LIVE_VERIFIED=true`,
`REAL_CODING_JOB_REACHED_GIT_PUSH=true`,
`AMBIENT_CREDENTIAL_HELPER_CAN_OVERRIDE_JARVIS_AUTH=false`,
`AMBIENT_HOST_CREDENTIAL_DID_NOT_OVERRIDE=true`,
`WINDOWS_CREDENTIAL_TRANSPORT_EXECUTED=true`, `CLONE_AUTH_VERIFIED=true`,
`PUSH_AUTH_VERIFIED=true`, `PR_CREATED=true`, `TASK_COMPLETED=true`,
`WINDOWS_LIVE_AUTH_ISOLATION_VERIFIED=true`, `LIVE_E2E_VERIFIED=true`,
`TESTED_FIX_PIPELINE_PRODUCTION_REACHABLE=true`, `HOST_ACTION_REQUIRED=false`.
Den ENE feltet IKKE friskt re-bevist denne runden:
`EXPECTED_TOKEN_IDENTITY_MATCH` (se "Historisk funn: TREDJE ekte kjøring"
over for den presise nyansen - INGEN fabrikkert identitetsbekreftelse, kun
ærlig presisert). **UA-5 kriterium 2 er nå `COMPLETE`.** D-103 (v1+v2)
status: `CANONICAL / FIXED_SUITE_VERIFIED / WINDOWS_CI_AUTH_TRANSPORT_
VERIFIED / WINDOWS_LIVE_E2E_VERIFIED / COMPLETE`. Ingen ytterligere
D-103-host-kjøring er påkrevd.
