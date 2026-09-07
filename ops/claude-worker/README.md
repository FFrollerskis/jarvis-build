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

## Hvorfor v2.1 finnes (D-126 arkitekt-review, 2026-09-07)

Den uavhengige arkitekt-reviewen av den faktiske v2-koden fant syv reelle feil
som CI ikke fanget. Hver enkelt er reprodusert lokalt av arkitekten, og hver
enkelt har nå en test som feiler på den gamle implementasjonen:

| # | Faktisk feil i v2 | Reprodusert som | Rettet i |
|---|-------------------|-----------------|----------|
| 1 | Kandidat ble valgt FØR låsen, og `isEligibleNow` avviser alltid `IN_PROGRESS`. En krasj/reboot midt i dispatch nådde derfor aldri rekonsilieringen: tasken kunne aldri kjøre igjen. Barnets pid ble dessuten lagret FØRST etter at `runClaude` returnerte, så under hele dispatchen fantes barnet kun i låsen — som slettes ved reclaim av død forelder. | `CRASHED_IN_PROGRESS_ELIGIBLE=false` | `worker.mjs` (lås → state → recovery → kandidat), `lib/recovery.mjs`, `lib/procid.mjs`, `lib/dispatch.mjs` (`onSpawn`) |
| 2 | `acquireLock` publiserte en TOM `wx`-fil, lukket fd og skrev JSON etterpå; tomme/ugyldige låser ble slettet umiddelbart. `heartbeat` trunkerte samme fil på hvert slag. Samtidige reclaimere kunne slette hverandres ferske låser. State ble lastet FØR låsen og skrevet uten lås. | `EMPTY_LOCK_RECLAIMED=true` | `lib/lock.mjs` (link-atomisk publisering, rename-atomisk heartbeat, innholdsverifisert reclaim, eierskaps-token), `lib/statusjournal.mjs`, `worker.mjs` |
| 3 | `saveStateAtomic` kopierte en korrupt primær over den eneste gode backupen rett etter gjenoppretting. `migrateState(null)` og annen syntaktisk gyldig, ugyldig JSON ble stille til tom historikk. | `BACKUP_AFTER_RECOVERY_SAVE=corrupt`, `NULL_STATE_ACCEPTED_AS_EMPTY=true` | `lib/state.mjs` (skjemavalidering, verifisert backup-rotasjon, `first_run` skilt fra tapt state) |
| 4 | `install.ps1` kopierte over levende deployment fil for fil og slettet `run-worker-safe.ps1` mens den registrerte oppgaven kunne peke på den. `install-task.ps1` avregistrerte fungerende oppgave FØR ny registrering kunne feile. Rollback lot innførte moduler/oppgaver stå igjen og håndhevet ikke gamle hasher. | — | `lib/deploy.mjs` + `deploy.mjs` (stage → verifiser → bytt → auto-rollback), `install.ps1`, `rollback.ps1`, `install-task.ps1`, `install-supervisor.ps1`, `run-worker.ps1` (pending-activation-handoff) |
| 5 | Kommanderte restarts hoppet over døgnbudsjett/backoff; kommandoer ble validert i én batch, så to like `COMMAND_ID` i samme poll kjørte begge; `performRestart` merket kommandoen utført FØR starten uten noen rekonsiliering, så en krasj før start mistet forespørselen for alltid; utsatte forespørsler ble konsumert; `Start-ScheduledTask` kunne returnere ok etter en ikke-terminerende feil. | — | `supervisor.mjs` (intent → effect → result → receipt), `lib/supervise.mjs`, `lib/wintask.mjs` |
| 6 | Hele TASK_ID-sluggen finnes ikke i faktiske branch-navn, så `existingBranch`/`PR` ble `null` selv når PR-en fantes — og en retry ville duplisert branch/PR/merge. Feilede GitHub-oppslag ble til tomme lister. | `KNOWN_D125_BRANCH=null KNOWN_PR=null` | `lib/reconcile.mjs` (eksakte assosiasjoner), `lib/github.mjs` (`{ok, items, error}`, paginering) |
| 7 | `gitStatusLines` ignorerte exit/feil og leste manglende stdout som «rent». `claudeArgs` defaultet til `--dangerously-skip-permissions`. Ingen grensesjekk, ingen path-containment, ingen TASK_ID-validering før bruk som katalognavn, ingen ekte vertsbinding. `TEMP` hindrer ikke relative kladdefiler. | — | `lib/git.mjs`, `lib/config.mjs`, `lib/state.mjs` (`isValidTaskId`), `lib/dispatch.mjs` (scratch-disiplin i prompten) |

## Runde 3 (v2.2) - låsen er ikke lenger «reclaim», men en append-only hevdelses-hovedbok

Arkitektens review av den faktiske v2-koden (issue #68, kommentar 5565113307)
bekreftet en KILDEDEFEKT, ikke en flaky test: `removeVerified` flyttet den
NÅVÆRENDE låsen til en tombstone FØR bytene ble sammenlignet med det
klassifiserte øyeblikksbildet. rename-så-sammenlign er ikke en atomisk
compare-and-delete; i vinduet er den offentlige stien tom, en utfordrer kan
publisere og tro at den eier den kritiske seksjonen, og gjenopprettingen feiler
med `EEXIST`. Heartbeatens check-then-rename hadde samme klasse feil.

Reprodusert på nøyaktig efa62d7-modulen (ett tillagt observasjonspunkt rett
etter `renameSync`, ingen endret beslutning):

```
v2: existingOwnerAcquired=true challengerAcquired=true
    reclaimResult=lock_changed_during_reclaim
    existingOwnerStillHolds=false challengerStillHolds=true
v3: existingOwnerAcquired=true challengerAcquired=false
    reclaimResult=active
    existingOwnerStillHolds=true  challengerStillHolds=false
```

**Serialiseringsprimitivet i v3 er CREATE-IF-ABSENT** (`link()` / `open(wx)`) -
den eneste ekte enkeltvinner-operasjonen filsystemet tilbyr. Låsen er en
append-only hovedbok `<lockFile>.d/` med `<generasjon>.claim`-filer:

- **eierskap** = «jeg opprettet det EFFEKTIVE kravet - den høyeste claim-filen
  som ikke er `void` - og innholdet er fortsatt mitt og fortsatt `held`»;
- **anskaffelse** = append `maks+1` med create-if-absent; taperen får `EEXIST`
  fra kjernen, ikke fra en byte-sammenligning;
- **reclaim finnes ikke** - en foreldet claim BLIR ERSTATTET av en høyere
  generasjon; den flyttes, tømmes eller slettes aldri;
- **release** = merk MIN EGEN claim `released` (atomisk rename over egen sti);
- **tilbaketrekning** = merk MIN EGEN claim `void` når bekreftelsen etter
  publisering viser at den aldri eide noe.

Ufravikelig invariant: *ingen prosess omdøper, overskriver, trunkerer eller
sletter en sti den ikke selv opprettet med create-if-absent.* Derfor kan en
levende eiers hevdelse aldri forsvinne fra den offentlige stien - ikke engang i
et mikrosekund - og en foreldet reclaimer sitt verste utfall er at den legger
til en generasjon som allerede er forbigått, oppdager at den ikke er maksimum og
trekker tilbake KUN sin egen fil.

Feil-/gjenopprettingssemantikk: en krasjet eier etterlater sin claim som
maksimum med `state: "held"`; neste anskaffer klassifiserer den på
prosessidentitet (pid + starttid + host) og heartbeat-alder og kan bare
erstatte den når den beviselig ikke lever. `active`, `foreign_host`,
`unproven_identity` og `stale_no_heartbeat` erstattes ALDRI automatisk. Ukjent
identitet, uleselig claim eller enhver filsystemfeil er fail-closed. En uleselig
claim slettes aldri - etter et grace-vindu blir den bare forbigått, så korrupsjon
kan heller ikke låse workeren ute permanent. En pre-v3 vanlig låsefil respekteres
(vi nekter mens den ser levende ut) men skrives, flyttes eller slettes aldri.

Testharnessen ble også avvist med rette: veggklokke-barriere og telling av
`acquired=true` beviser ikke overlappende eierskap. `test/fixtures/lock-racer.mjs`
kjører nå en eksplisitt READY -> START -> ATTEMPT -> RELEASE-protokoll, og
`test/lock.test.mjs` dømmer ut fra INTERVALLER for den kritiske seksjonen: ingen
to intervaller får overlappe. Alle forventede barn må returnere en resultatfil og
avslutte med exit 0; ingenting filtreres bort.

En EKTE Windows-defekt i v3 ble funnet av nettopp denne harnessen og rettet før levering: libuv
åpner vanlige filer uten `FILE_SHARE_DELETE`, så et `rename` over en claim en annen prosess akkurat
leser feiler forbigående med `EPERM`/`EACCES`. Uten håndtering ga det (1) en heartbeat som ikke
landet, lest som «jeg har mistet låsen» - som ville avbrutt en frisk 50-minutters kjøring, og (2) en
claim som ikke kunne LESES, klassifisert som «uleselig» og dermed forbigåelig - altså kunne en
utfordrer forbigått en levende eier. Rettet med bundet retry + backoff på forbigående
filsystemfeil, og med et eget `unreadable`-verdikt som er FAIL-CLOSED: en claim vi ikke har SETT
blir aldri forbigått. Harnessen skiller nå `heartbeat_write_failures` fra faktisk tap av eierskap.

### Runde 4 (v2.3) - en tilbaketrukket claim kan ikke lenger maskere en levende forgjenger

Arkitektens review av `f839668` fant og reproduserte en gjenstående P1-feil i selve hovedboken.
`confirmOwnership()` re-probet generasjon N-1 riktig, men `retractOwnClaim()` skrev N som en
ORDINÆR `state: "released"`, og eierskap ble lest av RÅ maksimum. Da kunne en FEILET utfordrer gi
bort låsen: generasjon 1 lever, en foreldet reclaimer publiserer 2, bekreftelsen ser korrekt at 1
lever og trekker 2 tilbake - men en tredje anskaffer leser bare maksimum, ser en «released»
generasjon 2, konkluderer at låsen er fri, publiserer 3 og re-sjekker kun mot 2. Den levende
generasjon 1 mistet `holdsLock()`, og utfordreren gikk inn i den kritiske seksjonen.

Reprodusert lokalt på nøyaktig `f839668`-modulen og på den rettede modulen, fra samme driver:

```
f839668: firstAcquired=true secondAcquired=false generation2StateOnDisk=released
         thirdAcquired=true  firstStillOwnsLock=false thirdOwnsLock=true
v2.3:    firstAcquired=true secondAcquired=false generation2StateOnDisk=void
         thirdAcquired=false firstStillOwnsLock=true  thirdOwnsLock=false
```

Rettelsen er en tredje krav-tilstand, ikke en rekkefølgelapp. En claim er nå `held`, `released`
eller `void`:

- `released` betyr «denne claimen EIDE låsen og eieren ga slipp» - den avslutter avstamningen, for
  alt under den var allerede avgjort da eieren ble bekreftet;
- `void` betyr «denne claimen EIDE ALDRI noe» - den er TRANSPARENT, og oppslaget går videre NEDOVER
  forbi den til første krav som faktisk sier noe (det EFFEKTIVE kravet).

`acquireLock`, `holdsLock`, `heartbeat`, `releaseLock` og `readLockRaw` bruker det effektive
kravet; en ny generasjon appendes fortsatt over RÅ maksimum, så generasjonstelleren går aldri
bakover. `confirmOwnership()` re-klassifiserer den EFFEKTIVE forgjengeren (ikke blindt N-1) med
samme dom som før publisering, slik at også en uleselig eller ubevist forgjenger feiler lukket.
Kan avstamningen ikke bevises - et hull under et void-krav, eller en ren void-kjede som ikke når
generasjon 1 - nektes anskaffelsen; den leses ALDRI som «fri». En claim retrahert av en eldre bygg
(`released` + `release_reason: "retracted"`) leses som `void`.

I tillegg lukkes den gjenstående deployment-forpliktelsen: `install-task.ps1` og
`install-supervisor.ps1` skriver nå en DURABEL INTENSJON i install-manifestet FØR
noen registrering forsøkes, og AVBRYTER installasjonen hvis den ikke kan skrives.
Bekreftelsen skjer etterpå og har lov til å feile; `reconcile-task-intents` løser
et krasj-vindu fra vertens eget svar, og rollback avregistrerer også ubekreftede
intensjoner for oppgaver som ikke fantes fra før.

## Hva som faktisk garanteres

Worker (`worker.mjs`):

- **A.** Kladd havner utenfor repoet ved konstruksjon (`TEMP`/`TMP`/`TMPDIR`
  peker på `tmp/`), OG prompten oppgir den absolutte scratch-stien eksplisitt med
  kladdedisiplin — miljøvariabler alene stopper ikke en relativ filsti. Gamle
  etterlatenskaper flyttes til unik karantene FØR dirty-guarden, men bare hvis
  filnavnet treffer en fullt ankret allowlist, filen er en vanlig fil (aldri
  symlink/reparse point), innholdet faktisk er et protokolldokument, og `TASK_ID`
  er kjent for workeren. Bytes hashes før og etter. Ukjente og sporede filer røres
  aldri. Ingen `git clean/reset/stash`, ingen `.gitignore`.
- **B.** Timeout, exit≠0, spawn-feil eller manglende report gir ALDRI
  «processed». Fullført krever en matchende betrodd `CLAUDE_REPORT` for akkurat
  den `TASK_ID`-en, postet etter dispatch, med terminal `STATUS`. State skrives
  atomisk med en VERIFISERT backup; en korrupt primær overskriver aldri en god
  backup. Er både primær og backup ulesbar, nekter workeren å kjøre i stedet for
  å miste replay-beskyttelsen. Ekte førstegangskjøring rapporteres eksplisitt og
  kan aldri forveksles med tapt historikk.
- **C.** Låsen tas FØRST, og dekker state-lesing, preflight, karantene, dispatch
  og alle state-skriv. Levende eier avgjøres av prosessidentitet (pid + starttid
  + host) og heartbeat, ikke av alder. Eierskap er et token, ikke en pid. En
  aktiv, fremmed eller uverifiserbar lås ryddes aldri automatisk, publisering er
  link-atomisk, heartbeat er rename-atomisk, og en reclaim fjerner kun de
  nøyaktige bytene som ble klassifisert.
- **C2 (crash-recovery).** Under låsen, FØR noen kandidat velges, gjenopprettes
  hver task som en krasjet forelder etterlot `IN_PROGRESS`: et beviselig levende
  barn beskyttes (identitet, aldri pid alene, med etterkommere rapportert),
  en eksisterende betrodd report lukker tasken uten ny dispatch, og ellers går
  tasken tilbake til den vanlige retry-banen. Et uprøvbart pid blokkerer kun
  innenfor barnets eget levetidsbudsjett — pid-gjenbruk kan aldri stoppe loopen
  permanent.
- **D.** Bundet retry med eksponentiell backoff og et hardt tak. Gjentatt feil
  gir en deduplisert `CLAUDE_WORKER_STATUS` på kontroll-issuen (dedup i egen
  append-only journal, så den aldri trenger den eksklusive låsen). Exit-koden er
  aldri 0 når noe er blokkert.
- **E.** Bare allerede autoriserte tasks kjøres. Ingen oppfunnet neste arbeid.
- **F.** Egne health-hendelser per steg, så «scheduleren kjørte» aldri forveksles
  med «arbeidet ble fullført».
- **Fail-closed.** Et git-spørsmål som ikke kan besvares er UKJENT, aldri «rent».
  `origin` må peke på det konfigurerte repoet. `claudeArgs` er påkrevd og
  eksplisitt — det finnes ingen permissiv default, og et permission-bypass-flagg
  krever `acknowledgeDangerousClaudeArgs: true` i samme fil. Alle numeriske
  grenser er endelige og validerte, alle skrivestier må ligge utenfor repoet, og
  `TASK_ID` valideres som én trygg path-komponent før den brukes som katalognavn.

Supervisor (`supervisor.mjs`), autorisert av scope-oppdateringen på
WORKER-SELF-RECOVERY-20260907 — ÉN recovery-supervisor, aldri en andre
implementasjons-worker:

- observerer den eksisterende `JarvisClaudeWorker`-oppgaven og workerens egen
  health-journal/lås (kun lesing),
- poller SAMME betrodde issue for nøyaktig to kommandoer: `STATUS` og
  `RESTART_WORKER`, med ankret skjema, unik `COMMAND_ID`, host-/worker-binding,
  kort utløp, avvisning av redigerte og replayede kommentarer,
- validerer hver kommando I DET ØYEBLIKKET den utføres, mot fersk observasjon —
  to like `COMMAND_ID` i samme poll kan ikke begge kjøre,
- starter den eksisterende oppgaven når workeren beviselig er en død
  kø-konsument, innenfor et døgnbudsjett og med backoff — som gjelder KOMMANDERTE
  restarts på nøyaktig samme måte,
- bruker durable stadier (intent → effect → result → receipt): en krasj rundt
  starten rekonsilieres fra faktisk host-bevis (workerens egen health-journal),
  en kvittering som ikke ble postet forsøkes på nytt UTEN å gjenta effekten, og
  en forespørsel går aldri tapt,
- **utsetter, konsumerer ikke**: en `RESTART_WORKER` mot en travel worker bevares
  og revurderes hver poll til den trygt kan utføres eller utløper eksplisitt,
- **avbryter aldri levende arbeid** og **avslutter aldri en prosess**.

## Exit-koder (både worker og supervisor)

| Kode | Betydning |
|------|-----------|
| 0 | frisk: ledig kø, eller en task fullført med verifisert bevis |
| 3 | blokkert: trenger et menneske eller en ny TASK_ID — ikke «frisk» |
| 4 | forbigående: auth/nett/retry-bar feil, prøver igjen med backoff |
| 1 | fatal: config- eller parse-feil |

En Windows-oppgave i `Ready` med `LastTaskResult=0` betyr KUN at scheduleren
kjørte. Ekte køhelse: `node worker.mjs health`.

## Installasjon (transaksjonell: stage → verifiser → bytt → auto-rollback)

```powershell
cd <repo>\ops\claude-worker
.\verify-scripts.ps1              # alle .ps1 parser (ekte AST) og er ASCII; alle .mjs parser med node
.\install.ps1 -WhatIf             # full plan, endrer ingenting
.\install.ps1                     # stage + hash-verifiser + bytt
```

Motoren ligger i `lib/deploy.mjs`/`deploy.mjs` (Node, ikke PowerShell), nettopp
for at hele feilbanen kan kjøres med ekte filer og injiserte feil i CI. PowerShell
beholder kun det som virkelig krever det: registrering av oppgaver.

Garantier:

- alt stages og hash-verifiseres i `staging\<versjon>\` FØR noe levende røres;
- en levende worker- ELLER supervisor-lås gir UTSATT aktivering med en
  `pending-activation.json`-markør — ingenting overskrives, ingenting drepes.
  En installasjon startet av workeren selv kan derfor aldri overskrive sin egen
  forelder. **Markøren anvendes av den kontrollerte bootstrap-handoffen**
  (`deploy.mjs bootstrap-handoff`), som `install.ps1` starter fra KILDETREET i
  samme øyeblikk aktiveringen utsettes. Den venter på at den EKSAKTE legitime
  forelder-identiteten (pid + starttid + host) avslutter av seg selv, sjekker
  worker- og supervisor-quiescence på nytt, og aktiverer først da
  transaksjonelt. Den dreper ingenting og rører ingen scheduled task.
  `run-worker.ps1` sin `apply-pending` er et ANDRE nett som kun hjelper når den
  nye runneren allerede ER den installerte entrypointen: en installasjon startet
  av en GAMMEL deployert worker kan ikke regne med at neste scheduler-tikk
  anvender markøren, fordi det tikket kjører den gamle filen (D-126d, funn 3);
- hver fil skrives ved siden av målet og `rename`-es over — et entrypoint
  forsvinner aldri, ikke et øyeblikk;
- `run-worker-safe.ps1` fjernes KUN når ingen registrert oppgave refererer den,
  og aldri i det hele tatt hvis oppgavene ikke kunne spørres;
- enhver feil under byttet ruller automatisk tilbake til de registrerte gamle
  hashene og fjerner filer installasjonen innførte;
- `config.json`, `supervisor.config.json`, `state.json`, `logs/` og `tmp/` er
  aldri i payloaden og røres aldri.

Etter installasjon (registrerer ingenting av seg selv):

```powershell
copy config.example.json config.json                       # claudeArgs er PÅKREVD og eksplisitt
copy supervisor.config.example.json supervisor.config.json # sett host til EKSAKT hostname
node worker.mjs status
node worker.mjs run --dry-run     # kun lesing: tar ingen lås og skriver ingenting
node supervisor.mjs status
node supervisor.mjs run --dry-run
.\install-task.ps1                # worker-schedule (samme ene worker som før)
.\install-supervisor.ps1          # supervisor-schedule (startup + intervall)
```

`install-task.ps1`/`install-supervisor.ps1` gjenbruker hostens EKSISTERENDE
principal (UserId/LogonType/RunLevel) og faktiske shell — ingen stille
substitusjon til `powershell.exe`/S4U. De eksporterer eksisterende definisjon,
PRØVER registreringen under et midlertidig navn først (så et avslag aldri ødelegger
en fungerende oppgave), erstatter deretter med `Register-ScheduledTask -Force`
(aldri avregistrer-så-registrer), verifiserer resultatet og gjenoppretter backupen
hvis verifikasjonen feiler. Ingen rettigheter endres for å omgå et avslag.

Rollback:

```powershell
.\rollback.ps1 -WhatIf
.\rollback.ps1 -RestoreTasks
```

Rollback håndhever manifestets gamle SHA256, fjerner filer og oppgaver
installasjonen innførte, gjenoppretter filer den fjernet, og rører ingen
operasjonelle data.

En oppgave regnes som «innført» kun når den ikke fantes fra før:
`install-task.ps1` og `install-supervisor.ps1` kaller da
`node deploy.mjs record-introduced-task`, som skriver navnet inn i det siste
install-manifestet. Rollback avregistrerer nøyaktig de navnene og aldri en
oppgave installasjonen ikke opprettet.

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
eller nøkkel. `TARGET_HOST` må dessuten være maskinen supervisoren FAKTISK kjører
på — konfigurasjonen valideres mot `os.hostname()` ved oppstart. Supervisoren
tolker aldri fritekst, stier eller argumenter.

## Sikkerhet

Ingen token håndteres, leses eller logges her — all GitHub-tilgang går gjennom
`gh`, som eier sin egen lagrede auth. Alt som skrives til logg, manifest eller
en kommentar går gjennom `sanitize()`. Manifestet inneholder stier og hasher,
aldri filinnhold. Ingen tillits- eller godkjenningsgrense er svekket av denne
reparasjonen: merge-autoritet (D-120) er uendret, supervisoren kan ikke merge,
og ingen permission-bypass legges til implisitt noe sted.

## Tester

```bash
npx vitest run ops/claude-worker/test
```

304 tester (kjørt 2026-09-07 på denne branchen: 14 filer / 304 passed). I tillegg
til v2-dekningen (karantene inkludert den eksakte D125-filen, symlink, reparse
point, kollisjon, sporede filer; completion-bevis; backoff; status-dedup;
tillitsgrensen; hemmelighetsvask) dekker v2.1/v2.2:

- **ekte samtidighet med intervall-bevis**: åtte separate OS-prosesser med
  eksplisitt READY/START/ATTEMPT/RELEASE-koordinering (`test/fixtures/lock-racer.mjs`);
  gjensidig utelukkelse avgjøres av at ingen to kritiske seksjoner overlapper,
  ikke av en telling. Alle barn må levere resultatfil og avslutte med exit 0;
- **den bekreftede kildedefekten**: kontrollert stale-read -> erstatningseier ->
  forsinket reclaim -> utfordrer, deterministisk via `hooks.afterClassify`
  (nøyaktig punktet v2 var utrygt);
- **ekte crash-recovery mot det FAKTISKE entrypointet**: `node worker.mjs run`
  startes som prosess og drepes før spawn, under barnets kjøring og etter
  report men før completion-lagring (`test/worker-crash-recovery.test.mjs`);
- **feilinjeksjon i durabilitet**: korrupt primær + gyldig backup, avbrutt
  skriving, `null`/`[]`/`{}`-state;
- **installasjon/rollback som fixtures**: injisert feil i hvert steg av byttet,
  hash-håndhevet rollback, fjerning av innførte filer, bevaring av operasjonelle
  data, utsatt aktivering under levende lås;
- **supervisor-protokollen ende-til-ende**: to like `COMMAND_ID` i samme poll,
  budsjett for to unike restarts, krasj før/etter `Start-ScheduledTask`, feilet
  kvittering, og bevart utsettelse fra travel til ledig.

Ikke dekket av vitest og må kjøres på hosten: ekte PowerShell AST-parsing
(`verify-scripts.ps1`), ekte Task Scheduler-registrering, og ekte
reboot-persistens.

En ferdig CI-jobb som kjører den EKTE PowerShell-parseren og hele worker-suiten
på `windows-latest` ligger i `ci/worker-scripts-windows.job.yml`. Den kunne ikke
legges inn i `.github/workflows/ci.yml` herfra: GitHub-tokenet mangler
`workflow`-scope (`remote rejected ... without workflow scope`). Lim den inn rett
før `gitleaks:` med et token som har det scopet.
