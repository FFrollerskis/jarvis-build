# PROJECT STATUS

**Oppdatert:** 2026-09-07 (branch `claude/worker-self-recovery-20260907`, PR #75, base
`main=94e4aaa528477fbdc87ce8f4f6c37cb9d3bebb1d`)

> Denne filen er den ENESTE status-/handoff-filen (CLAUDE.md) og overskrives ved hver økt - full
> historikk finnes i git-commits/diff/PR-beskrivelser, ikke her.

## Aktiv fase/oppgave

**Infrastrukturreparasjon, review-runde 4: `D126-LOCK-LEDGER-REVIEW-FIX-20260907-C`** (byggeordre
5567261855 på issue #68, `REVIEW_RESULT=CHANGES_REQUIRED`, som svar på arkitektens review av den
FAKTISKE `lock.mjs` på `f839668`). Samme branch, samme PR #75.
**Eksplisitt bestilt av eieren, IKKE en masterplan-slice og IKKE en ny produktkapabilitet.**
Ingen faseport er passert, ingen UA-slice er startet, ingen produkt-sannhetsflagg er flippet.
Full begrunnelse: D-126, D-126a, D-126b og D-126c i DECISIONS_AND_ASSUMPTIONS.md.

**De seks øvrige gruppene fra runde 2 er IKKE godkjent** - arkitekten har uttrykkelig holdt dem
åpne i påvente av den komplette gjennomgangen av den rettede koden.

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

## Runde 3 (v2.2) - bekreftet kildedefekt i låsen, og harness-defekten

Arkitekten bekreftet en KILDEDEFEKT, ikke en flaky test: `removeVerified` omdøpte den NÅVÆRENDE
låsen til en tombstone FØR bytene ble sammenlignet med det klassifiserte øyeblikksbildet.
rename-så-sammenlign er ikke en atomisk compare-and-delete; i vinduet er den offentlige stien tom.

Reprodusert lokalt på nøyaktig `efa62d7`-modulen (kopi i scratch, ett tillagt observasjonspunkt rett
etter `renameSync`, ingen endret beslutning), og samme skjema mot den nye koden:

```
v2 (efa62d7): existingOwnerAcquired=true  challengerAcquired=true
              reclaimResult=lock_changed_during_reclaim
              existingOwnerStillHolds=false challengerStillHolds=true
v3 (denne):   existingOwnerAcquired=true  challengerAcquired=false
              reclaimResult=active
              existingOwnerStillHolds=true  challengerStillHolds=false
```

Rettet ved å bytte primitiv: **create-if-absent** (`link()` / `open(wx)`) er den eneste ekte
enkeltvinner-operasjonen filsystemet gir, og låsen er nå en append-only hovedbok `<lockFile>.d/`
med `<generasjon>.claim`. Ingen prosess omdøper, overskriver eller sletter en sti den ikke selv
opprettet; en foreldet claim BLIR FORBIGÅTT av en høyere generasjon, aldri fjernet. Full
beskrivelse av primitivet og feil-/gjenopprettingssemantikken: `ops/claude-worker/README.md` og
D-126b.

Harness-defekten er også rettet: `lock-racer.mjs` bruker eksplisitt READY → START → ATTEMPT →
RELEASE, og gjensidig utelukkelse dømmes av INTERVALLER (ingen to kritiske seksjoner får overlappe),
ikke av en telling av `acquired`. Alle forventede barn må levere resultatfil og avslutte med exit 0.

Deployment-forpliktelsen er lukket i denne runden: `install-task.ps1`/`install-supervisor.ps1`
skriver en DURABEL INTENSJON i install-manifestet FØR noen registrering og avbryter installasjonen
hvis den ikke kan skrives; `reconcile-task-intents` løser krasj-vinduet fra vertens eget svar; og
rollback avregistrerer også ubekreftede intensjoner for oppgaver som ikke fantes fra før.

## Runde 4 (v2.3) - en tilbaketrukket claim kunne fortsatt maskere en levende forgjenger

Arkitekten leste den faktiske `lock.mjs` på `f839668` og reproduserte deterministisk én gjenstående
P1-feil - i selve den NYE append-only hovedboken. Den grønne CI-kjøringen 34086249211 dekket ikke
dette interleavinget.

`confirmOwnership()` re-probet generasjon N-1 korrekt, men `retractOwnClaim()` skrev N som en
ORDINÆR `state: "released"`, og eierskap ble lest av RÅ maksimum. Da kunne en FEILET utfordrer gi
bort låsen: gen 1 lever → en foreldet reclaimer publiserer gen 2 → bekreftelsen ser korrekt at 1
lever og trekker 2 tilbake → en tredje anskaffer ser bare en «released» gen 2, tror låsen er fri,
publiserer gen 3 og re-sjekker KUN mot 2. Den levende gen 1 mistet `holdsLock()`.

Reprodusert lokalt på nøyaktig `f839668`-modulen og på den rettede modulen, fra samme driver, uten
sleeps (scratch utenfor repoet):

```
f839668: firstAcquired=true  secondAcquired=false generation2StateOnDisk=released
         thirdAcquired=true  firstStillOwnsLock=false thirdOwnsLock=true
v2.3:    firstAcquired=true  secondAcquired=false generation2StateOnDisk=void
         thirdAcquired=false firstStillOwnsLock=true  thirdOwnsLock=false
```

Rettelsen er en tredje krav-tilstand, ikke en rekkefølgelapp: `released` = «EIDE låsen og ga slipp»
(avslutter avstamningen), `void` = «EIDE ALDRI noe» (TRANSPARENT - oppslaget går videre nedover til
det EFFEKTIVE kravet). Ny generasjon appendes fortsatt over RÅ maksimum, så telleren går aldri
bakover. `confirmOwnership()` re-klassifiserer den EFFEKTIVE forgjengeren med samme dom som før
publisering, så også en uleselig forgjenger feiler nå lukket. Kan avstamningen ikke bevises (hull
under et void-krav, uleselig krav på veien, void-kjede som ikke når gen 1) nektes anskaffelsen -
aldri «fri». Eldre `released` + `release_reason: "retracted"` leses som `void`.

## Kvalitetsporter (kjørt i denne økten)

- **`npx vitest run ops/claude-worker/test` → 14 filer / 310 tester passed, kjørt TRE ganger,
  310/310 hver gang. Ingen intermitterende feil observert i denne runden.**
  Seks nye tester i `lock.test.mjs`: den eksakte tre-parts-sekvensen deterministisk via
  `hooks.afterClassify` (levende gen 1 → spekulativ gen 2 → tilbaketrukket → gen 3 NEKTES, eieren
  beholder låsen); at eieren fortsatt kan heartbeate og release på tvers av det tilbaketrukne
  kravet OG at låsen ikke deadlocker etterpå; re-lesing fra disk i en HELT NY Node-prosess med
  ekte prosess-prober (restart-oppførsel); bakoverkompatibel lesing av eldre
  `release_reason: "retracted"`; fail-closed på uløselig avstamning; og at en ekte frivillig
  release fortsatt frigjør låsen.

Historikk fra runde 3, uendret:

- **`npx vitest run ops/claude-worker/test` → 14 filer / 304 tester passed.**
  **Sannferdig historikk, ikke en ubetinget påstand:** underveis feilet suiten intermitterende
  (to av fem kjøringer ga 303/304). Feilen ble IKKE kjørt bort. Den ble diagnostisert til
  `lock.test.mjs > a live heartbeating owner is never displaced by six concurrent challengers`,
  der eieren rapporterte `lost_ownership_during_hold=true` - og årsaken var en EKTE Windows-defekt
  i den nye koden, ikke en flaky test: libuv åpner vanlige filer uten `FILE_SHARE_DELETE`, så et
  `rename` over en claim en annen prosess akkurat leser feiler forbigående med `EPERM`/`EACCES`,
  og en lesing under et samtidig `rename` feiler på samme måte. Det ga to reelle feilmoduser:
  (1) en heartbeat som ikke landet ble lest som «jeg har mistet låsen» - som ville avbrutt en frisk
  50-minutters kjøring; (2) en claim som ikke kunne LESES ble klassifisert som «uleselig» og kunne
  dermed forbigås - altså kunne en utfordrer forbigått en levende eier. Rettet: forbigående
  filsystemfeil (`EPERM`/`EACCES`/`EBUSY`/`EMFILE`/`ENFILE`/`EAGAIN`) gir bundet retry med backoff,
  en claim som ikke kunne leses gir `unreadable` og FAIL-CLOSED (aldri «kan forbigås»), og
  harnessen skiller nå `heartbeat_write_failures` fra faktisk tap av eierskap. Ingen assertion er
  svekket. Etter rettelsen: grønt.
  Nye tester i runde 3:
  - `lock.test.mjs` (36 → nå 42): den deterministiske stale-read → erstatningseier → forsinket reclaim →
    utfordrer-sekvensen via `hooks.afterClassify` (nøyaktig punktet v2 var utrygt), åtte ekte
    samtidige OS-prosesser med intervall-bevis, legacy v1/v2-låsefil som respekteres men aldri
    røres, GC som aldri fjerner maksimum;
  - `deploy.test.mjs` (40): åtte nye for durabel registreringsintensjon, inkludert krasj mellom
    registrering og journalføring, «jeg kunne ikke spørre verten» som ALDRI løser en intensjon, og
    at en pre-eksisterende oppgave aldri avregistreres av en rollback.
  Fra runde 2, uendret og fortsatt grønne:
  - `worker-crash-recovery.test.mjs` (16): starter det FAKTISKE `node worker.mjs run` som prosess og
    dreper det før spawn, under barnets kjøring og etter report men før completion-lagring; verifiserer
    at et levende barn beskyttes uten at en andre Claude startes, at en eksisterende report lukker
    tasken uten ny dispatch, og at git-/remote-/dirty-feil blokkerer i stedet for å dispatche;
  - `state.test.mjs` (33): korrupt primær + gyldig backup (eksakt arkitekt-repro), avbrutt skriving,
    `null`/`[]`/`{}`-avvisning, supervisor-skjema;
  - `deploy.test.mjs` (31): injisert feil i hvert steg av byttet, hash-håndhevet rollback, fjerning av
    innførte filer OG av oppgaver installasjonen innførte, bevaring av operasjonelle data, utsatt
    aktivering under levende lås;
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
  dokumentasjon endret - `.github/` er URØRT, se den nektede push-operasjonen over). CI på eksakt endelig HEAD rapporteres i
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
  diffen. Ingen merge, ingen live aktivering før det. Ingenting er installert eller restartet på
  Windows-hosten av denne økten.
- `HARD_EXTERNAL_BLOCKER=true`, `BLOCKER_SCOPE=WINDOWS_HOST_VERIFICATION_AND_LATER_INSTALLATION_ONLY`.
  Blokkeringen gjelder PowerShell-/Task Scheduler-verifisering på hosten og senere installasjon;
  den blokkerer ikke kildekorreksjonene over, og den er ikke omgått.

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
reproduserte feilmoduser, runde 3 og 4 hver sin uavhengig reproduserte P1-feil i gjensidig
utelukkelse, og resten gjøres synlig i stedet for stille.
