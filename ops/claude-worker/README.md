# Jarvis Claude-worker og recovery-supervisor (ikke-produkt infrastruktur)

Kilden til den lokale worker-loopen mellom ChatGPT-arkitekten og Claude, og til
recovery-supervisoren som henter den opp igjen når den stopper.

**Dette er IKKE en Jarvis-produktkapabilitet.** Katalogen ligger utenfor pnpm-
workspacet, bygges ikke, deployes ikke med produktet, og importeres aldri av
`apps/` eller `modules/`. Se D-126 i
[DECISIONS_AND_ASSUMPTIONS.md](../../docs/DECISIONS_AND_ASSUMPTIONS.md) for
hvorfor kilden likevel er sporet her, mens KJØRETIDEN fortsatt ligger utenfor
repoet i `%USERPROFILE%\.jarvis-claude-worker\`.

## Hvorfor v2 finnes

Loopen stoppet gjentatte ganger og måtte reddes manuelt fra mobil PowerShell.
Fire uavhengige feil, alle reelle og alle observert i produksjon:

| # | Feil | Konsekvens | Rettet i |
|---|------|-----------|----------|
| A | Claude skrev ACK/report-kladd INN i repoet; `.claude-ack-d125-merge.md` ble liggende | dirty-guard blokkerte hver eneste kjøring for alltid | `lib/quarantine.mjs` |
| B | `processed_task_ids.push()` kjørte uansett utfall | `spawnSync claude ETIMEDOUT` ble registrert som «ferdig»; D125-arbeidet forsvant | `lib/state.mjs`, `lib/reconcile.mjs` |
| C | Låsen brukte pid + aldersbudsjett | en frisk 50-minutters jobb kunne erklæres «stale», og en gjenbrukt pid kunne se levende ut | `lib/lock.mjs` |
| D | Ingen retry-grense, ingen synlig status | blokkert worker gikk stille ut med exit 0 | `lib/reconcile.mjs`, `worker.mjs` |

I tillegg: en håndskrevet patch av wrapperen fra mobil innførte et fremmed tegn,
ga ParserError, og stoppet alt uten at noe rapporterte det. Derfor er alle
`.ps1`-filer nå ren ASCII, sporet i repoet, og verifisert av `verify-scripts.ps1`.

## Hva som faktisk garanteres

Worker (`worker.mjs`):

- **A.** Kladd havner utenfor repoet ved konstruksjon (`TEMP`/`TMP` peker på
  `tmp/`). Gamle etterlatenskaper flyttes til unik karantene FØR dirty-guarden,
  men bare hvis filnavnet treffer en fullt ankret allowlist, filen er en vanlig
  fil (aldri symlink/reparse point), innholdet faktisk er et protokolldokument,
  og `TASK_ID` er kjent for workeren. Bytes hashes før og etter. Ukjente og
  sporede filer røres aldri. Ingen `git clean/reset/stash`, ingen `.gitignore`.
- **B.** Timeout, exit≠0, spawn-feil eller manglende report gir ALDRI
  «processed». Fullført krever en matchende betrodd `CLAUDE_REPORT` for akkurat
  den `TASK_ID`-en, postet etter dispatch, med terminal `STATUS`. State skrives
  atomisk med backup; er både primær og backup ulesbar, nekter workeren å kjøre
  i stedet for å miste replay-beskyttelsen.
- **C.** Én lås dekker preflight, karantene, dispatch og alle state-skriv.
  Levende eier avgjøres av prosessidentitet (pid + starttid + host) og
  heartbeat, ikke av alder. En aktiv lås ryddes aldri automatisk.
- **D.** Bundet retry med eksponentiell backoff og et hardt tak. Gjentatt feil
  gir en deduplisert `CLAUDE_WORKER_STATUS` på kontroll-issuen. Exit-koden er
  aldri 0 når noe er blokkert.
- **E.** Bare allerede autoriserte tasks kjøres. Ingen oppfunnet neste arbeid.
- **F.** Egne health-hendelser per steg, så «scheduleren kjørte» aldri forveksles
  med «arbeidet ble fullført».

Supervisor (`supervisor.mjs`), autorisert av scope-oppdateringen på
WORKER-SELF-RECOVERY-20260907 — ÉN recovery-supervisor, aldri en andre
implementasjons-worker:

- observerer den eksisterende `JarvisClaudeWorker`-oppgaven og workerens egen
  health-journal/lås (kun lesing),
- poller SAMME betrodde issue for nøyaktig to kommandoer: `STATUS` og
  `RESTART_WORKER`, med ankret skjema, unik `COMMAND_ID`, host-/worker-binding,
  kort utløp, avvisning av redigerte og replayede kommentarer,
- starter den eksisterende oppgaven når workeren beviselig er en død
  kø-konsument, innenfor et døgnbudsjett og med backoff,
- **avbryter aldri levende arbeid** og **avslutter aldri en prosess** — en
  `RESTART_WORKER` mot en travel worker blir utsatt, ikke tvunget.

## Exit-koder (både worker og supervisor)

| Kode | Betydning |
|------|-----------|
| 0 | frisk: ledig kø, eller en task fullført med verifisert bevis |
| 3 | blokkert: trenger et menneske eller en ny TASK_ID — ikke «frisk» |
| 4 | forbigående: auth/nett/retry-bar feil, prøver igjen med backoff |
| 1 | fatal: config- eller parse-feil |

En Windows-oppgave i `Ready` med `LastTaskResult=0` betyr KUN at scheduleren
kjørte. Ekte køhelse: `node worker.mjs health`.

## Installasjon (staged, aldri in-place over en kjørende worker)

```powershell
cd <repo>\ops\claude-worker
.\verify-scripts.ps1              # alle .ps1 parser og er ASCII
.\install.ps1 -WhatIf             # full plan, endrer ingenting
.\install.ps1                     # backup + kopier + hash-verifiser
```

`install.ps1` nekter å skrive over en worker med levende lås, tar backup av alle
eksisterende filer OG av oppgavedefinisjonene til
`backups\<tidsstempel>\`, skriver et manifest med SHA256 før/etter, og rører
aldri `config.json`, `state.json`, `logs/` eller `tmp/`.

Etter staging (registrerer ingenting av seg selv):

```powershell
copy config.example.json config.json                      # hvis den mangler
copy supervisor.config.example.json supervisor.config.json # sett host + workerTaskName
node worker.mjs status
node worker.mjs run --dry-run
node supervisor.mjs status
node supervisor.mjs run --dry-run
.\install-task.ps1                # worker-schedule (samme ene worker som før)
.\install-supervisor.ps1          # supervisor-schedule (startup + intervall)
```

Rollback:

```powershell
.\rollback.ps1 -BackupDir "$env:USERPROFILE\.jarvis-claude-worker\backups\<stempel>" -WhatIf
.\rollback.ps1 -BackupDir "..." -RestoreTasks
```

## Kontrollkommandoer til supervisoren

Postes som kommentar på kontroll-issuen av repo-eieren. Alle felt er
obligatoriske; ukjente nøkler avvises.

```
ARCHITECT_CONTROL
COMMAND_ID=restart-20260907-0155-abc
COMMAND=RESTART_WORKER
TARGET_HOST=<eksakt hostname>
TARGET_WORKER=JarvisClaudeWorker
ISSUED_AT=2026-09-07T01:55:00Z
EXPIRES_AT=2026-09-07T02:25:00Z
```

Avvises ved: feil forfatter, ikke-OWNER, redigert kommentar, gjenbrukt
`COMMAND_ID`, utløpt, levetid over én time, feil host/worker, ukjent kommando
eller nøkkel. Supervisoren tolker aldri fritekst, stier eller argumenter.

## Sikkerhet

Ingen token håndteres, leses eller logges her — all GitHub-tilgang går gjennom
`gh`, som eier sin egen lagrede auth. Alt som skrives til logg, manifest eller
en kommentar går gjennom `sanitize()`. Manifestet inneholder stier og hasher,
aldri filinnhold. Ingen tillits- eller godkjenningsgrense er svekket av denne
reparasjonen: merge-autoritet (D-120) er uendret, og supervisoren kan ikke merge.

## Tester

```bash
npx vitest run ops/claude-worker/test
```

103 tester dekker karantene (inkludert den eksakte D125-filen, symlink,
reparse point, kollisjon, sporede filer), state-migrering og korrupsjons-
gjenoppretting, låsklassifisering, completion-bevis, backoff, status-dedup,
tillitsgrensen, supervisor-beslutninger og hemmelighetsvask.

Ikke dekket av vitest og må kjøres på hosten: `verify-scripts.ps1`,
`install.ps1`/`rollback.ps1`, ekte Task Scheduler-registrering og ekte
reboot-persistens.
