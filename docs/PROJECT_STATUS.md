# PROJECT STATUS

**Oppdatert:** 2026-09-07 (branch `claude/worker-self-recovery-20260907`, PR #75, base
`main=94e4aaa528477fbdc87ce8f4f6c37cb9d3bebb1d`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**Infrastrukturreparasjon, review-runde 2: `D126-REVIEW-FIX-20260907-A`** (byggeordre 5563925449 på
issue #68, som svar på arkitektens review av den FAKTISKE koden på `a9fe152`). Samme branch, samme
PR #75. **Eksplisitt bestilt av eieren, IKKE en masterplan-slice og IKKE en ny produktkapabilitet.**
Ingen faseport er passert, ingen UA-slice er startet, ingen produkt-sannhetsflagg er flippet.
Full begrunnelse: D-126 og D-126a i DECISIONS_AND_ASSUMPTIONS.md.

## Runde 1 (v2) - hva som ble reparert

Fire uavhengige, produksjonsobserverte feil i den lokale worker-loopen: kladd i repoet som blokkerte
dirty-guarden permanent (A), `processed_task_ids.push()` som registrerte en `ETIMEDOUT` som «ferdig»
(B), en lås basert på pid + aldersbudsjett (C), og en blokkert worker som gikk stille ut med exit 0
(D). I tillegg en håndredigert `.ps1` fra mobil som ga ParserError uten at noe rapporterte det.

## Runde 2 (v2.1) - syv P1-feil arkitekten fant i den faktiske v2-koden

Grønn CI beviste dem ikke fraværende: ingen test kjørte det ekte entrypointet under krasj, ingen
brukte ekte samtidige prosesser, ingen injiserte feil i durabilitets- eller installasjonsbanen.

| # | Faktisk feil | Arkitektens repro | Rettet |
|---|--------------|-------------------|--------|
| 1 | Kandidat valgt FØR låsen + `isEligibleNow` avviser alltid `IN_PROGRESS` ⇒ krasj midt i dispatch kunne aldri kjøre igjen. Barnets pid lagret først ETTER `runClaude`. | `CRASHED_IN_PROGRESS_ELIGIBLE=false` | rekkefølge lås → state → recovery → kandidat; identitet (pid+starttid+host) persistert ved spawn; levende foreldreløst barn beskyttes med etterkommer-regnskap; bundet levetidsbudsjett så pid-gjenbruk aldri blokkerer permanent |
| 2 | Låsen publisert som TOM `wx`-fil før JSON; heartbeat trunkerte samme fil; tomme låser slettet umiddelbart; samtidige reclaimere slettet hverandres låser; state lest før og skrevet uten lås | `EMPTY_LOCK_RECLAIMED=true` | link-atomisk publisering, rename-atomisk heartbeat, innholdsverifisert reclaim, eierskaps-token, state lest ETTER låsen, egen append-only journal for status-dedup |
| 3 | Korrupt primær kopiert over eneste gode backup; `migrateState(null)` ble tom historikk | `BACKUP_AFTER_RECOVERY_SAVE=corrupt`, `NULL_STATE_ACCEPTED_AS_EMPTY=true` | skjemavalidering (worker + supervisor), backup-rotasjon kun fra verifisert gyldig primær, `first_run` skilt fra tapt state |
| 4 | In-place kopiering over levende deployment; `run-worker-safe.ps1` slettet mens en oppgave kunne peke på den; fungerende oppgave avregistrert FØR ny registrering kunne feile; rollback lot innførte moduler/oppgaver stå og håndhevet ikke gamle hasher | — | transaksjonell stage → verifiser → bytt → auto-rollback i Node (`lib/deploy.mjs`), rename-over per fil, utsatt aktivering med handoff-markør ved levende lås, probe-basert registrering som bevarer hostens principal/shell, hash-håndhevet rollback som også fjerner det installasjonen innførte |
| 5 | Kommanderte restarts hoppet over budsjett/backoff; to like `COMMAND_ID` i én batch kjørte begge; kommando merket utført FØR start uten rekonsiliering; utsatte forespørsler ble konsumert; `Start-ScheduledTask` kunne rapportere ok etter ikke-terminerende feil | — | durable intent → effect → result → receipt; per-kommando revalidering mot fersk observasjon; rekonsiliering fra faktisk host-bevis; kvitterings-retry uten å gjenta effekten; bevart utsettelse; terminerende PowerShell-feil med verifisert sentinel |
| 6 | Hele TASK_ID-sluggen finnes ikke i faktiske branch-navn ⇒ retry ville duplisert branch/PR/merge; feilede GitHub-oppslag ble tomme lister | `KNOWN_D125_BRANCH=null KNOWN_PR=null` | eksakte persisterte branch-/PR-assosiasjoner fra state og betrodde protokollkommentarer; paginering; `{ok, items, error}` så et feilet oppslag aldri leses som «ingen PR finnes» |
| 7 | `gitStatusLines` ignorerte exit/feil og leste manglende stdout som «rent»; `claudeArgs` defaultet til `--dangerously-skip-permissions`; ingen grense-/path-/TASK_ID-/vertsbindingsvalidering; `TEMP` hindrer ikke relative kladdefiler | — | `lib/git.mjs` fail-closed; `lib/config.mjs` påkrevd eksplisitt `claudeArgs` + bounds + path-containment + ekte vertsbinding; `isValidTaskId`; eksplisitt scratch-sti og kladdedisiplin i prompten |

## Kvalitetsporter (kjørt i denne økten)

- **`npx vitest run ops/claude-worker/test` → 14 filer / 280 tester passed.** Nye, som feiler på den
  gamle implementasjonen:
  - `worker-crash-recovery.test.mjs` (16): starter det FAKTISKE `node worker.mjs run` som prosess og
    dreper det før spawn, under barnets kjøring og etter report men før completion-lagring; verifiserer
    at et levende barn beskyttes uten at en andre Claude startes, at en eksisterende report lukker
    tasken uten ny dispatch, og at git-/remote-/dirty-feil blokkerer i stedet for å dispatche;
  - `lock.test.mjs` (23): åtte ekte samtidige OS-prosesser mot samme lås, tom lås som ikke stjeles,
    levende heartbeat-eier som ikke fortrenges, innholdsverifisert reclaim, token-eierskap;
  - `state.test.mjs` (33): korrupt primær + gyldig backup (eksakt arkitekt-repro), avbrutt skriving,
    `null`/`[]`/`{}`-avvisning, supervisor-skjema;
  - `deploy.test.mjs` (29): injisert feil i hvert steg av byttet, hash-håndhevet rollback, fjerning av
    innførte filer, bevaring av operasjonelle data, utsatt aktivering under levende lås;
  - `supervisor-run.test.mjs` (16) + `supervise-protocol.test.mjs` (19): to like `COMMAND_ID` i én
    poll, budsjett for to unike restarts, krasj før/etter `Start-ScheduledTask`, feilet kvittering,
    bevart utsettelse fra travel til ledig;
  - `config.test.mjs` (26), `git.test.mjs` (13), `recovery.test.mjs` (20).
- `npx eslint ops/claude-worker`: **rent.**
- `node --check` på alle 19 `.mjs`-moduler: **rent.**
- **Ekte PowerShell-AST-parsing ble IKKE kjørt, og CI-jobben kunne ikke pushes. To uavhengige,
  presist nektede operasjoner:**
  1. `powershell.exe -NoProfile -Command "echo PSOK"` → «This command requires approval».
     PowerShell-kjøring er nektet av tillatelseslaget i denne økten, så
     `System.Management.Automation.Language.Parser` kunne ikke kjøres lokalt.
  2. `git push origin claude/worker-self-recovery-20260907` →
     `! [remote rejected] ... (refusing to allow an OAuth App to create or update workflow`
     `.github/workflows/ci.yml` `without workflow scope)`. GitHub-tokenet mangler `workflow`-scope,
     så CI-jobben kunne ikke legges inn i `.github/workflows/ci.yml` herfra.

  Jobben er derfor levert som **`ops/claude-worker/ci/worker-scripts-windows.job.yml`** — ferdig
  YAML som limes inn rett før `gitleaks:` i `.github/workflows/ci.yml` av noen med `workflow`-scope.
  Den kjører `verify-scripts.ps1` med den EKTE PowerShell-parseren OG hele worker-suiten på Windows.
  **Ingenting er utelatt stille**, og ingen påstand om «alle scripts parser» gjøres uten den kjøringen.
  Statisk kontroll som FAKTISK ble kjørt: alle 8 `.ps1` er ren ASCII uten kontrolltegn (byte-nivå),
  og alle 19 `.mjs` er `node --check`-rene.
- Full produktsuite ble ikke kjørt lokalt (endringene rører ingen produktkode; utenfor `ops/` er kun
  `.github/workflows/ci.yml` og dokumentasjon endret). CI på eksakt endelig HEAD rapporteres i
  `CLAUDE_REPORT` på issue #68.

## Flagg-status - alt uverifisert til det er bevist på hosten

`WORKER_SELF_RECOVERY_VERIFIED=false` · `SUPERVISOR_INSTALLED=false` ·
`REMOTE_RESTART_VERIFIED=false` · `REBOOT_PERSISTENCE=UNVERIFIED` ·
`SOURCE_CHANGED=true` · `DEPLOYED_TO_HOST=false` · `ARCHITECT_MERGE_APPROVED=false`.

**Kildeendring er IKKE deployment.** Den kjørende workeren på hosten er fortsatt v1 med alle de
opprinnelige feilene. Ingenting er installert, registrert eller startet av denne økten.

Uendret av denne oppgaven: `UA7_COMPLETE=false`, `UA7_ACCEPTANCE_4=PARTIAL`,
`Q32_POINT1=OPEN_EXTERNAL_OWNER_ACTION`, `D108_COMPLETE=false`, `UA6_COMPLETE=false`,
`NEW_PROVIDERS_ADDED=0`, `NEW_CREDENTIALS_OR_SCOPES=0`, `CORE_DEPENDENCY_DECISION_REQUIRED=false`.

## Normativ endring, akseptert av arkitekten

`D126_AMENDMENT_ACCEPTED=true` (byggeordre 5563925449): kilden til worker-infrastrukturen spores i
`ops/claude-worker/`, eksplisitt utenfor pnpm-workspacet og produktbygget, mens deployert
runtime/state/scratch forblir utenfor repoet i `%USERPROFILE%\.jarvis-claude-worker\`.

## Blokkeringer

- **Ekte PowerShell-parse-verifisering ikke kjørt lokalt** - `powershell.exe` nektet av
  tillatelseslaget i økten. Må kjøres på hosten (`.\verify-scripts.ps1`) før installasjon.
- **CI-jobben for Windows kunne ikke pushes** - GitHub-tokenet mangler `workflow`-scope
  (`remote rejected ... without workflow scope`). YAML-en ligger klar i
  `ops/claude-worker/ci/worker-scripts-windows.job.yml` og må limes inn i
  `.github/workflows/ci.yml` av noen med det scopet. Dette er en ekstern tilgangsblokkering, ikke et
  utelatt krav.
- **Installasjon og aktivering avventer bevisst fersk uavhengig arkitekt-review** av den rettede
  diffen. Ingen merge, ingen live aktivering før det.
- `HARD_EXTERNAL_BLOCKER=false`.

## Neste oppgave

1. Fersk uavhengig ChatGPT-arkitekt-review av den rettede diffen på PR #75 (INGEN self-approval,
   `ARCHITECT_MERGE_APPROVED=false`).
2. Etter godkjent review, på hosten i rekkefølge: `.\verify-scripts.ps1` → `.\install.ps1 -WhatIf` →
   `.\install.ps1` (utsettes automatisk hvis workeren kjører; `run-worker.ps1` anvender den ved neste
   tikk) → config-filer → `node worker.mjs status` / `run --dry-run` → `.\install-task.ps1` →
   `.\install-supervisor.ps1`.
3. Endelig akseptanse krever, i tillegg til fixture-testene: deployerte skript-hasher/versjon, en
   ekte planlagt kjøring som fullfører en ufarlig autorisert probe, og en ekte
   `RESTART_WORKER`-kvittering. Først da kan `WORKER_SELF_RECOVERY_VERIFIED`, `SUPERVISOR_INSTALLED`
   og `REMOTE_RESTART_VERIFIED` settes true - individuelt, aldri samlet.

Ingen påstand om at alle framtidige feil er umulige. Runde 2 fjerner syv konkrete, uavhengig
reproduserte feilmoduser og gjør resten synlige i stedet for stille.
